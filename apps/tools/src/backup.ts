import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { verifyChain, type ChainVerifyResult } from '@lp/audit';
import type { LpTx } from '@lp/db';

/**
 * 备份 / 恢复工具(设计文档 §17 运维).
 *
 * 设计要点:
 *  - 用 pg_dump 自定义格式(-Fc): 可选择性恢复单表, 自带完整性校验, 支持并行恢复
 *  - 角色不是数据库数据: pg_dump 不导出 lp_app 角色, 恢复后连接会直接失败.
 *    因此另存一份 roles.sql, 恢复时先建角色再还原数据
 *  - 迁移版本单独落盘: 恢复后必须与备份时的版本完全一致, 否则 schema 与数据错配
 *  - 每个备份目录带 manifest.json(数据库大小、表行数、迁移版本、文件 sha256),
 *    恢复前用它校验文件完整性, 恢复后再与实际库比对
 *  - 从不覆盖已有备份目录; --keep 控制保留份数
 */

export interface BackupManifest {
  version: 1;
  createdAt: string;
  database: string;
  pgVersion: string;
  migrations: string[];
  /** 各表行数(按 pg_stat_user_tables 估算前先 ANALYZE, 这里用精确 count) */
  rowCounts: Record<string, number>;
  /** lp_app 的表级授权数: 恢复后必须一致, 否则应用连不上任何表 */
  appGrants: number;
  databaseSizeBytes: number;
  files: Record<string, { bytes: number; sha256: string }>;
}

export interface BackupOptions {
  host: string;
  /** 主机端口; 容器模式下自动转换为容器内端口 */
  port: number;
  user: string;
  password: string;
  database: string;
  outputDir: string;
  /** 默认 'local'; 指定容器组时走 docker exec */
  exec?: PgExecutor;
  /** 容器内 PG 端口(容器模式); 默认 5432 */
  containerPort?: number;
  /** 保留最近 N 份(含本次); 0 = 不清理 */
  keep?: number;
}

export interface BackupResult {
  dir: string;
  manifest: BackupManifest;
  warnings: string[];
}

const DUMP_FILE = 'database.dump';
const ROLES_FILE = 'roles.sql';
const MANIFEST_FILE = 'manifest.json';

