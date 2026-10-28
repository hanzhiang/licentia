/**
 * 审计分区补齐 CLI: 保证 audit_events 有当前月及未来 N 个月的分区。
 *
 * 为什么需要: audit_events 按月分区, 分区不存在时对应的写入会直接失败 ——
 * 而几乎所有写操作都要写审计, 等于整站不可写. 用 MIGRATE_DATABASE_URL(超级用户)
 * 执行, 因为建表需要 schema 上的 CREATE 权限, 应用角色 lp_app 没有.
 *
 * 用法: pnpm db:partitions [--months 12]
 */
import { Client } from 'pg';

function monthName(y: number, m: number): string {
  return `audit_events_${y}_${String(m).padStart(2, '0')}`;
}

function addMonths(y: number, m: number, delta: number): [number, number] {
  const idx = y * 12 + (m - 1) + delta;
  return [Math.floor(idx / 12), (idx % 12) + 1];
}

function iso(y: number, m: number): string {
  return `${y}-${String(m).padStart(2, '0')}-01`;
}

async function main(): Promise<void> {
  const idx = process.argv.indexOf('--months');
  const months = idx >= 0 ? Math.max(1, Number(process.argv[idx + 1] ?? 12)) : 12;
  const url =
    process.env.MIGRATE_DATABASE_URL ??
    process.env.DATABASE_URL ??
    'postgresql://postgres:lp@localhost:55432/lp';

  const now = new Date();
  const baseY = now.getUTCFullYear();
  const baseM = now.getUTCMonth() + 1;

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    for (let i = 0; i < months; i++) {
      const [y, m] = addMonths(baseY, baseM, i);
      const [ny, nm] = addMonths(y, m, 1);
      const name = monthName(y, m);
      await client.query(
        `create table if not exists ${name} partition of audit_events
           for values from ('${iso(y, m)}') to ('${iso(ny, nm)}')`,
      );
      console.log(`partition ok: ${name}`);
    }
    console.log(`db:partitions 完成 — 覆盖 ${iso(baseY, baseM)} 起 ${months} 个月`);
  } finally {
    await client.end();
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('db:partitions failed:', (e as Error).message);
    process.exit(1);
  });
