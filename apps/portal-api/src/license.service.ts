import { Inject, Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import {
  AppError,
  errLicExpired,
  errLicNotFound,
  errLicRevoked,
  errLicSuspended,
  errStatusInvalid,
} from '@lp/domain';
import { hmacCode, maskCode, normalizeCode } from '@lp/keygen';
import {
  LpDb,
  LpTx,
  setBypassRls,
  setTenantGuc,
  uuidv7,
  withSystemTx,
  withTenantTx,
} from '@lp/db';
import { emitOutbox } from '@lp/events';
import { writeAudit } from '@lp/audit';
import { getConfig } from '@lp/config';
import { DB } from './db.module';

export interface OrgLicenseView {
  license_id: string;
  code_masked: string;
  kind: string;
  status: string;
  org_name: string;
  features: string[];
  expires_at: string | null;
  device_limit: number;
  seat_limit: number | null;
  replayed: boolean;
}

const SYSTEM_USER = '00000000-0000-0000-0000-000000000000';

/**
 * 自助门户-组织许可(设计文档 场景2/3):
 *  - 学校管理员 OTP 登录后输入授权码 → 激活为组织级许可(全体师生共享席位)
 *  - 同组织重复提交幂等; 他组织已激活 → 409; 已作为个人许可(设备)激活 → 409
 *  - 自助解绑: 每码每月 1 次(以审计记录为配额账本), 解绑即时踢 token
 */
@Injectable()
export class PortalLicenseService {
  constructor(@Inject(DB) private readonly db: Kysely<LpDb>) {}

  async activateOrg(
    tenantId: string,
    phoneHash: Buffer,
    code: string,
    orgName: string,
  ): Promise<OrgLicenseView> {
    const normalized = normalizeCode(code);
    const codeHmac = hmacCode(getConfig().CODE_HMAC_KEY, normalized);

    return withSystemTx(this.db, async (tx) => {
      const found = await tx
        .selectFrom('licenses')
        .selectAll()
        .where('code_hmac', '=', codeHmac)
        .executeTakeFirst();
      if (!found) throw errLicNotFound();
      // 查到码后切回租户上下文(同事务), 后续访问受 RLS 约束
      await setTenantGuc(tx, found.tenant_id);
      await setBypassRls(tx, false);

      const lic = await tx
        .selectFrom('licenses')
        .selectAll()
        .where('id', '=', found.id)
        .forUpdate()
        .executeTakeFirstOrThrow();

      if (lic.status === 'activated' && lic.end_customer_id !== null) {
        const org = await tx
          .selectFrom('end_customers')
          .selectAll()
          .where('id', '=', lic.end_customer_id)
          .executeTakeFirst();
        if (org && org.contact_phone_hash?.equals(phoneHash)) {
          return this.toView(lic, org.name, true); // 幂等重放
        }
        throw errStatusInvalid('该授权码已被其他组织激活');
      }
      if (lic.status === 'revoked') throw errLicRevoked();
      if (lic.status === 'suspended') throw errLicSuspended();
      if (lic.status === 'expired') throw errLicExpired();
      if (lic.expires_at !== null && lic.expires_at.getTime() <= Date.now()) throw errLicExpired();

      const deviceBound = await tx
        .selectFrom('license_activations')
        .select((eb) => eb.fn.countAll().as('cnt'))
        .where('license_id', '=', lic.id)
        .where('status', '=', 'active')
        .where('device_id', 'is not', null)
        .executeTakeFirstOrThrow();
      if (Number(deviceBound.cnt) > 0) {
        throw errStatusInvalid('该授权码已作为个人许可(设备)激活');
      }

      const org = await tx
        .insertInto('end_customers')
        .values({
          id: uuidv7(),
          tenant_id: tenantId,
          name: orgName,
          type: 'org',
          contact_phone_hash: phoneHash,
          contact_email_enc: null,
          status: 'active',
          created_at: new Date(),
          deleted_at: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await tx
        .insertInto('license_activations')
        .values({
          id: uuidv7(),
          tenant_id: tenantId,
          license_id: lic.id,
          device_id: null,
          end_customer_id: org.id,
          status: 'active',
          activated_at: new Date(),
          released_at: null,
          released_by: null,
          released_reason: null,
          last_seen_at: null,
          client_meta: {},
        })
        .execute();

      await tx
        .updateTable('licenses')
        .set({
          status: 'activated',
          activated_at: new Date(),
          end_customer_id: org.id,
          expires_at:
            lic.duration_days === null
              ? null
              : sql`coalesce(expires_at, now() + make_interval(days => ${lic.duration_days}))`,
          version: lic.version + 1,
          updated_at: new Date(),
        })
        .where('id', '=', lic.id)
        .execute();

      await emitOutbox(tx, 'license.activated', tenantId, 'license', lic.id, {
        license_id: lic.id,
        org: true,
        end_customer_id: org.id,
      });
      await writeAudit(tx, {
        tenantId,
        actorType: 'end_customer',
        actorId: phoneHash.toString('base64url'),
        action: 'license.activate_org',
        resourceType: 'license',
        resourceId: lic.id,
        detail: { org_name: orgName, code_masked: maskCode(normalized) },
      });

      return this.toView(
        { ...lic, status: 'activated' as const },
        orgName,
        false,
      );
    });
  }

  async myLicenses(tenantId: string, phoneHash: Buffer): Promise<OrgLicenseView[]> {
    return withTenantTx(this.db, tenantId, async (tx) => {
      const orgs = await tx
        .selectFrom('end_customers')
        .select(['id', 'name'])
        .where('contact_phone_hash', '=', phoneHash)
        .where('deleted_at', 'is', null)
        .execute();
      if (orgs.length === 0) return [];
      const rows = await tx
        .selectFrom('licenses')
        .selectAll()
        .where(
          'end_customer_id',
          'in',
          orgs.map((o) => o.id),
        )
        .orderBy('activated_at', 'desc')
        .limit(100)
        .execute();
      const nameById = new Map(orgs.map((o) => [o.id, o.name]));
      return rows.map((r) => this.toView(r, nameById.get(r.end_customer_id ?? '') ?? '-', false));
    });
  }

  async licenseDevices(
    tenantId: string,
    phoneHash: Buffer,
    licenseId: string,
  ): Promise<Array<{ activation_id: string; platform: string; activated_at: string; last_seen_at: string | null }>> {
    return withTenantTx(this.db, tenantId, async (tx) => {
      await this.assertOwnsLicense(tx, phoneHash, licenseId);
      const rows = await tx
        .selectFrom('license_activations')
        .innerJoin('devices', 'devices.id', 'license_activations.device_id')
        .select([
          'license_activations.id as act_id',
          'license_activations.activated_at',
          'license_activations.last_seen_at',
          'devices.platform',
        ])
        .where('license_activations.license_id', '=', licenseId)
        .where('license_activations.status', '=', 'active')
        .where('license_activations.device_id', 'is not', null)
        .limit(200)
        .execute();
      return rows.map((r) => ({
        activation_id: r.act_id,
        platform: r.platform,
        activated_at: r.activated_at.toISOString(),
        last_seen_at: r.last_seen_at?.toISOString() ?? null,
      }));
    });
  }

  async releaseDevice(
    tenantId: string,
    phoneHash: Buffer,
    activationId: string,
    reason: string,
  ): Promise<{ released: boolean }> {
    const cfg = getConfig();
    return withTenantTx(this.db, tenantId, async (tx) => {
      const act = await tx
        .selectFrom('license_activations')
        .selectAll()
        .where('id', '=', activationId)
        .forUpdate()
        .executeTakeFirst();
      if (!act || act.device_id === null) throw errLicNotFound();
      await this.assertOwnsLicense(tx, phoneHash, act.license_id);

      // 自助配额: 每码每月 N 次(默认 1), 以审计记录为账本(§12 换机规则)
      const monthStart = new Date();
      monthStart.setUTCDate(1);
      monthStart.setUTCHours(0, 0, 0, 0);
      const used = await tx
        .selectFrom('audit_events')
        .select((eb) => eb.fn.countAll().as('cnt'))
        .where('action', '=', 'device.release')
        .where('actor_id', '=', phoneHash.toString('base64url'))
        .where('resource_id', '=', act.license_id)
        .where('occurred_at', '>=', monthStart)
        .executeTakeFirstOrThrow();
      if (Number(used.cnt) >= cfg.PORTAL_SELF_RELEASE_MONTHLY) {
        throw new AppError(
          'RELEASE_QUOTA_EXCEEDED',
          `本月自助换机次数已用完(${cfg.PORTAL_SELF_RELEASE_MONTHLY} 次/月), 请联系客服`,
        );
      }

      if (act.status === 'active') {
        await tx
          .updateTable('license_activations')
          .set({
            status: 'released',
            released_at: new Date(),
            released_by: null,
            released_reason: `self-service: ${reason}`,
          })
          .where('id', '=', act.id)
          .execute();
        await tx.deleteFrom('client_tokens').where('activation_id', '=', act.id).execute();
        await emitOutbox(tx, 'license.device_unbound', tenantId, 'license', act.license_id, {
          license_id: act.license_id,
          activation_id: act.id,
          device_id: act.device_id,
          reason: 'self-service',
        });
        await writeAudit(tx, {
          tenantId,
          actorType: 'end_customer',
          actorId: phoneHash.toString('base64url'),
          action: 'device.release',
          resourceType: 'license',
          resourceId: act.license_id,
          detail: { activation_id: act.id, reason, self_service: true },
        });
      }
      return { released: true };
    });
  }

  private async assertOwnsLicense(
    tx: LpTx,
    phoneHash: Buffer,
    licenseId: string,
  ): Promise<string> {
    const lic = await tx
      .selectFrom('licenses')
      .select(['id', 'end_customer_id'])
      .where('id', '=', licenseId)
      .executeTakeFirst();
    if (!lic?.end_customer_id) throw errLicNotFound();
    const org = await tx
      .selectFrom('end_customers')
      .select(['id', 'contact_phone_hash'])
      .where('id', '=', lic.end_customer_id)
      .executeTakeFirst();
    if (!org?.contact_phone_hash?.equals(phoneHash)) {
      // 横向越权: 他人组织的许可一律 404, 不泄漏存在性
      throw errLicNotFound();
    }
    return lic.id;
  }

  private toView(
    lic: { id: string; code: string; kind: string; status: string; features: string[]; expires_at: Date | null; device_limit: number; seat_limit: number | null },
    orgName: string,
    replayed: boolean,
  ): OrgLicenseView {
    return {
      license_id: lic.id,
      code_masked: maskCode(lic.code.replace(/-/g, '')),
      kind: lic.kind,
      status: lic.status,
      org_name: orgName,
      features: lic.features,
      expires_at: lic.expires_at?.toISOString() ?? null,
      device_limit: lic.device_limit,
      seat_limit: lic.seat_limit,
      replayed,
    };
  }
}
