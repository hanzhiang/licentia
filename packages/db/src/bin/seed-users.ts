/**
 * 种子用户 CLI: 创建平台超管 + demo 租户四角色账号(幂等).
 * 用法: pnpm seed:users   (密码取 SEED_PASSWORD, 默认 Passw0rd!demo)
 */
import { Client } from 'pg';
import { hashPassword } from '@lp/auth';

const DEMO_TENANT = '11111111-1111-4111-8111-111111111111';

interface SeedUser {
  id: string;
  tenantId: string | null;
  email: string;
  role: string;
}

const USERS: SeedUser[] = [
  { id: 'a1111111-0000-4000-8000-000000000001', tenantId: null, email: 'super@lp.local', role: 'super_admin' },
  { id: 'a1111111-0000-4000-8000-000000000002', tenantId: DEMO_TENANT, email: 'admin@demo.local', role: 'tenant_admin' },
  { id: 'a1111111-0000-4000-8000-000000000003', tenantId: DEMO_TENANT, email: 'operator@demo.local', role: 'operator' },
  { id: 'a1111111-0000-4000-8000-000000000004', tenantId: DEMO_TENANT, email: 'support@demo.local', role: 'support' },
  { id: 'a1111111-0000-4000-8000-000000000005', tenantId: DEMO_TENANT, email: 'finance@demo.local', role: 'finance' },
  { id: 'a1111111-0000-4000-8000-000000000006', tenantId: DEMO_TENANT, email: 'partner@demo.local', role: 'partner' },
];

async function main(): Promise<void> {
  const url =
    process.env.MIGRATE_DATABASE_URL ??
    process.env.DATABASE_URL ??
    'postgresql://postgres:lp@localhost:55432/lp';
  const password = process.env.SEED_PASSWORD ?? 'Passw0rd!demo';
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    for (const u of USERS) {
      const existing = await client.query('select id from users where email = $1 limit 1', [
        u.email,
      ]);
      const passwordHash = hashPassword(password);
      if (existing.rows.length === 0) {
        await client.query(
          'insert into users (id, tenant_id, email, password_hash, status) values ($1,$2,$3,$4,\'active\')',
          [u.id, u.tenantId, u.email, passwordHash],
        );
        console.log(`seed: created ${u.email} (${u.role})`);
      } else {
        await client.query(
          "update users set password_hash = $2, status = 'active' where email = $1",
          [u.email, passwordHash],
        );
        console.log(`seed: updated ${u.email}`);
      }
      await client.query(
        'insert into user_roles (user_id, role_code) values ($1,$2) on conflict do nothing',
        [u.id, u.role],
      );
    }
    console.log(`seed: done. 密码为 ${password}(可用 SEED_PASSWORD 覆盖), 上线前请修改`);
  } finally {
    await client.end();
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('seed failed:', (e as Error).message);
    process.exit(1);
  });
