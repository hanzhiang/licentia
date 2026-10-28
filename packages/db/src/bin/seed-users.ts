/**
 * 种子账号 CLI(幂等): 只创建平台管理员。
 *
 * 两级模型下不再预置开发者账号 —— 开发者通过 `POST /admin/v1/auth/register` 自助注册，
 * 注册时自动创建租户并成为该租户的 developer_owner。
 *
 * 用法: pnpm seed:users   (密码取 SEED_PASSWORD, 默认 Passw0rd!demo)
 */
import { Client } from 'pg';
import { hashPassword } from '@lp/auth';

interface SeedUser {
  id: string;
  email: string;
  role: string;
}

const USERS: SeedUser[] = [
  {
    id: 'a1111111-0000-4000-8000-000000000001',
    email: 'admin@lp.local',
    role: 'platform_admin',
  },
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
          "insert into users (id, tenant_id, email, password_hash, status, email_verified_at) values ($1,null,$2,$3,'active',now())",
          [u.id, u.email, passwordHash],
        );
        console.log(`seed: created ${u.email} (${u.role})`);
      } else {
        await client.query(
          "update users set password_hash = $2, status = 'active', tenant_id = null, email_verified_at = coalesce(email_verified_at, now()) where email = $1",
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
    console.log('seed: 开发者账号请通过 POST /admin/v1/auth/register 自助注册');
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
