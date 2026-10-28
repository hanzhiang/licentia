/**
 * 存量迁移 CLI(设计文档 §7.3): pnpm migrate:legacy -- --sqlite /path/legacy.db [--dry-run] [--tenant-code legacy]
 */
import { createDb } from '@lp/db';
import { migrateLegacy } from './migrate';

async function main(): Promise<void> {
  const idx = process.argv.indexOf('--sqlite');
  const sqlitePath = idx >= 0 ? process.argv[idx + 1] : undefined;
  if (!sqlitePath) {
    console.error('用法: pnpm migrate:legacy -- --sqlite <legacy.db> [--dry-run] [--tenant-code legacy]');
    process.exit(1);
  }
  const dryRun = process.argv.includes('--dry-run');
  const tenantIdx = process.argv.indexOf('--tenant-code');
  const tenantCode = tenantIdx >= 0 ? process.argv[tenantIdx + 1] : 'legacy';

  const db = createDb(
    process.env.MIGRATE_DATABASE_URL ??
      process.env.DATABASE_URL ??
      'postgresql://postgres:lp@localhost:55432/lp',
  );
  try {
    const report = await migrateLegacy({ sqlitePath, tenantCode, dryRun, db });
    console.log('==== 迁移报告 ====');
    console.log(JSON.stringify(report, null, 2));
    if (report.skipped.length > 0) {
      console.warn(`警告: ${report.skipped.length} 行被跳过, 详见上方 skipped`);
    }
  } finally {
    await db.destroy();
  }
}

void main();
