/// <reference types="vitest" />
/**
 * 存量迁移工具测试: fixture SQLite → dry-run → 导入 → 幂等 → legacy 码可在新 API 激活.
 * 前置: TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Kysely } from 'kysely';
import { createDb, withSystemTx, type LpDb } from '@lp/db';
import { migrateLegacy } from './migrate';
import { ActivateService } from '../../../apps/client-api/src/modules/activate/activate.service';
import { LicenseSigner, LocalSignerProvider } from '@lp/signer';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

const TENANT = '99999999-9999-4999-8999-999999999999';

d.sequential('legacy migration tool', () => {
  let db: Kysely<LpDb>;
  let sqlitePath: string;
  let activate: ActivateService;

  beforeAll(() => {
    db = createDb(url!, { max: 10 });
    const signer = new LicenseSigner(new LocalSignerProvider('e2e-kid', 'e2e-seed'));
    activate = new ActivateService(db, signer);

    // fixture: legacy SQLite
    sqlitePath = path.join(os.tmpdir(), `lp-legacy-${Date.now()}.db`);
    const s = new Database(sqlitePath);
    s.exec(`
      create table apps (app_id text primary key, name text);
      create table codes (id integer primary key, code text unique, app_id text,
        status text, device_limit integer, expires_at text, created_at text);
      create table devices (id integer primary key, code_id integer, device_id text,
        platform text, activated_at text, last_seen text);
    `);
    s.prepare('insert into apps values (?, ?)').run('dorm-check', '宿舍查寝(旧版)');
    const codes: Array<[number, string, string, string, number, string | null, string]> = [
      [1, 'LEGACY-AAAA-1111', 'dorm-check', 'active', 2, '2027-12-31', '2026-01-01'],
      [2, 'LEGACY-AAAA-2222', 'dorm-check', 'active', 1, null, '2026-02-01'],
      [3, 'LEGACY-AAAA-3333', 'dorm-check', 'revoked', 1, null, '2026-03-01'],
      [4, 'LEGACY-AAAA-4444', 'dorm-check', 'expired', 1, '2026-01-15', '2025-12-01'],
      [5, 'LEGACY-AAAA-5555', 'dorm-check', 'unused', 1, null, '2026-04-01'],
      [6, 'BAD', 'dorm-check', 'active', 1, null, '2026-04-01'], // 码过短 → 跳过
    ];
    for (const c of codes) {
      s.prepare(
        'insert into codes values (?, ?, ?, ?, ?, ?, ?)',
      ).run(...c);
    }
    s.prepare('insert into devices values (?, ?, ?, ?, ?, ?)').run(
      1, 1, 'legacy-dev-001', 'windows', '2026-01-05', '2026-06-01',
    );
    s.close();
  });

  afterAll(async () => {
    await withSystemTx(db, async (tx) => {
      // 父表(无 tenant_id 的关联表)按 product_id 定位, 其余只删本租户, 避免波及种子数据
      const productIds = tx
        .selectFrom('products')
        .select('id')
        .where('tenant_id', '=', TENANT);
      await tx.deleteFrom('product_features').where('product_id', 'in', productIds).execute();
      await tx.deleteFrom('product_versions').where('product_id', 'in', productIds).execute();
      for (const t of [
        'client_tokens','notifications_outbox','renewals','events',
        'idempotency_keys','license_activations','devices','licenses','license_batches',
        'policies','products','end_customers',
      ] as const) {
        await tx.deleteFrom(t).where('tenant_id', '=', TENANT).execute();
      }
      await tx.deleteFrom('tenants').where('id', '=', TENANT).execute();
    });
    fs.rmSync(sqlitePath, { force: true });
    await db.destroy();
  });

  it('dry-run reports counts without writing', async () => {
    const report = await migrateLegacy({ sqlitePath, dryRun: true, db });
    expect(report.apps).toBe(1);
    expect(report.codesTotal).toBe(6);
    expect(report.skipped.some((s) => s.code === 'BAD')).toBe(true);
    const count = await withSystemTx(db, (tx) =>
      tx
        .selectFrom('licenses')
        .select((eb) => eb.fn.countAll().as('c'))
        .where('tenant_id', '=', TENANT)
        .executeTakeFirstOrThrow(),
    );
    expect(Number(count.c)).toBe(0);
  });

  it('imports codes/devices; rerun is idempotent; legacy code activates via new API', async () => {
    const report = await migrateLegacy({ sqlitePath, db });
    expect(report.imported).toEqual({ issued: 1, activated: 2, revoked: 1, expired: 1 });
    expect(report.devicesImported).toBe(1);

    const rerun = await migrateLegacy({ sqlitePath, db });
    expect(
      rerun.imported.issued + rerun.imported.activated + rerun.imported.revoked + rerun.imported.expired,
    ).toBe(0);

    // legacy 设备已随迁移导入并激活
    const devices = await withSystemTx(db, (tx) =>
      tx
        .selectFrom('devices')
        .innerJoin('license_activations', 'license_activations.device_id', 'devices.id')
        .select((eb) => eb.fn.countAll().as('c'))
        .where('devices.meta', '=', { legacy: true })
        .executeTakeFirstOrThrow(),
    );
    expect(Number(devices.c)).toBe(1);

    // legacy 码(无 Damm 校验位)通过新 API 的 legacy 兜底激活到新设备
    const act = await activate.activate({
      code: 'LEGACY-AAAA-2222',
      app: { productCode: 'dorm-check', version: '1.0.0' },
      device: { fpType: 'machine_id', fingerprint: 'legacy-new-dev-1', platform: 'windows' },
    });
    expect(act.license.status).toBe('activated');
    // 新格式码仍走严格校验
    await expect(
      activate.activate({
        code: 'TOTALLY-INVALID',
        app: { productCode: 'dorm-check', version: '1.0.0' },
        device: { fpType: 'machine_id', fingerprint: 'legacy-new-dev-2', platform: 'windows' },
      }),
    ).rejects.toMatchObject({ code: 'LIC_CODE_MALFORMED' });
  });
});
