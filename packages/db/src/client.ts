import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import type { LpDb } from './types';

export interface CreateDbOptions {
  max?: number;
  statementTimeoutMs?: number;
}

export function createDb(url: string, opts: CreateDbOptions = {}): Kysely<LpDb> {
  const pool = new Pool({
    connectionString: url,
    max: opts.max ?? 10,
    statement_timeout: opts.statementTimeoutMs ?? 10000,
    application_name: 'license-platform',
  });
  // 空闲连接被服务端终止(重启/故障切换)时避免未处理 error 事件击穿进程
  pool.on('error', (e) => {
    console.error('[pg pool] idle client error:', e.message);
  });
  return new Kysely<LpDb>({ dialect: new PostgresDialect({ pool }) });
}
