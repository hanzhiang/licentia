/// <reference types="vitest" />
/**
 * 渠道数据隔离 e2e: 绑定渠道的账号只能看到/发放本渠道的授权码。
 * 前置: TEST_DATABASE_URL（demo 租户由全局夹具准备）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely } from 'kysely';
import { createDb, withTenantTx, type LpDb } from '@lp/db';
import { CatalogService } from '../../apps/admin-api/src/modules/catalog/catalog.service';
import { MemberService } from '../../apps/admin-api/src/modules/member/member.service';
import { BatchService } from '../../apps/admin-api/src/modules/batch/batch.service';
import { LicenseService } from '../../apps/admin-api/src/modules/license/license.service';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

const TENANT = '11111111-1111-4111-8111-111111111111';
const OWNER = {
  userId: 'a1111111-0000-4000-8000-000000000002',
  actorType: 'developer_owner',
  ip: null,
  requestId: 'channel-e2e',
};

d.sequential('channel-scoped data isolation', () => {
  let db: Kysely<LpDb>;
  let catalog: CatalogService;
  let members: MemberService;
  let batch: BatchService;
  let licenses: LicenseService;
  let chA = '';
  let chB = '';
  let productId = '';
  let policyId = '';
  const suffix = Date.now().toString(36);

  beforeAll(async () => {
    db = createDb(url!, { max: 5 });
    catalog = new CatalogService(db);
    members = new MemberService(db);
    batch = new BatchService(db);
    licenses = new LicenseService(db);

    const product = await catalog.createProduct(
      TENANT,
      { code: `chan${suffix}`, name: '渠道隔离产品' },
      OWNER,
    );
    productId = product.id;
    chA = (
      await catalog.createChannel(TENANT, { code: `ch-a-${suffix}`, name: '渠道 A' }, OWNER)
    ).id;
    chB = (
      await catalog.createChannel(TENANT, { code: `ch-b-${suffix}`, name: '渠道 B' }, OWNER)
    ).id;
    const policy = await catalog.createPolicy(
      TENANT,
      {
        productId,
        code: `ch-pol-${suffix}`,
        name: '渠道策略',
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
      OWNER,
    );
    policyId = policy.id;
  });

  afterAll(async () => {
    await withTenantTx(db, TENANT, async (tx) => {
      await tx.deleteFrom('licenses').where('product_id', '=', productId).execute();
      await tx.deleteFrom('license_batches').where('product_id', '=', productId).execute();
      await tx.deleteFrom('policies').where('id', '=', policyId).execute();
      await tx.deleteFrom('products').where('id', '=', productId).execute();
      // 顺序: 先断 users → channels 的外键, 再删渠道
      const partners = await tx
        .selectFrom('users')
        .select('id')
        .where('email', 'like', `ch-partner-${suffix}%`)
        .execute();
      for (const u of partners) {
        await tx.deleteFrom('user_roles').where('user_id', '=', u.id).execute();
        await tx.deleteFrom('users').where('id', '=', u.id).execute();
      }
      await tx.deleteFrom('channels').where('id', 'in', [chA, chB]).execute();
    });
    await db.destroy();
  });

  it('requires a channel when creating a partner account', async () => {
    await expect(
      members.create(
        TENANT,
        { email: `ch-partner-noc-${suffix}@example.com`, password: 'PartnerPassw0rd!', role: 'developer_partner' },
        OWNER,
      ),
    ).rejects.toMatchObject({ code: 'REQ_INVALID' });
  });

  it('scopes issuing, listing and reading to the bound channel', async () => {
    const partner = await members.create(
      TENANT,
      {
        email: `ch-partner-${suffix}@example.com`,
        password: 'PartnerPassw0rd!',
        role: 'developer_partner',
        channelId: chA,
      },
      OWNER,
    );
    expect(partner.channel_id).toBe(chA);

    const actor = {
      userId: partner.id,
      actorType: 'developer_partner',
      ip: null,
      requestId: 'channel-e2e',
      channelId: chA,
    };

    // 渠道账号不指定渠道发码 → 自动归本渠道
    await batch.issue(
      TENANT,
      { product_id: productId, policy_id: policyId, quantity: 1 } as never,
      `ch-a-${suffix}-1`,
      actor,
    );
    // 跨渠道发码 → 拒绝
    await expect(
      batch.issue(
        TENANT,
        { product_id: productId, policy_id: policyId, channel_id: chB, quantity: 1 } as never,
        `ch-b-${suffix}-1`,
        actor,
      ),
    ).rejects.toMatchObject({ code: 'REQ_INVALID' });

    // 所有者往 B 渠道发一批
    await batch.issue(
      TENANT,
      { product_id: productId, policy_id: policyId, channel_id: chB, quantity: 1 } as never,
      `ch-b-owner-${suffix}`,
      OWNER,
    );

    const scoped = await licenses.list(TENANT, { limit: 200, channelId: chA });
    const all = await licenses.list(TENANT, { limit: 200 });
    expect(all.length).toBeGreaterThan(scoped.length);
    expect(scoped.length).toBe(1);

    // 越权读取他渠道的码: 返回不存在, 不泄露存在性
    const other = all.find((l) => !scoped.some((s) => s.id === l.id))!;
    await expect(licenses.get(TENANT, other.id, chA)).rejects.toMatchObject({
      code: 'LIC_NOT_FOUND',
    });
    await expect(licenses.get(TENANT, scoped[0]!.id, chA)).resolves.toMatchObject({
      id: scoped[0]!.id,
    });
  }, 60000);
});
