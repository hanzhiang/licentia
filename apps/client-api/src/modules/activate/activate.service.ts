import { Inject, Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import {
  AppError,
  computeEntitlement,
  errDeviceLimit,
  errLicExpired,
  errLicNotFound,
  errLicRevoked,
  errLicSuspended,
  errProductMismatch,
  errVersionTooLow,
  type LicenseStatus,
} from '@lp/domain';
import { hmacCode, legacyNormalizeCode, normalizeCode } from '@lp/keygen';
import { LpDb, setBypassRls, setTenantGuc, uuidv7, withSystemTx } from '@lp/db';
import { emitOutbox } from '@lp/events';
import { generateClientToken, hashClientToken } from '@lp/auth';
import type { LicenseSigner } from '@lp/signer';
import { getConfig, type AppConfig } from '@lp/config';
import { DB } from '../../db.module';
import { SIGNER } from '../../signer.module';

export interface ActivateInput {
  code: string;
  app: { productCode: string; version: string };
  device: { fpType: string; fingerprint: string; platform: string; meta?: Record<string, unknown> };
  context?: { userId?: string };
}

export interface ActivateResult {
  client_token: string;
  expires_at: string | null;
  license: {
    id: string;
    kind: string;
    status: LicenseStatus;
    features: string[];
    device: { bound: number; limit: number };
    offline_window_days: number;
    heartbeat_hours: number;
  };
  offline_license: string | null;
  server_time: number;
  replayed: boolean;
}

/** 最低版本校验: 仅支持 ">=X.Y.Z" 形式, 无法解析时放行(骨架策略) */
export function satisfiesMinVersion(version: string, min: string | null): boolean {
  if (!min) return true;
  const m = min.match(/^>=\s*(\d+)\.(\d+)\.(\d+)$/);
  const v = version.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m || !v) return true;
  const [ma, mi, pa] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const [vb1, vb2, vb3] = [Number(v[1]), Number(v[2]), Number(v[3])];
  return (
    vb1 > ma || (vb1 === ma && vb2 > mi) || (vb1 === ma && vb2 === mi && vb3 >= pa)
  );
}

/**
 * 激活(设计文档 §4.2): 单事务完成 查码→切租户→行锁→设备绑定→名额校验→状态迁移→发 token→Outbox.
 * 并发正确性三重保证: SELECT FOR UPDATE(串行) + uq_act_license_device(幂等) + 状态守卫.
 */
@Injectable()
export class ActivateService {
  constructor(
    @Inject(DB) private readonly db: Kysely<LpDb>,
    @Inject(SIGNER) private readonly signer: LicenseSigner,
  ) {}

