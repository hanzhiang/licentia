/// <reference types="vitest" />
/**
 * 远程授权 e2e: 客户端上报设备 → 开发者后台批准 → 客户端轮询拿到码并激活。
 * 前置: TEST_DATABASE_URL（demo 租户由全局夹具准备）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely } from 'kysely';
import { createDb, withTenantTx, type LpDb } from '@lp/db';
import { LicenseSigner, LocalSignerProvider } from '@lp/signer';
import { DeviceRequestService } from '../../apps/client-api/src/modules/device-request/device-request.service';
import { DeviceRequestAdminService } from '../../apps/admin-api/src/modules/devicerequest/devicerequest.service';
import { ActivateService } from '../../apps/client-api/src/modules/activate/activate.service';
import { CatalogService } from '../../apps/admin-api/src/modules/catalog/catalog.service';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;
const TENANT = '11111111-1111-4111-8111-111111111111';
const actor = {
  userId: 'a1111111-0000-4000-8000-000000000002',
  actorType: 'developer_owner',
  ip: null,
  requestId: 'remote-auth-e2e',
};

d.sequential('remote device authorization', () => {
  let db: Kysely<LpDb>;
  let clientSvc: DeviceRequestService;
  let adminSvc: DeviceRequestAdminService;
  let catalog: CatalogService;
  let activate: ActivateService;
  let productId = '';
  let policyId = '';
  const suffix = Date.now().toString(36);
  const productCode = `rma${suffix}`;
  const createdLicenses: string[] = [];

  beforeAll(async () => {
    db = createDb(url!, { max: 5 });
    clientSvc = new DeviceRequestService(db, null);
    adminSvc = new DeviceRequestAdminService(db);
    catalog = new CatalogService(db);
    activate = new ActivateService(
      db,
      new LicenseSigner(new LocalSignerProvider('rma-kid', 'rma-seed')),
    );

    productId = (
      await catalog.createProduct(TENANT, { code: productCode, name: '远程授权产品' }, actor)
    ).id;
    policyId = (
      await catalog.createPolicy(
        TENANT,
        {
          productId,
          code: `rmapol-${suffix}`,
          name: '远程授权策略',
          kind: 'standard',
          durationDays: 365,
          deviceLimit: 2,
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
  });

  afterAll(async () => {
    await withTenantTx(db, TENANT, async (tx) => {
      await tx.deleteFrom('device_requests').where('product_id', '=', productId).execute();
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
        await tx.deleteFrom('licenses').where('id', 'in', licIds).execute();
      }
      await tx.deleteFrom('policies').where('id', '=', policyId).execute();
      await tx.deleteFrom('products').where('id', '=', productId).execute();
    });
    await db.destroy();
    void createdLicenses;
  });

  it('issues a code after the developer approves the device', async () => {
    const device = { fpType: 'machine_id', fingerprint: `rma-dev-${suffix}`, platform: 'windows' };
    const req = await clientSvc.create(
      { productCode, tenantCode: 'demo', appVersion: '1.0.0', userId: 'student-1', device },
      '10.1.1.1',
    );
    expect(req.request_code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    // 批准前: pending
    await expect(clientSvc.poll(req.request_code, device)).resolves.toMatchObject({
      status: 'pending',
    });

    const pending = await adminSvc.list(TENANT, 'pending');
    const mine = pending.find((r) => r.request_code === req.request_code)!;
    expect(mine).toBeTruthy();
    expect(mine.user_id).toBe('student-1');

    const approved = await adminSvc.approve(TENANT, mine.id, { policyId }, actor);
    createdLicenses.push(approved.license_id);

    // 批准后: 拿到码, 且能用它完成标准激活
    const polled = await clientSvc.poll(req.request_code, device);
    expect(polled).toMatchObject({ status: 'approved', product_code: productCode });
    if (polled.status !== 'approved') throw new Error('unreachable');

    const res = await activate.activate({
      code: polled.code,
      app: { productCode, version: '1.0.0' },
      device,
    });
    expect(res.license.status).toBe('activated');
  }, 60000);

  it('rejects polling from a different device fingerprint', async () => {
    const device = { fpType: 'machine_id', fingerprint: `rma-dev2-${suffix}`, platform: 'windows' };
    const req = await clientSvc.create(
      { productCode, tenantCode: 'demo', appVersion: '1.0.0', device },
      '10.1.1.2',
    );
    await expect(
      clientSvc.poll(req.request_code, { ...device, fingerprint: 'someone-else' }),
    ).rejects.toMatchObject({ code: 'LIC_NOT_FOUND' });
  }, 60000);

  it('cannot approve the same request twice', async () => {
    const device = { fpType: 'machine_id', fingerprint: `rma-dev3-${suffix}`, platform: 'windows' };
    const req = await clientSvc.create(
      { productCode, tenantCode: 'demo', appVersion: '1.0.0', device },
      '10.1.1.3',
    );
    const pending = await adminSvc.list(TENANT, 'pending');
    const mine = pending.find((r) => r.request_code === req.request_code)!;
    const first = await adminSvc.approve(TENANT, mine.id, { policyId }, actor);
    createdLicenses.push(first.license_id);

    await expect(
      adminSvc.approve(TENANT, mine.id, { policyId }, actor),
    ).rejects.toMatchObject({ code: 'REQ_INVALID' });
  }, 60000);

  it('reports rejection to the client', async () => {
    const device = { fpType: 'machine_id', fingerprint: `rma-dev4-${suffix}`, platform: 'windows' };
    const req = await clientSvc.create(
      { productCode, tenantCode: 'demo', appVersion: '1.0.0', device },
      '10.1.1.4',
    );
    const pending = await adminSvc.list(TENANT, 'pending');
    const mine = pending.find((r) => r.request_code === req.request_code)!;
    await adminSvc.reject(TENANT, mine.id, '未购买', actor);

    await expect(clientSvc.poll(req.request_code, device)).resolves.toMatchObject({
      status: 'rejected',
      note: '未购买',
    });
  }, 60000);
});