function sha256File(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * pg 客户端执行方式:
 *  - 'local': 主机已安装 postgresql-client
 *  - container 名: 通过 `docker exec` 在容器内执行(主机无客户端时的常见场景)
 */
export type PgExecutor = 'local' | { container: string };

function runWith(
  exec: PgExecutor,
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  input?: string,
): Promise<RunResult> {
  if (exec === 'local') return run(bin, args, env, input);
  // 容器内网络是 localhost:<container port>, 参数由调用方按容器视角传入
  return run('docker', ['exec', '-i', exec.container, bin, ...args], env, input);
}

function portFor(opts: BackupOptions): number {
  return opts.exec && opts.exec !== 'local' ? (opts.containerPort ?? 5432) : opts.port;
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, input?: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    if (input !== undefined) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

async function psql(opts: BackupOptions, sql: string, db = opts.database): Promise<string> {
  const r = await runWith(
    opts.exec ?? 'local',
    'psql',
    [
      '-h', opts.host,
      '-p', String(portFor(opts)),
      '-U', opts.user,
      '-d', db,
      '-tAF', '\t',
      '-v', 'ON_ERROR_STOP=1',
      '-c', sql,
    ],
    { PGPASSWORD: opts.password },
  );
  if (r.code !== 0) throw new Error(`psql 失败: ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * 生成角色 SQL: 只导出应用自建角色(排除内置 pg_* 与当前管理员角色).
 * 必须导出 rolpassword(SCRAM hash): 异机恢复时仅 CREATE ROLE 会得到一个无口令账号,
 * lp_app 能连上库却无法认证 —— 这类问题在同机演练里永远暴露不出来.
 */
export function buildRolesSql(rows: string): string {
  const lines = rows
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const stmts: string[] = [];
  const grants: string[] = [];
  for (const line of lines) {
    const [rolname, canlogin, bypassrls, issuper, rolconnlimit, rolpassword] = line.split('\t');
    if (!rolname || rolname.startsWith('pg_')) continue;
    if (rolname === 'postgres') continue;
    const ident = quoteIdent(rolname);
    const attrs = [
      canlogin === 't' ? 'LOGIN' : 'NOLOGIN',
      bypassrls === 't' ? 'BYPASSRLS' : 'NOBYPASSRLS',
      issuper === 't' ? 'SUPERUSER' : 'NOSUPERUSER',
    ];
    stmts.push(
      `do $$ begin\n` +
        `  if not exists (select from pg_roles where rolname = ${quoteLiteral(rolname)}) then\n` +
        `    create role ${ident} ${attrs.join(' ')};\n` +
        `  end if;\n` +
        `end $$;`,
    );
    // pg_roles 会把口令显示为 ********; 绝不能把掩码写进恢复脚本(那会真的改坏口令)
    if (rolpassword && rolpassword !== '\\N' && rolpassword !== '********') {
      stmts.push(`alter role ${ident} password ${quoteLiteral(rolpassword)};`);
    }
    const limit = Number(rolconnlimit);
    if (Number.isFinite(limit) && limit >= 0) {
      grants.push(`alter role ${ident} connection limit ${limit};`);
    }
  }
  return ['-- 应用角色(pg_dump 不导出角色, 恢复时必须先建)', ...stmts, ...grants].join('\n') + '\n';
}

/**
 * 精确行数.
 * 注意 relkind: 'r' 是普通表, 'p' 是分区父表. 父表上的 count(*) 会汇总所有分区,
 * 正是我们想要的; 若只取 'r' 会漏掉 audit_events(分区表) —— 那恰恰是最关键的审计数据.
 * 分区子表(relispartition)单独跳过, 否则同一批行会被数两遍.
 */
/**
 * 应用角色授权数.
 * 恢复时用 --no-owner --no-privileges 是为了避免「对象属主」恢复成备份机的角色;
 * 但代价是 GRANT 也一并丢失 —— 恢复出来的库里 lp_app 是个没有表权限的空角色,
 * 服务启动后所有查询都会 permission denied. 所以必须显式重放授权并纳入校验.
 */
async function countAppGrants(opts: BackupOptions): Promise<number> {
  const out = await psql(
    opts,
    `select count(*) from information_schema.role_table_grants where grantee = 'lp_app'`,
  );
  return Number(out.trim());
}

async function collectRowCounts(opts: BackupOptions): Promise<Record<string, number>> {
  const tables = await psql(
    opts,
    `select c.relname from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r','p')
        and not c.relispartition
      order by c.relname`,
  );
  const counts: Record<string, number> = {};
  for (const t of tables.split('\n').map((s) => s.trim()).filter(Boolean)) {
    const out = await psql(opts, `select count(*) from "${t}"`);
    counts[t] = Number(out.trim());
  }
  return counts;
}

export async function createBackup(opts: BackupOptions): Promise<BackupResult> {
  if (fs.existsSync(opts.outputDir) && fs.readdirSync(opts.outputDir).length > 0) {
    throw new Error(`备份目录非空, 拒绝覆盖: ${opts.outputDir}`);
  }
  fs.mkdirSync(opts.outputDir, { recursive: true });
  const warnings: string[] = [];
  const env = { PGPASSWORD: opts.password };

  const pgVersion = (await psql(opts, 'show server_version')).trim();
  const migrations = (
    await psql(opts, 'select version from lp_schema_migrations order by version')
  )
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  // 1. 角色
  const rolesRows = await psql(
    opts,
    `select r.rolname, r.rolcanlogin, r.rolbypassrls, r.rolsuper, r.rolconnlimit,
            a.rolpassword
       from pg_roles r
       join pg_authid a on a.oid = r.oid
      order by r.rolname`,
  );
  fs.writeFileSync(path.join(opts.outputDir, ROLES_FILE), buildRolesSql(rolesRows));

  // 2. 数据(pg_dump 自定义格式)
  const dumpPath = path.join(opts.outputDir, DUMP_FILE);
  const inContainer = opts.exec !== undefined && opts.exec !== 'local';
  // 容器模式: pg_dump 写在容器内, 结束后 docker cp 取回主机
  const dumpTarget = inContainer ? `/tmp/${crypto.randomUUID()}.dump` : dumpPath;
  const dump = await runWith(
    opts.exec ?? 'local',
    'pg_dump',
    [
      '-h', opts.host,
      '-p', String(portFor(opts)),
      '-U', opts.user,
      '-d', opts.database,
      '-Fc',
      '--no-owner',
      '--no-privileges',
      '-f', dumpTarget,
    ],
    env,
  );
  if (dump.code !== 0) {
    throw new Error(`pg_dump 失败: ${dump.stderr.trim()}`);
  }
  if (inContainer) {
    const container = (opts.exec as { container: string }).container;
    const cp = await run('docker', ['cp', `${container}:${dumpTarget}`, dumpPath], {});
    await run('docker', ['exec', container, 'rm', '-f', dumpTarget], {});
    if (cp.code !== 0) throw new Error(`docker cp 失败: ${cp.stderr.trim()}`);
  }

  // 3. 行数(恢复后比对的基准)
  const rowCounts = await collectRowCounts(opts);

  const sizeOut = (await psql(opts, 'select pg_database_size(current_database())')).trim();
  const appGrants = await countAppGrants(opts);
  const manifest: BackupManifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    database: opts.database,
    pgVersion,
    migrations,
    rowCounts,
    appGrants,
    databaseSizeBytes: Number(sizeOut),
    files: {},
  };
  for (const f of [DUMP_FILE, ROLES_FILE]) {
    const p = path.join(opts.outputDir, f);
    manifest.files[f] = { bytes: fs.statSync(p).size, sha256: sha256File(p) };
  }
  fs.writeFileSync(path.join(opts.outputDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2));

  // 4. 保留策略
  const keep = opts.keep ?? 0;
  if (keep > 0) {
    const parent = path.dirname(opts.outputDir);
    const siblings = fs
      .readdirSync(parent)
      .filter((d) => path.join(parent, d) !== opts.outputDir)
      .filter((d) => fs.existsSync(path.join(parent, d, MANIFEST_FILE)))
      .map((d) => path.join(parent, d))
      .sort()
      .reverse();
    for (const old of siblings.slice(keep - 1)) {
      fs.rmSync(old, { recursive: true, force: true });
      warnings.push(`已清理旧备份: ${old}`);
    }
  }

  return { dir: opts.outputDir, manifest, warnings };
}

export interface VerifyResult {
  ok: boolean;
  problems: string[];
  manifest?: BackupManifest;
}

/** 校验备份目录自身完整性与迁移版本是否与当前库一致 */
export async function verifyBackup(
  dir: string,
  currentMigrations?: string[],
): Promise<VerifyResult> {
  const problems: string[] = [];
  const manifestPath = path.join(dir, MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, problems: [`缺少 ${MANIFEST_FILE}`] };
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as BackupManifest;

  for (const [name, meta] of Object.entries(manifest.files)) {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) {
      problems.push(`缺少文件: ${name}`);
      continue;
    }
    const bytes = fs.statSync(p).size;
    if (bytes !== meta.bytes) problems.push(`${name} 大小不符: ${bytes} != ${meta.bytes}`);
    const digest = sha256File(p);
    if (digest !== meta.sha256) problems.push(`${name} sha256 不符`);
  }

  if (currentMigrations) {
    const a = [...manifest.migrations].sort().join(',');
    const b = [...currentMigrations].sort().join(',');
    if (a !== b) {
      problems.push(`迁移版本不一致: 备份=[${a}] 当前=[${b}]`);
    }
  }
  return { ok: problems.length === 0, problems, manifest };
}

export interface RestoreOptions extends BackupOptions {
  /** 目标库必须为空库(除 extension); 由调用方保证 */
  confirmDatabase: string;
}

export interface AuditChainSummary {
  ok: boolean;
  checked: number;
  /** 每个租户(platform 链用 null)的验链结果 */
  chains: Array<ChainVerifyResult & { tenantId: string | null }>;
}

/**
 * 在给定事务内校验全部审计链.
 * 行数一致不代表链完整: 备份或恢复若丢失/篡改任意一条, 后续 prev_hash 会立刻失配.
 * 接受 LpTx 便于测试在事务里篡改后校验, 再抛错回滚, 不污染开发库.
 */
export async function verifyAuditChains(tx: LpTx): Promise<AuditChainSummary> {
  const tenants = await tx
    .selectFrom('audit_events')
    .select('tenant_id')
    .distinct()
    .orderBy('tenant_id')
    .execute();
  const chains: AuditChainSummary['chains'] = [];
  let checked = 0;
  let ok = true;
  for (const { tenant_id: tenantId } of tenants) {
    const result = await verifyChain(tx, tenantId);
    chains.push({ ...result, tenantId });
    checked += result.checked;
    if (!result.valid) ok = false;
  }
  return { ok, checked, chains };
}

/**
 * 恢复: 建角色 → pg_restore → 校验迁移版本与行数.
 * 故意不做「自动重建数据库」——那会静默清掉目标库, 必须由操作者显式创建空库.
 */
export async function restoreBackup(opts: RestoreOptions): Promise<VerifyResult> {
  if (opts.confirmDatabase !== opts.database) {
    throw new Error('确认的数据库名与目标不一致, 拒绝执行');
  }
  const verified = await verifyBackup(opts.outputDir);
  if (!verified.ok) throw new Error(`备份校验失败: ${verified.problems.join('; ')}`);
  const manifest = verified.manifest!;

  const env = { PGPASSWORD: opts.password };

  // 1. 角色(必须先于数据, 否则对象属主无法解析)
  const rolesSql = fs.readFileSync(path.join(opts.outputDir, ROLES_FILE), 'utf8');
  const roles = await runWith(
    opts.exec ?? 'local',
    'psql',
    ['-h', opts.host, '-p', String(portFor(opts)), '-U', opts.user, '-d', opts.database,
     '-v', 'ON_ERROR_STOP=1', '-f', '-'],
    env,
    rolesSql,
  );
  if (roles.code !== 0) throw new Error(`角色恢复失败: ${roles.stderr.trim()}`);

  // 2. 数据
  const inContainer = opts.exec !== undefined && opts.exec !== 'local';
  const localDump = path.join(opts.outputDir, DUMP_FILE);
  let restoreArg = localDump;
  let containerDump: string | null = null;
  if (inContainer) {
    const container = (opts.exec as { container: string }).container;
    containerDump = `/tmp/${crypto.randomUUID()}.dump`;
    const cp = await run('docker', ['cp', localDump, `${container}:${containerDump}`], {});
    if (cp.code !== 0) throw new Error(`docker cp 失败: ${cp.stderr.trim()}`);
    restoreArg = containerDump;
  }
  const restore = await runWith(
    opts.exec ?? 'local',
    'pg_restore',
    ['-h', opts.host, '-p', String(portFor(opts)), '-U', opts.user, '-d', opts.database,
     '--no-owner', '--no-privileges', '--exit-on-error', restoreArg],
    env,
  );
  if (containerDump && inContainer) {
    await run('docker', ['exec', (opts.exec as { container: string }).container, 'rm', '-f', containerDump], {});
  }
  if (restore.code !== 0) throw new Error(`pg_restore 失败: ${restore.stderr.trim()}`);

  // 3. 重放应用角色授权(见 countAppGrants 注释: --no-privileges 会丢掉它们)
  const grantSql = [
    'grant usage on schema public to lp_app;',
    'grant select, insert, update, delete on all tables in schema public to lp_app;',
    'grant usage, select on all sequences in schema public to lp_app;',
    'alter default privileges in schema public grant select, insert, update, delete on tables to lp_app;',
    'alter default privileges in schema public grant usage, select on sequences to lp_app;',
  ].join('\n');
  const grants = await runWith(
    opts.exec ?? 'local',
    'psql',
    ['-h', opts.host, '-p', String(portFor(opts)), '-U', opts.user, '-d', opts.database,
     '-v', 'ON_ERROR_STOP=1', '-f', '-'],
    env,
    grantSql,
  );
  if (grants.code !== 0) throw new Error(`授权重放失败: ${grants.stderr.trim()}`);

  // 4. 校验
  const problems: string[] = [];
  const restoredGrants = await countAppGrants(opts);
  if (manifest.appGrants > 0 && restoredGrants !== manifest.appGrants) {
    problems.push(`lp_app 授权数不符: 备份=${manifest.appGrants} 恢复后=${restoredGrants}`);
  }
  const migrations = (await psql(opts, 'select version from lp_schema_migrations order by version'))
    .split('\n').map((s) => s.trim()).filter(Boolean);
  const a = [...manifest.migrations].sort().join(',');
  const b = [...migrations].sort().join(',');
  if (a !== b) problems.push(`迁移版本不一致: 备份=[${a}] 恢复后=[${b}]`);

  const counts = await collectRowCounts(opts);
  for (const [table, expected] of Object.entries(manifest.rowCounts)) {
    const actual = counts[table];
    if (actual === undefined) {
      problems.push(`表缺失: ${table}`);
    } else if (actual !== expected) {
      problems.push(`行数不符 ${table}: 备份=${expected} 恢复后=${actual}`);
    }
  }
  return { ok: problems.length === 0, problems, manifest };
}

/** 用于测试/演练: 生成时间戳目录名 */
export function backupDirName(root: string, now: Date = new Date()): string {
  const ts = now.toISOString().replace(/[:.]/g, '-').replace('Z', '');
  return path.join(root, `backup-${ts}`);
}

/** pg_dump 等工具不在 PATH 时的友好提示 */
export function diagnoseTools(): string | null {
  const missing: string[] = [];
  for (const bin of ['pg_dump', 'pg_restore', 'psql']) {
    const found = (process.env.PATH ?? '')
      .split(path.delimiter)
      .some((d) => {
        try {
          return fs.existsSync(path.join(d, bin + (os.platform() === 'win32' ? '.exe' : '')));
        } catch {
          return false;
        }
      });
    if (!found && !fs.existsSync(bin)) missing.push(bin);
  }
  return missing.length === 0 ? null : `未找到: ${missing.join(', ')} (需 PostgreSQL 客户端工具)`;
}

/** 供演练: 打包备份目录(异地归档的最小可用单元) */
export function archiveDir(dir: string, outFile?: string): { file: string; bytes: number } {
  const file = outFile ?? `${dir}.tar.gz`;
  const r = spawnSync('tar', ['-czf', file, '-C', path.dirname(dir), path.basename(dir)], {
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`tar 打包失败: ${r.stderr || r.error?.message}`);
  return { file, bytes: fs.statSync(file).size };
}
