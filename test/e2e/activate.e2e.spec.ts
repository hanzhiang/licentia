/// <reference types="vitest" />
/**
 * 激活并发正确性 e2e(设计文档 §5.2 三重保证).
 * 前置: docker compose up + pnpm db:migrate, 并设置 TEST_DATABASE_URL(用 lp_app 角色, RLS 恒生效).
 *   TEST_DATABASE_URL=postgresql://lp_app:lp@localhost:5432/lp pnpm vitest run test/e2e
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely } from 'kysely';
import { AppError } from '@lp/domain';
import { createDb, withSystemTx, type LpDb } from '@lp/db';
import { getConfig } from '@lp/config';
import { LicenseSigner, LocalSignerProvider } from '@lp/signer';
import { ActivateService } from '../../apps/client-api/src/modules/activate/activate.service';
import { HeartbeatService } from '../../apps/client-api/src/modules/heartbeat/heartbeat.service';
import { BatchService } from '../../apps/admin-api/src/modules/batch/batch.service';
import { LicenseService } from '../../apps/admin-api/src/modules/license/license.service';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

const TENANT = '11111111-1111-4111-8111-111111111111';
const PRODUCT = '22222222-2222-4222-8222-222222222222';
const POLICY = '33333333-3333-4333-8333-333333333333';
const CHANNEL = '44444444-4444-4444-8444-444444444444';

d.sequential('activation e2e (requires TEST_DATABASE_URL)', () => {
  let db: Kysely<LpDb>;
  let activate: ActivateService;
  let heartbeat: HeartbeatService;
  let batch: BatchService;
  let licenses: LicenseService;

  // 稳定指纹: 每个用例开头 reset() 清空 devices, 编号固定即可保证"同设备"语义
  const dev = (n: number) => ({
    fpType: 'machine_id' as const,
    fingerprint: `e2e-fp-${n}`,
    platform: 'windows' as const,
  });

  beforeAll(() => {
    db = createDb(url!, { max: 20 });
    const signer = new LicenseSigner(new LocalSignerProvider('e2e-kid', 'e2e-seed'));
    activate = new ActivateService(db, signer);
    heartbeat = new HeartbeatService(db, signer);
    batch = new BatchService(db);
    licenses = new LicenseService(db);
  });

  afterAll(async () => {
    await db.destroy();
  });

  async function reset(): Promise<void> {
    await withSystemTx(db, async (tx) => {
      await tx.deleteFrom('idempotency_keys').execute();
      await tx.deleteFrom('events').execute();
      await tx.deleteFrom('renewals').execute();
      await tx.deleteFrom('client_tokens').execute();
      await tx.deleteFrom('license_activations').execute();
      await tx.deleteFrom('devices').execute();
      await tx.deleteFrom('licenses').execute();
      await tx.deleteFrom('license_batches').execute();
      // e2e 临时策略(外键依赖批次, 必须在批次删除后清理)
      await tx.deleteFrom('policies').where('code', 'like', 'e2e-%').execute();
    });
  }

  it('batch issue is idempotent and returns codes', async () => {
    await reset();
    const cmd = { product_id: PRODUCT, policy_id: POLICY, channel_id: CHANNEL, quantity: 6 };
    const r1 = await batch.issue(TENANT, cmd, 'e2e-key-1');
    expect(r1.status).toBe(201);
    expect(r1.body.data.issued_count).toBe(6);
    expect(r1.body.data.codes).toHaveLength(6);

    const r2 = await batch.issue(TENANT, cmd, 'e2e-key-1');
    expect(r2.status).toBe(201);
    expect(r2.body.data.batch_id).toBe(r1.body.data.batch_id); // 幂等重放
    const total = await withSystemTx(db, (tx) =>
      tx.selectFrom('licenses').select((eb) => eb.fn.countAll().as('cnt')).executeTakeFirstOrThrow(),
    );
    expect(Number(total.cnt)).toBe(6); // 没有重复发码
  });

  it('device_limit is enforced exactly under concurrency (device_limit=5)', async () => {
    await reset();
    const r = await batch.issue(
      TENANT,
      { product_id: PRODUCT, policy_id: POLICY, channel_id: CHANNEL, quantity: 8 },
      `e2e-key-${Date.now()}`,
    );
    const code = r.body.data.codes![0]!;

    // 同一张码串行激活 5 台(名额占满)
    for (let i = 0; i < 5; i++) {
      const res = await activate.activate({
        code,
        app: { productCode: 'dorm-check', version: '2.4.1' },
        device: dev(i),
      });
      expect(res.license.status).toBe('activated');
      expect(res.license.device.bound).toBe(i + 1);
    }
    // 第 6 台(新设备)被拒
    await expect(
      activate.activate({
        code,
        app: { productCode: 'dorm-check', version: '2.4.1' },
        device: dev(99),
      }),
    ).rejects.toMatchObject({ code: 'LIC_DEVICE_LIMIT_REACHED' });

    // 同设备重复激活 → 幂等(不消耗名额)
    const again = await activate.activate({
      code,
      app: { productCode: 'dorm-check', version: '2.4.1' },
      device: dev(0),
    });
    expect(again.replayed).toBe(true);
    expect(again.license.device.bound).toBe(5);

    // 名额已满后并发 5 个新设备 → 全部 409(行锁串行 + 计数校验, 无超卖)
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        expect(
          activate.activate({
            code,
            app: { productCode: 'dorm-check', version: '2.4.1' },
            device: dev(100 + i),
          }),
        ).rejects.toMatchObject({ code: 'LIC_DEVICE_LIMIT_REACHED' }),
      ),
    );
  });

  it('concurrent first-activation of the same code: exactly one wins', async () => {
    await reset();
    // 临时策略 device_limit=1
    const policyId = '33333333-3333-4333-8333-333333333399';
    await withSystemTx(db, async (tx) => {
      await tx
        .insertInto('policies')
        .values({
          id: policyId,
          tenant_id: TENANT,
          product_id: PRODUCT,
          code: 'e2e-limit1',
          name: 'e2e 1 device',
          kind: 'standard',
          duration_days: 30,
          device_limit: 1,
          seat_limit: null,
          concurrency_limit: null,
          features: JSON.stringify(['dorm']) as unknown as string[],
          offline_window_days: 0,
          heartbeat_hours: 24,
          grace_hours: 72,
          activate_within_days: 0,
          allow_renewal: true,
          renew_window_days: 90,
          min_version: null,
          status: 'active',
          created_by: '00000000-0000-0000-0000-000000000000',
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();
    });
    const r = await batch.issue(
      TENANT,
      { product_id: PRODUCT, policy_id: policyId, quantity: 1 },
      `e2e-key-${Date.now()}-b`,
    );
    const code = r.body.data.codes![0]!;

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        activate.activate({
          code,
          app: { productCode: 'dorm-check', version: '2.4.1' },
          device: dev(200 + i),
        }),
      ),
    );
    const ok = results.filter((x) => x.status === 'fulfilled');
    const failed = results.filter((x) => x.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(7);
    for (const f of failed) {
      expect((f as PromiseRejectedResult).reason).toMatchObject({
        code: 'LIC_DEVICE_LIMIT_REACHED',
      });
    }
  });

  it('heartbeat rotates token; heartbeat after revoke fails 410', async () => {
    await reset();
    const r = await batch.issue(
      TENANT,
      { product_id: PRODUCT, policy_id: POLICY, channel_id: CHANNEL, quantity: 2 },
      `e2e-key-${Date.now()}-c`,
    );
    const code = r.body.data.codes![0]!;
    const act = await activate.activate({
      code,
      app: { productCode: 'dorm-check', version: '2.4.1' },
      device: dev(300),
    });
    expect(act.offline_license).toBeTruthy();

    const hb1 = await heartbeat.heartbeat(`Bearer ${act.client_token}`);
    expect(hb1.status).toBe('activated');
    expect(hb1.client_token).not.toBe(act.client_token);

    // 旧 token 在重叠窗口内仍可用
    const hbOld = await heartbeat.heartbeat(`Bearer ${act.client_token}`);
    expect(hbOld.client_token).toBeTruthy();

    // 吊销 → 心跳 410 LIC_REVOKED
    const licId = act.license.id;
    await licenses.revoke(TENANT, licId, { reason: 'e2e-refund' }, `rk-${Date.now()}`);
    await expect(heartbeat.heartbeat(`Bearer ${hb1.client_token}`)).rejects.toMatchObject({
      code: 'LIC_REVOKED',
      http: 410,
    });

    // 再次吊销 → 409 状态机拒绝
    await expect(
      licenses.revoke(TENANT, licId, { reason: 'again' }, `rk2-${Date.now()}`),
    ).rejects.toMatchObject({ code: 'LIC_STATUS_INVALID' });
  });

  it('renew extends expiry and revives expired license', async () => {
    await reset();
    const r = await batch.issue(
      TENANT,
      { product_id: PRODUCT, policy_id: POLICY, channel_id: CHANNEL, quantity: 1 },
      `e2e-key-${Date.now()}-d`,
    );
    const code = r.body.data.codes![0]!;
    const act = await activate.activate({
      code,
      app: { productCode: 'dorm-check', version: '2.4.1' },
      device: dev(400),
    });
    const licId = act.license.id;

    const rn = await licenses.renew(
      TENANT,
      licId,
      { days: 30, order_ref: 'SO-E2E-1' },
      `rn-${Date.now()}`,
    );
    expect(rn.status).toBe(200);
    const body = rn.body as { data: { new_expires_at: string } };
    expect(new Date(body.data.new_expires_at).getTime()).toBeGreaterThan(Date.now());

    // 同 order_ref 再入账 → 幂等冲突
    await expect(
      licenses.renew(TENANT, licId, { days: 30, order_ref: 'SO-E2E-1' }, `rn2-${Date.now()}`),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    // AppError 类检查(错误目录契约)
    try {
      await licenses.renew(TENANT, licId, { days: 0 }, 'bad');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
    }
  });
});
