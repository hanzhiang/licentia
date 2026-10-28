import { createHash } from 'node:crypto';
import { Kysely } from 'kysely';
import { AppError, errIdempotencyConflict, errIdempotencyInProgress } from '@lp/domain';
import { withSystemTx, type LpDb, type LpTx } from '@lp/db';

export interface IdempotencyParams {
  tenantId: string;
  key: string;
  endpoint: string;
  requestBody?: unknown;
  ttlHours?: number;
}

export interface IdempotentResult<T> {
  status: number;
  body: T;
  replayed: boolean;
}

const STALE_LOCK_MS = 10 * 60 * 1000;

/**
 * 写接口幂等(设计文档 §13.1):
 *  - 首次: 占位(processing) -> 执行业务 -> 记录响应(默认 24h)
 *  - 重放: 同 key 同体 -> 返回首次响应(replayed=true)
 *  - 冲突: 同 key 不同体 -> 409 IDEMPOTENCY_CONFLICT
 *  - 在途/失败/陈旧锁: 409 IDEMPOTENCY_IN_PROGRESS(客户端退避重试即重新占位)
 * 注意: 幂等行与业务写分属两个事务(骨架取舍), 状态机+唯一约束兜底保证重复请求最终正确.
 */
export async function withIdempotency<T>(
  db: Kysely<LpDb>,
  params: IdempotencyParams,
  fn: () => Promise<{ status: number; body: T }>,
): Promise<IdempotentResult<T>> {
  const requestHash = createHash('sha256')
    .update(JSON.stringify(params.requestBody ?? null))
    .digest();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (params.ttlHours ?? 24) * 3_600_000);

  return withSystemTx(db, async (tx: LpTx) => {
    const inserted = await tx
      .insertInto('idempotency_keys')
      .values({
        tenant_id: params.tenantId,
        idem_key: params.key,
        endpoint: params.endpoint,
        request_hash: requestHash,
        status: 'processing',
        locked_at: now,
        expires_at: expiresAt,
      })
      .onConflict((oc) => oc.columns(['tenant_id', 'idem_key']).doNothing())
      .returningAll()
      .executeTakeFirst();

    if (inserted) {
      try {
        const r = await fn();
        await tx
          .updateTable('idempotency_keys')
          .set({
            status: 'completed',
            http_status: r.status,
            response: r.body as Record<string, unknown>,
          })
          .where('tenant_id', '=', params.tenantId)
          .where('idem_key', '=', params.key)
          .execute();
        return { ...r, replayed: false };
      } catch (e) {
        await tx
          .updateTable('idempotency_keys')
          .set({ status: 'failed' })
          .where('tenant_id', '=', params.tenantId)
          .where('idem_key', '=', params.key)
          .execute();
        throw e;
      }
    }

    const existing = await tx
      .selectFrom('idempotency_keys')
      .selectAll()
      .where('tenant_id', '=', params.tenantId)
      .where('idem_key', '=', params.key)
      .executeTakeFirst();
    if (!existing) throw new AppError('INTERNAL_ERROR', 'idempotency row disappeared');
    if (!existing.request_hash.equals(requestHash)) {
      throw errIdempotencyConflict('same key used with different request body');
    }
    if (existing.status === 'completed' && existing.response !== null) {
      return {
        status: existing.http_status ?? 200,
        body: existing.response as T,
        replayed: true,
      };
    }
    throw errIdempotencyInProgress();
  });
}