  async activate(input: ActivateInput): Promise<ActivateResult> {
    const cfg = getConfig() as AppConfig;
    // 新码走严格校验(Damm); 失败时按 legacy 归一化兜底(存量迁移, 设计文档 §7.3)
    let codeHmac: Buffer;
    let isLegacy = false;
    let strictError: AppError | null = null;
    try {
      const normalized = normalizeCode(input.code);
      codeHmac = hmacCode(cfg.CODE_HMAC_KEY, normalized);
    } catch (e) {
      if (e instanceof AppError && e.code === 'LIC_CODE_MALFORMED') {
        isLegacy = true;
        strictError = e;
        codeHmac = hmacCode(cfg.CODE_HMAC_KEY, legacyNormalizeCode(input.code));
      } else {
        throw e;
      }
    }
    const fpHash = hmacCode(
      cfg.FINGERPRINT_PEPPER,
      `${input.device.fpType}:${input.device.fingerprint}`,
    );

    return withSystemTx(this.db, async (tx) => {
      const found = await tx
        .selectFrom('licenses')
        .selectAll()
        .where('code_hmac', '=', codeHmac)
        .executeTakeFirst();
      if (!found) {
        // legacy 兜底也没查到: 该码既不是已迁移的旧码, 也不符合新码格式(否则不会走兜底),
        // 报格式错误而不是「不存在」, 避免把伪造码暴露成已知码空间的查询结果
        throw strictError ?? errLicNotFound();
      }

      // 查到码后立即切回租户上下文: 后续访问全部受 RLS 约束
      await setTenantGuc(tx, found.tenant_id);
      await setBypassRls(tx, false);

      const lic = await tx
        .selectFrom('licenses')
        .selectAll()
        .where('id', '=', found.id)
        .forUpdate()
        .executeTakeFirstOrThrow();

      const product = await tx
        .selectFrom('products')
        .selectAll()
        .where('id', '=', lic.product_id)
        .executeTakeFirstOrThrow();
      if (product.code !== input.app.productCode) throw errProductMismatch();
      if (!satisfiesMinVersion(input.app.version, lic.min_version)) throw errVersionTooLow();
      if (
        lic.status === 'issued' &&
        lic.activate_within_days > 0 &&
        Date.now() - lic.issued_at.getTime() > lic.activate_within_days * 86_400_000
      ) {
        throw errLicExpired();
      }

      const device = await tx
        .insertInto('devices')
        .values({
          id: uuidv7(),
          tenant_id: lic.tenant_id,
          product_id: lic.product_id,
          fp_type: input.device.fpType,
          fingerprint: fpHash,
          platform: input.device.platform,
          display_name: null,
          meta: input.device.meta ?? {},
          blocked: false,
          first_seen_at: new Date(),
          last_seen_at: new Date(),
        })
        .onConflict((oc) =>
          oc
            .columns(['tenant_id', 'product_id', 'fp_type', 'fingerprint'])
            .doUpdateSet({ last_seen_at: new Date() }),
        )
        .returningAll()
        .executeTakeFirstOrThrow();

      const countRow = await tx
        .selectFrom('license_activations')
        .select((eb) => eb.fn.countAll().as('cnt'))
        .where('license_id', '=', lic.id)
        .where('status', '=', 'active')
        .executeTakeFirstOrThrow();
      const bound = Number(countRow.cnt);

      let activationId: string;
      let firstActivation = false;
      const existingAct = await tx
        .selectFrom('license_activations')
        .selectAll()
        .where('license_id', '=', lic.id)
        .where('device_id', '=', device.id)
        .where('status', '=', 'active')
        .executeTakeFirst();

      if (existingAct) {
        // 同设备重复激活: 幂等, 不消耗名额
        activationId = existingAct.id;
      } else {
        if (lic.status === 'revoked') throw errLicRevoked();
        if (lic.status === 'suspended') throw errLicSuspended();
        if (lic.status === 'expired') throw errLicExpired();
        if (lic.expires_at !== null && lic.expires_at.getTime() <= Date.now()) {
          throw errLicExpired();
        }
        if (bound >= lic.device_limit) throw errDeviceLimit();

        const act = await tx
          .insertInto('license_activations')
          .values({
            id: uuidv7(),
            tenant_id: lic.tenant_id,
            license_id: lic.id,
            device_id: device.id,
            end_customer_id: null,
            status: 'active',
            activated_at: new Date(),
            released_at: null,
            released_by: null,
            released_reason: null,
            last_seen_at: new Date(),
            client_meta: input.device.meta ?? {},
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        activationId = act.id;
        firstActivation = true;
      }

      if (firstActivation && lic.status === 'issued') {
        await tx
          .updateTable('licenses')
          .set({
            status: 'activated',
            activated_at: new Date(),
            expires_at:
              lic.duration_days === null
                ? null
                : sql`coalesce(expires_at, now() + make_interval(days => ${lic.duration_days}))`,
            version: lic.version + 1,
            updated_at: new Date(),
          })
          .where('id', '=', lic.id)
          .execute();
      }

      const token = generateClientToken();
      await tx
        .insertInto('client_tokens')
        .values({
          token_hash: hashClientToken(token),
          activation_id: activationId,
          license_id: lic.id,
          tenant_id: lic.tenant_id,
          expires_at: new Date(Date.now() + cfg.CLIENT_TOKEN_TTL_HOURS * 3_600_000),
          created_at: new Date(),
        })
        .execute();

      await emitOutbox(
        tx,
        firstActivation ? 'license.activated' : 'license.activation_replayed',
        lic.tenant_id,
        'license',
        lic.id,
        { license_id: lic.id, device_id: device.id, activation_id: activationId, legacy: isLegacy },
      );

      const offline =
        lic.offline_window_days > 0
          ? await this.signer.issueOfflineLicense({
              licenseId: lic.id,
              tenantId: lic.tenant_id,
              productCode: product.code,
              features: lic.features,
              offlineWindowDays: lic.offline_window_days,
              deviceHash: fpHash,
              seatLimit: lic.seat_limit,
              concurrencyLimit: lic.concurrency_limit,
            })
          : null;

      const expiresAt =
        lic.duration_days === null
          ? null
          : (lic.expires_at ?? new Date(Date.now() + lic.duration_days * 86_400_000));

      return {
        client_token: token,
        expires_at: expiresAt ? expiresAt.toISOString() : null,
        license: {
          id: lic.id,
          kind: lic.kind,
          status: lic.status === 'issued' ? 'activated' : lic.status,
          features: lic.features,
          device: { bound: bound + (firstActivation ? 1 : 0), limit: lic.device_limit },
          offline_window_days: lic.offline_window_days,
          heartbeat_hours: lic.heartbeat_hours,
        },
        offline_license: offline,
        server_time: Math.floor(Date.now() / 1000),
        replayed: !firstActivation,
      };
    });
  }
}

/** 心跳/校验路径共用: domain 权益判定结果 → 语义化 AppError */
export function entitlementErrorOrThrow(
  lic: { status: LicenseStatus; expires_at: Date | null },
): void {
  const ent = computeEntitlement({ status: lic.status, expiresAt: lic.expires_at });
  if (ent.valid) return;
  switch (ent.reason) {
    case 'LIC_REVOKED':
      throw errLicRevoked();
    case 'LIC_SUSPENDED':
      throw errLicSuspended();
    case 'LIC_EXPIRED':
      throw errLicExpired();
    case 'LIC_STATUS_INVALID':
      throw new AppError('LIC_STATUS_INVALID');
  }
}
