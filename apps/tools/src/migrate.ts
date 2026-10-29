import Database from 'better-sqlite3';
import { Kysely } from 'kysely';
import { encryptAead, hmacCode, legacyNormalizeCode } from '@lp/keygen';
import { LpDb, uuidv7, withSystemTx } from '@lp/db';
import { getConfig } from '@lp/config';

/**
 * 存量轻量服务 → 平台迁移工具(设计文档 §7.3).
 *
 * 假设的 legacy SQLite schema(与旧单机服务一致, 字段缺失时报 warning 跳过):
 *   apps(app_id TEXT PK, name TEXT)
 *   codes(id INTEGER PK, code TEXT UNIQUE, app_id TEXT,
 *         status TEXT in (unused|active|revoked|expired),
 *         device_limit INTEGER, expires_at TEXT NULL, created_at TEXT)
 *   devices(id INTEGER PK, code_id INTEGER, device_id TEXT,
 *           platform TEXT NULL, activated_at TEXT NULL, last_seen TEXT NULL)
 *
 * 行为:
 *  - dry-run: 只统计与校验, 不写库
 *  - 幂等: 以 code_hmac 去重, 重复执行 0 新增
 *  - legacy 码不走新码 Damm 校验, 归一化 = 大写去符号;
 *    client-api activate 对新格式校验失败时按 legacy 归一化兜底查找
 *  - 状态映射: unused→issued, active→activated(+设备/激活记录), revoked/expired→同名
 */
export interface LegacyReport {
  dryRun: boolean;
  tenantCode: string;
  apps: number;
  codesTotal: number;
  imported: { issued: number; activated: number; revoked: number; expired: number };
  devicesImported: number;
  skipped: Array<{ code: string; reason: string }>;
}

export interface MigrateOptions {
  sqlitePath: string;
  tenantCode?: string;
  dryRun?: boolean;
  db: Kysely<LpDb>;
}

const LEGACY_TENANT_ID = '99999999-9999-4999-8999-999999999999';
const SYSTEM_USER = '00000000-0000-0000-0000-000000000000';

export { legacyNormalizeCode };

interface LegacyCodeRow {
  id: number;
  code: string;
  app_id: string;
  status: string;
  device_limit: number | null;
  expires_at: string | null;
  created_at: string | null;
}

interface LegacyDeviceRow {
  id: number;
  code_id: number;
  device_id: string;
  platform: string | null;
  activated_at: string | null;
  last_seen: string | null;
}

