/**
 * 备份 / 恢复 / 演练 CLI(设计文档 §17 运维).
 *
 *   pnpm backup:create  -- --out ./data/backups/xxx [--keep 7]
 *   pnpm backup:verify  -- --dir ./data/backups/xxx
 *   pnpm backup:restore -- --dir ./data/backups/xxx --database lp_restore --confirm lp_restore
 *   pnpm backup:drill   -- [--database lp_drill]
 *
 * 连接参数从环境变量读取(MIGRATE_DATABASE_URL 优先), 与 migrate 保持一致.
 */
import { spawnSync } from 'node:child_process';
import { createDb, withSystemTx } from '@lp/db';
import fs from 'node:fs';
import path from 'node:path';
import {
  archiveDir,
  backupDirName,
  createBackup,
  diagnoseTools,
  restoreBackup,
  verifyAuditChains,
  verifyBackup,
  type BackupOptions,
  type PgExecutor,
} from './backup';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/**
 * 执行方式:
 *  - 未设 PG_CONTAINER: 用主机上的 psql/pg_dump
 *  - PG_CONTAINER=deploy-postgres-1: 通过 docker exec 在容器内执行(主机缺客户端时)
 * 容器内连自己的 PG 用 127.0.0.1:5432, 因此端口要换算.
 */
function executor(): PgExecutor {
  const c = process.env.PG_CONTAINER;
  return c ? { container: c } : 'local';
}

function conn(target: { database: string }): BackupOptions {
  const url =
    process.env.MIGRATE_DATABASE_URL ??
    process.env.DATABASE_URL ??
    'postgresql://postgres:lp@localhost:55432/lp';
  const u = new URL(url);
  const exec = executor();
  const inContainer = exec !== 'local';
  return {
    // 容器模式下执行的是容器内的客户端, 宿主名/端口都换成容器内视角
    host: inContainer ? '127.0.0.1' : u.hostname,
    port: Number(u.port || 5432),
    containerPort: 5432,
    user: decodeURIComponent(u.username || 'postgres'),
    password: decodeURIComponent(u.password || ''),
    database: target.database,
    outputDir: '',
    exec,
  };
}

function psqlExec(o: BackupOptions, sql: string, database = o.database): void {
  const inContainer = o.exec && o.exec !== 'local';
  const port = inContainer ? (o.containerPort ?? 5432) : o.port;
  const args = ['-h', o.host, '-p', String(port), '-U', o.user, '-d', database, '-v', 'ON_ERROR_STOP=1', '-c', sql];
  const r = inContainer
    ? spawnSync('docker', ['exec', '-i', (o.exec as { container: string }).container, 'psql', ...args], {
        env: { ...process.env, PGPASSWORD: o.password },
        encoding: 'utf8',
      })
    : spawnSync('psql', args, {
        env: { ...process.env, PGPASSWORD: o.password },
        encoding: 'utf8',
      });
  if (r.status !== 0) throw new Error(`psql 失败: ${r.stderr || r.error?.message}`);
}

function assertTools(): void {
  if (executor() !== 'local') return; // 容器模式不依赖主机客户端
  const problem = diagnoseTools();
  if (problem) {
    console.error(problem);
    console.error('提示: 可用容器内工具, 例如 docker exec deploy-postgres-1 pg_dump ...');
    process.exit(2);
  }
}

async function cmdCreate(): Promise<void> {
  assertTools();
  const base = conn({ database: arg('database', 'lp')! });
  const out = arg('out') ?? backupDirName(path.resolve('data/backups'));
  const keep = Number(arg('keep', '0'));
  const opts: BackupOptions = { ...base, outputDir: out, keep };
  console.log(`备份 ${opts.database} → ${out}`);
  const r = await createBackup(opts);
  console.log(`完成: ${r.manifest.rowCounts ? Object.keys(r.manifest.rowCounts).length : 0} 张表`);
  console.log(`  大小: ${r.manifest.databaseSizeBytes} bytes`);
  console.log(`  迁移: ${r.manifest.migrations.join(', ')}`);
  for (const w of r.warnings) console.log(`  ${w}`);

  const archived = archiveDir(out);
  console.log(`归档: ${archived.file} (${archived.bytes} bytes)`);
}

async function cmdVerify(): Promise<void> {
  const dir = arg('dir');
  if (!dir) {
    console.error('用法: pnpm backup:verify -- --dir <备份目录>');
    process.exit(1);
  }
  const r = await verifyBackup(dir);
  if (r.ok) {
    console.log(`校验通过: ${dir}`);
    console.log(`  备份时间: ${r.manifest?.createdAt}`);
    console.log(`  迁移: ${r.manifest?.migrations.join(', ')}`);
  } else {
    console.error('校验失败:');
    for (const p of r.problems) console.error(`  - ${p}`);
    process.exit(1);
  }
}

