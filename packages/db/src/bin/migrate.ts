/**
 * 迁移 CLI. 故意不依赖 @lp/config: 允许在 build 之前用 tsx 直接执行.
 * 用法: tsx packages/db/src/bin/migrate.ts [up|down]
 */
import { runMigrations } from '../migrate';

async function main(): Promise<void> {
  const direction = process.argv[2] === 'down' ? 'down' : 'up';
  const url =
    process.env.MIGRATE_DATABASE_URL ??
    process.env.DATABASE_URL ??
    'postgresql://postgres:lp@localhost:55432/lp';
  const dir = process.env.MIGRATIONS_DIR ?? 'db/migrations';
  try {
    const changed = await runMigrations({ url, dir, direction });
    console.log(
      direction === 'up'
        ? `done. applied ${changed.length} migration(s).`
        : `done. rolled back ${changed.length} migration(s).`,
    );
    process.exit(0);
  } catch (e) {
    console.error(`migrate failed: ${(e as Error).message}`);
    process.exit(1);
  }
}

void main();