export async function migrateLegacy(opts: MigrateOptions): Promise<LegacyReport> {
  const cfg = getConfig();
  const tenantCode = opts.tenantCode ?? 'legacy';
  const sqlite = new Database(opts.sqlitePath, { readonly: !!opts.dryRun });
  const report: LegacyReport = {
    dryRun: !!opts.dryRun,
    tenantCode,
    apps: 0,
    codesTotal: 0,
    imported: { issued: 0, activated: 0, revoked: 0, expired: 0 },
    devicesImported: 0,
    skipped: [],
  };

  try {
    const apps = sqlite.prepare('SELECT app_id, name FROM apps').all() as Array<{
      app_id: string;
      name: string;
    }>;
    const codes = sqlite
      .prepare('SELECT id, code, app_id, status, device_limit, expires_at, created_at FROM codes')
      .all() as LegacyCodeRow[];
    const devices = sqlite
      .prepare('SELECT id, code_id, device_id, platform, activated_at, last_seen FROM devices')
      .all() as LegacyDeviceRow[];
    report.apps = apps.length;
    report.codesTotal = codes.length;

    const codeIdToCode = new Map(codes.map((c) => [c.id, c]));
    const statusMap: Record<string, 'issued' | 'activated' | 'revoked' | 'expired'> = {
      unused: 'issued',
      active: 'activated',
      revoked: 'revoked',
      expired: 'expired',
    };

    if (opts.dryRun) {
      for (const c of codes) {
        if (!statusMap[c.status]) {
          report.skipped.push({ code: c.code, reason: `未知状态 ${c.status}` });
        } else if (!apps.some((a) => a.app_id === c.app_id)) {
          report.skipped.push({ code: c.code, reason: `悬空 app_id ${c.app_id}` });
        } else if (legacyNormalizeCode(c.code).length < 8) {
          report.skipped.push({ code: c.code, reason: '码过短' });
        }
      }
      return report;
    }

    await withSystemTx(opts.db, async (tx) => {
      // 1. 租户
      await tx
        .insertInto('tenants')
        .values({
          id: LEGACY_TENANT_ID,
          code: tenantCode,
          name: '存量迁移租户',
          status: 'active',
          plan: 'standard',
          locale: 'zh-CN',
          settings: {},
          created_at: new Date(),
          updated_at: new Date(),
          deleted_at: null,
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();

      // 2. 产品(按 app_id 映射, 冲突取回真实 id)
      //    code 保留原 app_id: 客户端激活时会带上 product_code 做比对, 归一化会破坏这一对应关系
      const productIds = new Map<string, string>();
      for (const app of apps) {
        const productCode = app.app_id.slice(0, 64);
        await tx
          .insertInto('products')
          .values({
            id: uuidv7(),
            tenant_id: LEGACY_TENANT_ID,
            code: productCode,
            name: app.name || app.app_id,
            status: 'active',
            created_at: new Date(),
            updated_at: new Date(),
            deleted_at: null,
          })
          .onConflict((oc) => oc.columns(['tenant_id', 'code']).doNothing())
          .execute();
        const row = await tx
          .selectFrom('products')
          .select('id')
          .where('tenant_id', '=', LEGACY_TENANT_ID)
          .where('code', '=', productCode)
          .executeTakeFirstOrThrow();
        productIds.set(app.app_id, row.id);
      }

      // 3. 每产品一把 legacy 策略(先建, licenses 外键依赖它)
      const policyIds = new Map<string, string>();
      for (const productId of productIds.values()) {
        await tx
          .insertInto('policies')
          .values({
            id: uuidv7(),
            tenant_id: LEGACY_TENANT_ID,
            product_id: productId,
            code: `legacy-${productId.slice(0, 8)}`,
            name: '存量迁移策略',
            kind: 'standard',
            duration_days: null,
            device_limit: 5,
            seat_limit: null,
            concurrency_limit: null,
            features: JSON.stringify(['legacy']) as unknown as string[],
            offline_window_days: 7,
            heartbeat_hours: 24,
            grace_hours: 72,
            activate_within_days: 0,
            allow_renewal: true,
            renew_window_days: 90,
            min_version: null,
            status: 'disabled',
            created_by: SYSTEM_USER,
            created_at: new Date(),
            updated_at: new Date(),
          })
          .onConflict((oc) => oc.columns(['tenant_id', 'code']).doNothing())
          .execute();
        const row = await tx
          .selectFrom('policies')
          .select('id')
          .where('product_id', '=', productId)
          .where('tenant_id', '=', LEGACY_TENANT_ID)
          .executeTakeFirstOrThrow();
        policyIds.set(productId, row.id);
      }

      // 4. 授权码(hmac = 归一化原文, 明文 AES 加密留存)
      for (const c of codes) {
        const status = statusMap[c.status];
        if (!status) {
          report.skipped.push({ code: c.code, reason: `未知状态 ${c.status}` });
          continue;
        }
        const productId = productIds.get(c.app_id);
        if (!productId) {
          report.skipped.push({ code: c.code, reason: `悬空 app_id ${c.app_id}` });
          continue;
        }
        const normalized = legacyNormalizeCode(c.code);
        if (normalized.length < 8) {
          report.skipped.push({ code: c.code, reason: '码过短' });
          continue;
        }
        const codeHmac = hmacCode(cfg.CODE_HMAC_KEY, normalized);
        const exists = await tx
          .selectFrom('licenses')
          .select('id')
          .where('code_hmac', '=', codeHmac)
          .executeTakeFirst();
        if (exists) continue; // 幂等

        const expiresAt = c.expires_at ? new Date(c.expires_at) : null;
        await tx
          .insertInto('licenses')
          .values({
            id: uuidv7(),
            tenant_id: LEGACY_TENANT_ID,
            product_id: productId,
            policy_id: policyIds.get(productId)!,
            batch_id: null,
            channel_id: null,
            end_customer_id: null,
            code: c.code,
            code_hmac: codeHmac,
            code_cipher: encryptAead(cfg.CODE_ENC_KEY, c.code),
            kind: 'standard',
            status,
            device_limit: Math.max(1, c.device_limit ?? 1),
            seat_limit: null,
            concurrency_limit: null,
            features: JSON.stringify(['legacy']) as unknown as string[],
            offline_window_days: 7,
            heartbeat_hours: 24,
            grace_hours: 72,
            activate_within_days: 0,
            renew_window_days: 90,
            allow_renewal: true,
            min_version: null,
            duration_days: null,
            issued_at: c.created_at ? new Date(c.created_at) : new Date(),
            activated_at:
              status === 'activated' ? (c.created_at ? new Date(c.created_at) : new Date()) : null,
            expires_at: expiresAt && !Number.isNaN(expiresAt.getTime()) ? expiresAt : null,
            suspended_at: null,
            revoked_at: status === 'revoked' ? new Date() : null,
            revoked_reason: status === 'revoked' ? 'legacy import' : null,
            version: 1,
            created_by: SYSTEM_USER,
            created_at: new Date(),
            updated_at: new Date(),
          })
          .onConflict((oc) => oc.column('code_hmac').doNothing())
          .execute();
        report.imported[status] += 1;
      }

      // 5. 设备与激活(仅 active 码)
      for (const d of devices) {
        const c = codeIdToCode.get(d.code_id);
        if (!c || statusMap[c.status] !== 'activated') continue;
        const lic = await tx
          .selectFrom('licenses')
          .select(['id', 'tenant_id', 'product_id'])
          .where(
            'code_hmac',
            '=',
            hmacCode(cfg.CODE_HMAC_KEY, legacyNormalizeCode(c.code)),
          )
          .executeTakeFirst();
        if (!lic) continue;
        const fpHash = hmacCode(cfg.FINGERPRINT_PEPPER, `machine_id:${d.device_id}`);
        const device = await tx
          .insertInto('devices')
          .values({
            id: uuidv7(),
            tenant_id: lic.tenant_id,
            product_id: lic.product_id,
            fp_type: 'machine_id',
            fingerprint: fpHash,
            platform: (d.platform as 'windows') ?? 'windows',
            display_name: null,
            meta: { legacy: true },
            blocked: false,
            first_seen_at: d.activated_at ? new Date(d.activated_at) : new Date(),
            last_seen_at: d.last_seen ? new Date(d.last_seen) : null,
          })
          .onConflict((oc) =>
            oc
              .columns(['tenant_id', 'product_id', 'fp_type', 'fingerprint'])
              .doUpdateSet({ last_seen_at: d.last_seen ? new Date(d.last_seen) : null }),
          )
          .returningAll()
          .executeTakeFirstOrThrow();
        const dupAct = await tx
          .selectFrom('license_activations')
          .select('id')
          .where('license_id', '=', lic.id)
          .where('device_id', '=', device.id)
          .where('status', '=', 'active')
          .executeTakeFirst();
        if (dupAct) continue;
        await tx
          .insertInto('license_activations')
          .values({
            id: uuidv7(),
            tenant_id: lic.tenant_id,
            license_id: lic.id,
            device_id: device.id,
            end_customer_id: null,
            status: 'active',
            activated_at: d.activated_at ? new Date(d.activated_at) : new Date(),
            released_at: null,
            released_by: null,
            released_reason: null,
            last_seen_at: d.last_seen ? new Date(d.last_seen) : null,
            client_meta: { legacy: true },
          })
          .execute();
        report.devicesImported += 1;
      }
    });

    return report;
  } finally {
    sqlite.close();
  }
}
