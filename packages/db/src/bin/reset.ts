/**
 * 数据重置 CLI: 清空全部业务数据与账号，只保留平台管理员。
 *
 * 用途: 从旧的两级模型(单租户管理台 + super_admin)切换到新模型时的一次性清理，
 *       或演示环境重置。**不可撤销**，因此必须显式带 --yes。
 *
 * 用法:
 *   pnpm db:reset --yes
 *   pnpm db:reset --yes --keep-tenants     # 只清业务数据，保留租户与账号
 *
 * 注意: 不清空 lp_schema_migrations —— 迁移版本必须保留，否则会和实际 schema 错配。
 */
import { Client } from 'pg';

/** 业务表(按依赖从叶到根)；TRUNCATE ... CASCADE 会连带清理引用方 */
const BUSINESS_TABLES = [
  'webhook_deliveries',
  'webhook_endpoints',
  'notifications_outbox',
  'export_jobs',
  'renewals',
  'revocation_requests',
  'idempotency_keys',
  'client_tokens',
  'refresh_tokens',
  'license_activations',
  'devices',
  'licenses',
  'license_batches',
  'policies',
  'product_features',
  'product_versions',
  'products',
  'channels',
  'end_customers',
  'api_keys',
  'audit_events',
  'events',
];

async function main(): Promise<void> {
  const confirmed = process.argv.includes('--yes');
  const keepTenants = process.argv.includes('--keep-tenants');
  if (!confirmed) {
    console.error('拒绝执行: 这是不可撤销的数据清空操作。确认请加 --yes');
    console.error('  pnpm db:reset --yes [--keep-tenants]');
    process.exit(1);
  }

  const url =
    process.env.MIGRATE_DATABASE_URL ??
    process.env.DATABASE_URL ??
    'postgresql://postgres:lp@localhost:55432/lp';
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('BEGIN');
    const tables = keepTenants ? BUSINESS_TABLES : [...BUSINESS_TABLES, 'user_roles', 'users', 'tenants'];
    await client.query(`TRUNCATE TABLE ${tables.join(', ')} RESTART IDENTITY CASCADE`);
    await client.query('COMMIT');
    console.log(`reset: 已清空 ${tables.length} 张表`);
    console.log(
      keepTenants
        ? 'reset: 租户与账号保留'
        : 'reset: 账号已清空，请执行 pnpm seed:users 重建平台管理员',
    );
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await client.end();
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('reset failed:', (e as Error).message);
    process.exit(1);
  });
