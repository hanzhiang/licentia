/// <reference types="vitest" />
/**
 * 席位与并发限制 e2e: 策略里的 seat_limit / concurrency_limit 必须在心跳时真正生效。
 * 此前这两个字段只被塞进离线许可当元数据，服务端从不校验。
 * 前置: TEST_DATABASE_URL + Redis（无 Redis 时跳过）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely } from 'kysely';
import { createDb, withTenantTx, type LpDb } from '@lp/db';
import { createRedis, type Redis } from '@lp/cache';
import { getConfig } from '@lp/config';
import { LicenseSigner, LocalSignerProvider } from '@lp/signer';
import { CatalogService } from '../../apps/admin-api/src/modules/catalog/catalog.service';
import { BatchService } from '../../apps/admin-api/src/modules/batch/batch.service';
import { ActivateService } from '../../apps/client-api/src/modules/activate/activate.service';
import { HeartbeatService } from '../../apps/client-api/src/modules/heartbeat/heartbeat.service';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;
const TENANT = '11111111-1111-4111-8111-111111111111';
const actor = {
  userId: 'a1111111-0000-4000-8000-000000000002',
  actorType: 'developer_owner',
  ip: null,
  requestId: 'seat-e2e',
};

d.sequential('seat and concurrency limits', () => {
  let db: Kysely<LpDb>;
  let redis: Redis | null = null;
  let catalog: CatalogService;
  let batch: BatchService;
  let activate: ActivateService;
  let heartbeat: HeartbeatService;
  let productId = '';
  const policyIds: string[] = [];
  const suffix = Date.now().toString(36);
  const productCode = `seat${suffix}`;

  beforeAll(async () => {
    db = createDb(url!, { max: 5 });
    try {
      redis = createRedis(getConfig().REDIS_URL);
      await redis.ping();
    } catch {
      redis = null;
    }
    const signer = new LicenseSigner(new LocalSignerProvider('seat-e2e-kid', 'seat-e2e-seed'));
    catalog = new CatalogService(db);
    batch = new BatchService(db);
    activate = new ActivateService(db, signer);
    heartbeat = new HeartbeatService(db, signer, redis);

    productId = (
      await catalog.createProduct(TENANT, { code: productCode, name: '席位测试产品' }, actor)
    ).id;
  });

  afterAll(async () => {
    await withTenantTx(db, TENANT, async (tx) => {
      // 先断子表, 否则 licenses 被 activations/client_tokens 的外键挡住
      const ids = await tx
        .selectFrom('licenses')
        .select('id')
        .where('product_id', '=', productId)
        .execute();
      if (ids.length > 0) {
        const licIds = ids.map((r) => r.id);
        await tx.deleteFrom('client_tokens').where('license_id', 'in', licIds).execute();
        await tx.deleteFrom('license_activations').where('license_id', 'in', licIds).execute();
        await tx.deleteFrom('devices').where('product_id', '=', productId).execute();
      }
      await tx
        .deleteFrom('license_deliveries')
        .where('tenant_id', '=', TENANT)
        .execute();
      await tx.deleteFrom('device_requests').where('product_id', '=', productId).execute();
      await tx.deleteFrom('licenses').where('product_id', '=', productId).execute();
      await tx.deleteFrom('license_batches').where('product_id', '=', productId).execute();
      await tx.deleteFrom('policies').where('product_id', '=', productId).execute();
      await tx.deleteFrom('products').where('id', '=', productId).execute();
    });
    if (redis) {
      const keys = await redis.keys('lp:seats:*');
      const conc = await redis.keys('lp:conc:*');
      const all = [...keys, ...conc];
      if (all.length > 0) await redis.del(...all);
      await redis.quit();
    }
    await db.destroy();
  });

  async function makePolicy(extra: { seat_limit?: number | null; concurrency_limit?: number | null }) {
    const p = await catalog.createPolicy(
      TENANT,
      {
        productId,
        code: `seatpol-${suffix}-${policyIds.length}`,
        name: '席位策略',
        kind: 'standard',
        durationDays: 365,
        deviceLimit: 3,
        seatLimit: extra.seat_limit ?? null,
        concurrencyLimit: extra.concurrency_limit ?? null,
        features: ['dorm'],
        offlineWindowDays: 7,
        heartbeatHours: 24,
        graceHours: 72,
        activateWithinDays: 0,
        allowRenewal: true,
        renewWindowDays: 90,
        minVersion: null,
      },
      actor,
    );
    policyIds.push(p.id);
    return p.id;
  }

  async function issueOne(policyId: string): Promise<string> {
    const res = await batch.issue(
      TENANT,
      { product_id: productId, policy_id: policyId, quantity: 1 } as never,
      `seat-${suffix}-${Math.random()}`,
      actor,
    );
    return (res.body.data as { codes: string[] }).codes[0]!;
  }

  async function activateOn(code: string, fingerprint: string): Promise<string> {
    const res = await activate.activate({
      code,
      app: { productCode, version: '1.0.0' },
      device: { fpType: 'machine_id', fingerprint, platform: 'windows' },
    });
    return res.client_token;
  }

  it('enforces seat_limit per distinct user', async () => {
    if (!redis) return;
    const policyId = await makePolicy({ seat_limit: 1 });
    const token = await activateOn(await issueOne(policyId), `seat-dev-${suffix}`);

    const first = await heartbeat.heartbeat(`Bearer ${token}`, { userId: 'user-A' });
    expect(first.status).toBe('activated');

    // 同一用户重复心跳不应占新席位
    await expect(heartbeat.heartbeat(`Bearer ${token}`, { userId: 'user-A' })).resolves.toBeTruthy();

    // 第二个用户超出 1 个席位
    await expect(
      heartbeat.heartbeat(`Bearer ${token}`, { userId: 'user-B' }),
    ).rejects.toMatchObject({ code: 'SEAT_CONCURRENCY_LIMIT' });
  }, 60000);

  it('enforces concurrency_limit across activations of one license', async () => {
    if (!redis) return;
    const policyId = await makePolicy({ concurrency_limit: 1 });
    const code = await issueOne(policyId);
    const t1 = await activateOn(code, `conc-a-${suffix}`);
    const t2 = await activateOn(code, `conc-b-${suffix}`);

    await expect(heartbeat.heartbeat(`Bearer ${t1}`)).resolves.toBeTruthy();
    await expect(heartbeat.heartbeat(`Bearer ${t2}`)).rejects.toMatchObject({
      code: 'SEAT_CONCURRENCY_LIMIT',
    });
  }, 60000);

  it('does not limit when the policy has no seat or concurrency cap', async () => {
    if (!redis) return;
    const policyId = await makePolicy({});
    const code = await issueOne(policyId);
    const t1 = await activateOn(code, `free-a-${suffix}`);
    const t2 = await activateOn(code, `free-b-${suffix}`);

    await expect(heartbeat.heartbeat(`Bearer ${t1}`)).resolves.toBeTruthy();
    await expect(heartbeat.heartbeat(`Bearer ${t2}`)).resolves.toBeTruthy();
  }, 60000);
});