async function cmdRestore(): Promise<void> {
  assertTools();
  const dir = arg('dir');
  const database = arg('database');
  const confirm = arg('confirm');
  if (!dir || !database) {
    console.error(
      '用法: pnpm backup:restore -- --dir <备份目录> --database <目标空库> --confirm <同名确认>',
    );
    process.exit(1);
  }
  const base = conn({ database });
  console.log(`恢复 ${dir} → ${database}`);
  const r = await restoreBackup({ ...base, outputDir: dir, confirmDatabase: confirm ?? '' });
  if (r.ok) {
    console.log('恢复完成, 迁移版本与行数均与备份一致');
  } else {
    console.error('恢复完成但校验未通过:');
    for (const p of r.problems) console.error(`  - ${p}`);
    process.exit(1);
  }
}

/**
 * 一键演练: 备份 → 建临时库 → 恢复 → 比对 → (可选)审计链校验 → 删临时库.
 * 这是「备份能恢复」这一承诺的唯一可信证明; 定期跑它比看备份文件大小有意义得多.
 */
async function cmdDrill(): Promise<void> {
  assertTools();
  const source = arg('source', 'lp')!;
  const drillDb = arg('database', `lp_drill_${Date.now()}`)!;
  const root = path.resolve('data/backups');
  const dir = backupDirName(root);

  const base = conn({ database: source });
  console.log(`[1/5] 备份 ${source} → ${dir}`);
  const created = await createBackup({ ...base, outputDir: dir });
  console.log(`       ${Object.keys(created.manifest.rowCounts).length} 张表`);

  console.log(`[2/5] 校验备份完整性`);
  const verified = await verifyBackup(dir);
  if (!verified.ok) {
    console.error(`  失败: ${verified.problems.join('; ')}`);
    process.exit(1);
  }

  console.log(`[3/5] 创建临时库 ${drillDb}`);
  psqlExec(base, `drop database if exists "${drillDb}"`, 'postgres');
  psqlExec(base, `create database "${drillDb}"`, 'postgres');
  psqlExec(conn({ database: drillDb }), 'create extension if not exists pgcrypto', drillDb);

  let ok = false;
  try {
    console.log(`[4/5] 恢复到 ${drillDb} 并比对行数/迁移版本`);
    const target = conn({ database: drillDb });
    const r = await restoreBackup({ ...target, outputDir: dir, confirmDatabase: drillDb });
    ok = r.ok;
    if (r.ok) {
      console.log('       行数与迁移版本一致');
    } else {
      console.error('       不一致:');
      for (const p of r.problems) console.error(`         - ${p}`);
    }

    // 审计链: 行数对不代表链没断(备份/恢复若打乱顺序或丢行都会体现为断链)
    if (ok) {
      const chainOk = await checkAuditChains(drillDb);
      if (!chainOk) ok = false;
    }
  } finally {
    console.log(`[5/5] 清理临时库 ${drillDb}`);
    psqlExec(base, `drop database if exists "${drillDb}"`, 'postgres');
  }

  if (!ok) {
    console.error(`演练失败; 备份保留在 ${dir} (不自动删除, 用于排查)`);
    process.exit(1);
  }
  // 演练成功后默认清理, --keep-backup 保留用于人工检查
  if (!flag('keep-backup')) {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`演练通过, 临时备份已清理`);
  } else {
    console.log(`演练通过, 备份保留: ${dir}`);
  }
}

/** 在恢复后的库里重算每条审计链(tenant 级 + platform 级) */
async function checkAuditChains(database: string): Promise<boolean> {
  const url =
    process.env.MIGRATE_DATABASE_URL ??
    process.env.DATABASE_URL ??
    'postgresql://postgres:lp@localhost:55432/lp';
  const u = new URL(url);
  u.pathname = `/${database}`;
  const db = createDb(u.toString());
  try {
    const result = await withSystemTx(db, verifyAuditChains);
    for (const chain of result.chains) {
      if (!chain.valid) {
        console.error(
          `       审计链断裂: tenant=${chain.tenantId ?? 'platform'} at ${chain.brokenAtId}`,
        );
      }
    }
    console.log(
      result.ok
        ? `       审计链 ${result.checked} 条全部一致`
        : '       审计链校验未通过',
    );
    return result.ok;
  } finally {
    await db.destroy();
  }
}

async function main(): Promise<void> {
  const sub = process.argv[2];
  switch (sub) {
    case 'create':
      return cmdCreate();
    case 'verify':
      return cmdVerify();
    case 'restore':
      return cmdRestore();
    case 'drill':
      return cmdDrill();
    default:
      console.error(
        '用法: pnpm backup -- create|verify|restore|drill [选项]\n' +
          '  create  --out <dir> [--keep N] [--database lp]\n' +
          '  verify  --dir <dir>\n' +
          '  restore --dir <dir> --database <空库> --confirm <同名确认>\n' +
          '  drill   [--source lp] [--database lp_drill] [--keep-backup]',
      );
      process.exit(1);
  }
}

void main();
