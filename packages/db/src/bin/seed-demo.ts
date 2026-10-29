/**
 * 演示数据 CLI: 幂等创建 demo 开发者(租户)、产品、策略、渠道与各角色账号。
 *
 * 用途:
 *  - e2e 全局夹具(测试前保证数据存在)
 *  - 手工演示: `pnpm seed:demo`
 *
 * 与 `pnpm db:reset` 配套: 重置后跑一次即可恢复可演示的状态。
 */
import { createDb, withSystemTx, type LpDb } from '../index';
import { hashPassword } from '@lp/auth';
import type { Kysely } from 'kysely';

const TENANT = '11111111-1111-4111-8111-111111111111';
const PRODUCT = '22222222-2222-4222-8222-222222222222';
const POLICY = '33333333-3333-4333-8333-333333333333';
const CHANNEL = '44444444-4444-4444-8444-444444444444';

const USERS: Array<{ id: string; email: string; role: string }> = [
  { id: 'a1111111-0000-4000-8000-000000000002', email: 'admin@demo.local', role: 'developer_owner' },
  { id: 'a1111111-0000-4000-8000-000000000003', email: 'operator@demo.local', role: 'developer_operator' },
  { id: 'a1111111-0000-4000-8000-000000000004', email: 'support@demo.local', role: 'developer_support' },
  { id: 'a1111111-0000-4000-8000-000000000005', email: 'finance@demo.local', role: 'developer_finance' },
  { id: 'a1111111-0000-4000-8000-000000000006', email: 'partner@demo.local', role: 'developer_partner' },
];

export async function seedDemoFixtures(url: string, password = 'Passw0rd!demo'): Promise<void> {
  const db: Kysely<LpDb> = createDb(url, { max: 3 });
  try {
    await withSystemTx(db, async (tx) => {
      await tx
        .insertInto('tenants')
        .values({
          id: TENANT,
          code: 'demo',
          name: '演示开发者',
          status: 'active',
          plan: 'standard',
          locale: 'zh-CN',
          settings: '{}' as unknown as Record<string, unknown>,
          created_at: new Date(),
          updated_at: new Date(),
          deleted_at: null,
        })
        .onConflict((oc) => oc.column('id').doUpdateSet({ status: 'active', deleted_at: null }))
        .execute();

      await tx
        .insertInto('products')
        .values({
          id: PRODUCT,
          tenant_id: TENANT,
          code: 'dorm-check',
          name: '宿舍查寝',
          status: 'active',
          created_at: new Date(),
          updated_at: new Date(),
          deleted_at: null,
        })
        .onConflict((oc) => oc.column('id').doUpdateSet({ status: 'active', deleted_at: null }))
        .execute();

      await tx
        .insertInto('channels')
        .values({
          id: CHANNEL,
          tenant_id: TENANT,
          code: 'default',
          name: '直销',
          status: 'active',
          created_at: new Date(),
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();

      await tx
        .insertInto('policies')
        .values({
          id: POLICY,
          tenant_id: TENANT,
          product_id: PRODUCT,
          code: 'std-365-5dev',
          name: '标准版 365天/5设备',
          kind: 'standard',
          duration_days: 365,
          device_limit: 5,
          seat_limit: null,
          concurrency_limit: null,
          features: JSON.stringify(['dorm', 'leave']) as unknown as string[],
          offline_window_days: 7,
          heartbeat_hours: 24,
          grace_hours: 72,
          activate_within_days: 0,
          allow_renewal: true,
          renew_window_days: 90,
          min_version: '>=2.0.0',
          status: 'active',
          created_by: '00000000-0000-0000-0000-000000000000',
          created_at: new Date(),
          updated_at: new Date(),
          deleted_at: null,
        })
        .onConflict((oc) => oc.column('id').doUpdateSet({ status: 'active', deleted_at: null }))
        .execute();

      const passwordHash = hashPassword(password);
      for (const u of USERS) {
        await tx
          .insertInto('users')
          .values({
            id: u.id,
            tenant_id: TENANT,
            email: u.email,
            phone_hash: null,
            password_hash: passwordHash,
            status: 'active',
            last_login_at: null,
            email_verified_at: new Date(),
            created_at: new Date(),
            updated_at: new Date(),
            deleted_at: null,
          })
          .onConflict((oc) =>
            oc.column('id').doUpdateSet({
              tenant_id: TENANT,
              password_hash: passwordHash,
              status: 'active',
              email_verified_at: new Date(),
              deleted_at: null,
            }),
          )
          .execute();
        await tx.deleteFrom('user_roles').where('user_id', '=', u.id).execute();
        await tx.insertInto('user_roles').values({ user_id: u.id, role_code: u.role }).execute();
      }
    });
  } finally {
    await db.destroy();
  }
}

async function main(): Promise<void> {
  const url =
    process.env.MIGRATE_DATABASE_URL ??
    process.env.DATABASE_URL ??
    'postgresql://postgres:lp@localhost:55432/lp';
  await seedDemoFixtures(url, process.env.SEED_PASSWORD ?? 'Passw0rd!demo');
  console.log('seed:demo 完成 — 演示开发者(demo)与 5 个角色账号已就绪');
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('seed:demo failed:', (e as Error).message);
      process.exit(1);
    });
}
