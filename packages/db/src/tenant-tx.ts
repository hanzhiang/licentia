import { Kysely, sql, Transaction } from 'kysely';
import type { LpDb } from './types';

export type LpTx = Transaction<LpDb>;

/** 事务级设置租户上下文(GUC), 事务结束自动清空, 与 pgbouncer transaction pool 兼容 */
export async function setTenantGuc(tx: LpTx, tenantId: string): Promise<void> {
  await sql`select set_config('app.tenant_id', ${tenantId}, true)`.execute(tx);
}

export async function setBypassRls(tx: LpTx, on: boolean): Promise<void> {
  await sql`select set_config('app.bypass_rls', ${on ? 'on' : 'off'}, true)`.execute(tx);
}

/** 租户读写唯一入口: RLS 策略按 app.tenant_id 过滤, 应用层忘加 WHERE 也不会跨租户 */
export async function withTenantTx<T>(
  db: Kysely<LpDb>,
  tenantId: string,
  fn: (tx: LpTx) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (tx) => {
    await setTenantGuc(tx, tenantId);
    return fn(tx);
  });
}

/**
 * 系统事务(绕过 RLS): 仅用于
 *  1) 客户端按码全局查找 license(找到后立刻切回租户上下文)
 *  2) worker/对账任务
 *  3) 幂等键表操作
 */
export async function withSystemTx<T>(
  db: Kysely<LpDb>,
  fn: (tx: LpTx) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (tx) => {
    await setBypassRls(tx, true);
    return fn(tx);
  });
}
