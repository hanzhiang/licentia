/// <reference types="vitest" />
/**
 * 授权码交付 e2e: 发码之后把码发给客户，并留下交付痕迹；授权轨迹可查。
 * 前置: TEST_DATABASE_URL。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely } from 'kysely';
import { createDb, withTenantTx, type LpDb } from '@lp/db';
import { LicenseSigner, LocalSignerProvider } from '@lp/signer';
import { CatalogService } from '../../apps/admin-api/src/modules/catalog/catalog.service';
import { BatchService } from '../../apps/admin-api/src/modules/batch/batch.service';
import { LicenseService } from '../../apps/admin-api/src/modules/license/license.service';
import { DeliveryService } from '../../apps/admin-api/src/modules/delivery/delivery.service';
import { ActivateService } from '../../apps/client-api/src/modules/activate/activate.service';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;
const TENANT = '11111111-1111-4111-8111-111111111111';
const actor = {
  userId: 'a1111111-0000-4000-8000-000000000002',
  actorType: 'developer_owner',
  ip: null,
  requestId: 'deliver-e2e',
};

d.sequential('license delivery', () => {
  let db: Kysely<LpDb>;
  let catalog: CatalogService;
  let batch: BatchService;
  let licenses: LicenseService;
  let delivery: DeliveryService;
  let activate: ActivateService;
  let productId = '';
  let policyId = '';
  let batchId = '';
  const suffix = Date.now().toString(36);
  const productCode = `dlv${suffix}`;

  beforeAll(async () => {
    db = createDb(url!, { max: 5 });
    catalog = new CatalogService(db);
    batch = new BatchService(db);
    licenses = new LicenseService(db);
    delivery = new DeliveryService(db);
    activate = new ActivateService(
      db,
      new LicenseSigner(new LocalSignerProvider('deliver-kid', 'deliver-seed')),
    );

    productId = (
      await catalog.createProduct(TENANT, { code: productCode, name: '交付测试产品' }, actor)
    ).id;
    policyId = (
      await catalog.createPolicy(
        TENANT,
        {
          productId,
          code: `dlvpol-${suffix}`,
          name: '交付策略',
          kind: 'standard',
          durationDays: 365,
          deviceLimit: 3,
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
      )
    ).id;

    const res = await batch.issue(
      TENANT,
      { product_id: productId, policy_id: policyId, quantity: 2 } as never,
      `dlv-${suffix}`,
      actor,
    );
    batchId = (res.body.data as { batch_id: string }).batch_id;
  });

  afterAll(async () => {
    await withTenantTx(db, TENANT, async (tx) => {
      const ids = await tx
        .selectFrom('licenses')
        .select('id')
        .where('product_id', '=', productId)
        .execute();
      if (ids.length > 0) {
        const licIds = ids.map((r) => r.id);
        await tx.deleteFrom('license_deliveries').where('license_id', 'in', licIds).execute();
        await tx.deleteFrom('client_tokens').where('license_id', 'in', licIds).execute();
        await tx.deleteFrom('license_activations').where('license_id', 'in', licIds).execute();
        await tx.deleteFrom('devices').where('product_id', '=', productId).execute();
      }
      await tx.deleteFrom('license_deliveries').where('batch_id', '=', batchId).execute();
      await tx.deleteFrom('licenses').where('product_id', '=', productId).execute();
      await tx.deleteFrom('license_batches').where('product_id', '=', productId).execute();
      await tx.deleteFrom('policies').where('product_id', '=', productId).execute();
      await tx.deleteFrom('products').where('id', '=', productId).execute();
    });
    await db.destroy();
  });

  it('delivers a batch to an explicit recipient and records an audit entry', async () => {
    const out = await delivery.deliverBatch(TENANT, batchId, 'customer@example.com', 200, actor);
    expect(out.sent).toBe(true);
    expect(out.count).toBe(2);
    expect(out.to).toBe('customer@example.com');

    const audits = await withTenantTx(db, TENANT, (tx) =>
      tx
        .selectFrom('audit_events')
        .select(['action'])
        .where('action', '=', 'batch.deliver')
        .where('resource_id', '=', batchId)
        .execute(),
    );
    expect(audits.length).toBe(1);
  }, 60000);

  it('refuses to deliver with no recipient and no org contact', async () => {
    const lic = (await licenses.list(TENANT, { limit: 1 }))[0]!;
    await expect(delivery.deliverLicense(TENANT, lic.id, null, actor)).rejects.toMatchObject({
      code: 'REQ_INVALID',
    });
  }, 60000);

  it('records every delivery so resends and outcomes are auditable', async () => {
    const lic = (await licenses.list(TENANT, { limit: 1 }))[0]!;
    const before = await delivery.listForLicense(TENANT, lic.id);
    expect(before.total).toBe(0);

    await delivery.deliverLicense(TENANT, lic.id, 'repeat@example.com', actor);
    await delivery.deliverLicense(TENANT, lic.id, 'repeat@example.com', actor);

    const after = await delivery.listForLicense(TENANT, lic.id);
    expect(after.total).toBe(before.total + 2);
    expect(after.sent).toBe(before.sent + 2);
    expect(after.last_sent_at).not.toBeNull();
    // 列表里只出现脱敏地址, 不返回明文
    expect(after.records[0]!.to_masked).toContain('***');
    expect(after.records[0]!.to_masked).not.toContain('repeat@');
  }, 60000);

  it('exposes the license timeline including activation', async () => {
    const lic = (await licenses.list(TENANT, { limit: 1 }))[0]!;
    const full = await withTenantTx(db, TENANT, (tx) =>
      tx.selectFrom('licenses').select(['code']).where('id', '=', lic.id).executeTakeFirstOrThrow(),
    );
    await activate.activate({
      code: full.code,
      app: { productCode, version: '1.0.0' },
      device: { fpType: 'machine_id', fingerprint: `dlv-dev-${suffix}`, platform: 'windows' },
    });

    const line = await licenses.timeline(TENANT, lic.id);
    const types = line.map((e) => e.type);
    expect(types).toContain('issued');
    expect(types).toContain('activated');
    // 时间必须递增
    const times = line.map((e) => Date.parse(e.at));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  }, 60000);
});
