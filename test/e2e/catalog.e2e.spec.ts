/// <reference types="vitest" />
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely } from 'kysely';
import { createDb, withTenantTx, type LpDb } from '@lp/db';
import { CatalogService } from '../../apps/admin-api/src/modules/catalog/catalog.service';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;
const TENANT = '11111111-1111-4111-8111-111111111111';
const actor = {
  userId: 'a1111111-0000-4000-8000-000000000002',
  actorType: 'tenant_admin',
  ip: '127.0.0.1',
  requestId: 'catalog-e2e',
};

d.sequential('catalog management e2e', () => {
  let db: Kysely<LpDb>;
  let service: CatalogService;
  let productId = '';
  let channelId = '';
  const suffix = Date.now().toString(36);

  beforeAll(() => {
    db = createDb(url!, { max: 5 });
    service = new CatalogService(db);
  });

  afterAll(async () => {
    await withTenantTx(db, TENANT, async (tx) => {
      await tx.deleteFrom('policies').where('code', '=', `e2e-policy-${suffix}`).execute();
      if (productId) await tx.deleteFrom('products').where('id', '=', productId).execute();
      if (channelId) await tx.deleteFrom('channels').where('id', '=', channelId).execute();
    });
    await db.destroy();
  });

  it('creates product/channel/policy and returns them in catalog', async () => {
    const product = await service.createProduct(
      TENANT,
      { code: `e2e-product-${suffix}`, name: 'E2E 产品' },
      actor,
    );
    productId = product.id;

    const channel = await service.createChannel(
      TENANT,
      { code: `e2e-channel-${suffix}`, name: 'E2E 渠道' },
      { ...actor, actorType: 'operator' },
    );
    channelId = channel.id;

    const policy = await service.createPolicy(
      TENANT,
      {
        productId,
        code: `e2e-policy-${suffix}`,
        name: 'E2E 策略',
        kind: 'standard',
        durationDays: 365,
        deviceLimit: 5,
        seatLimit: 20,
        concurrencyLimit: 5,
        features: ['e2e', 'license'],
        offlineWindowDays: 7,
        heartbeatHours: 24,
        graceHours: 72,
        activateWithinDays: 30,
        allowRenewal: true,
        renewWindowDays: 90,
        minVersion: '>=1.0.0',
      },
      actor,
    );
    expect(policy.id).toBeTruthy();

    const catalog = await service.list(TENANT);
    expect(catalog.products.some((p) => p.id === productId)).toBe(true);
    expect(catalog.channels.some((c) => c.id === channelId)).toBe(true);
    expect(catalog.policies.find((p) => p.id === policy.id)).toMatchObject({
      product_id: productId,
      code: `e2e-policy-${suffix}`,
      features: ['e2e', 'license'],
      device_limit: 5,
      seat_limit: 20,
    });
  });

  it('rejects duplicate codes and invalid trial policies', async () => {
    await expect(
      service.createProduct(TENANT, { code: `e2e-product-${suffix}`, name: '重复' }, actor),
    ).rejects.toMatchObject({ code: 'REQ_INVALID' });

    await expect(
      service.createPolicy(
        TENANT,
        {
          productId,
          code: `e2e-invalid-${suffix}`,
          name: '非法试用策略',
          kind: 'trial',
          durationDays: 60,
          deviceLimit: 10,
          seatLimit: null,
          concurrencyLimit: null,
          features: ['trial'],
          offlineWindowDays: 7,
          heartbeatHours: 24,
          graceHours: 72,
          activateWithinDays: 0,
          allowRenewal: true,
          renewWindowDays: 0,
          minVersion: null,
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: 'REQ_INVALID' });
  });


  it('edits product/policy and toggles their status', async () => {
    const product = await service.createProduct(
      TENANT,
      { code: `e2e-edit-${suffix}`, name: '待改名产品' },
      actor,
    );
    const renamed = await service.updateProduct(
      TENANT,
      product.id,
      { name: '已改名产品', status: 'disabled' },
      actor,
    );
    expect(renamed.name).toBe('已改名产品');
    expect(renamed.status).toBe('disabled');

    const policy = await service.createPolicy(
      TENANT,
      {
        productId: product.id,
        code: `e2e-edit-policy-${suffix}`,
        name: '待调整策略',
        kind: 'standard',
        durationDays: 365,
        deviceLimit: 5,
        seatLimit: null,
        concurrencyLimit: null,
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
    const updated = await service.updatePolicy(
      TENANT,
      policy.id,
      { deviceLimit: 10, features: ['dorm', 'leave'] },
      actor,
    );
    expect(updated.id).toBe(policy.id);

    const rows = await withTenantTx(db, TENANT, (tx) =>
      tx
        .selectFrom('policies')
        .select(['device_limit', 'features'])
        .where('id', '=', policy.id)
        .executeTakeFirstOrThrow(),
    );
    expect(rows.device_limit).toBe(10);
    expect(rows.features).toEqual(['dorm', 'leave']);

    // 不合法组合必须被拒(trial 时长 > 30 天)
    await expect(
      service.updatePolicy(TENANT, policy.id, { features: [] }, actor),
    ).rejects.toMatchObject({ code: 'REQ_INVALID' });

    await withTenantTx(db, TENANT, async (tx) => {
      await tx.deleteFrom('policies').where('id', '=', policy.id).execute();
      await tx.deleteFrom('products').where('id', '=', product.id).execute();
    });
  });
});
