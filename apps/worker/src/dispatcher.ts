import crypto from 'node:crypto';
import { Kysely, sql } from 'kysely';
import { LpDb, withSystemTx } from '@lp/db';
import { decryptAead } from '@lp/keygen';
import {  getConfig, log } from '@lp/config';
import { recordFailureAndMaybeTrip, recordSuccess } from './breaker';

/**
 * Webhook 投递器(设计文档 §4.8): HMAC-SHA256 签名 + 退避重试(1m/5m/30m/2h/6h/12h) + 死信.
 * 端点级熔断见 breaker.ts: 窗口失败率超阈值即停投, 冷却后再试.
 * 多副本安全: 取待投递行时用 FOR UPDATE SKIP LOCKED 原子领取, 并顺延 next_retry_at
 * 作为租约(进程崩溃后最多等 2 分钟重试), 否则两个 worker 会重复投递同一条.
 */
const RETRY_SCHEDULE_SEC = [60, 300, 1800, 7200, 21600, 43200];
const TIMEOUT_MS = 5000;

export interface DispatchSummary {
  processed: number;
  success: number;
  failed: number;
  dead: number;
}

export async function dispatchOnce(db: Kysely<LpDb>): Promise<DispatchSummary> {
  // 原子领取: 一步完成"挑出到期行 + 加锁 + 顺延租约", 多个 worker 不会拿到同一批
  const claimed = await withSystemTx(db, (tx) =>
    sql<{ id: string }>`
      update webhook_deliveries d
         set next_retry_at = now() + interval '2 minutes'
       where d.id in (
         select id from webhook_deliveries
          where status = 'pending'
            and next_retry_at is not null
            and next_retry_at <= now()
          order by created_at asc
          limit 20
          for update skip locked
       )
      returning d.id
    `.execute(tx),
  );
  const due = claimed.rows;
  const summary: DispatchSummary = { processed: due.length, success: 0, failed: 0, dead: 0 };
  for (const d of due) {
    const outcome = await deliverOne(db, d.id);
    if (outcome === 'success') summary.success++;
    else if (outcome === 'dead') summary.dead++;
    else summary.failed++;
  }
  return summary;
}

async function deliverOne(
  db: Kysely<LpDb>,
  deliveryId: string,
): Promise<'success' | 'failed' | 'dead'> {
  const cfg = getConfig();
  const d = await withSystemTx(db, (tx) =>
    tx.selectFrom('webhook_deliveries').selectAll().where('id', '=', deliveryId).executeTakeFirst(),
  );
  if (!d) return 'dead';
  const ep = await withSystemTx(db, (tx) =>
    tx.selectFrom('webhook_endpoints').selectAll().where('id', '=', d.endpoint_id).executeTakeFirst(),
  );

  let error = '';
  let responseStatus: number | null = null;
  if (!ep || ep.status !== 'active' || ep.deleted_at !== null) {
    error = 'endpoint removed or disabled';
  } else {
    try {
      const secret = decryptAead(cfg.WEBHOOK_ENC_KEY, ep.secret_cipher);
      const body = JSON.stringify({
        event_id: d.event_id,
        type: d.event_type,
        occurred_at: d.created_at.toISOString(),
        data: d.payload,
      });
      const t = Math.floor(Date.now() / 1000);
      const sig = crypto
        .createHmac('sha256', secret)
        .update(`${t}.${body}`, 'utf8')
        .digest('hex');
      const res = await fetch(ep.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-lp-event': d.event_type,
          'x-lp-delivery-id': d.id,
          'x-lp-signature': `t=${t},v1=${sig}`,
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      responseStatus = res.status;
      if (!res.ok) error = `http ${res.status}`;
      // 消费方应读 body 后立即丢弃; 这里不缓冲
      void res.arrayBuffer().catch(() => undefined);
    } catch (e) {
      error = (e as Error).message.slice(0, 300);
    }
  }

  const success = error === '';
  const attempt = d.attempt + 1;
  const dead = !success && attempt >= RETRY_SCHEDULE_SEC.length;
  await withSystemTx(db, (tx) =>
    tx
      .updateTable('webhook_deliveries')
      .set({
        attempt,
        status: success ? 'success' : dead ? 'dead' : 'pending',
        next_retry_at: success
          ? null
          : dead
            ? null
            : new Date(Date.now() + RETRY_SCHEDULE_SEC[attempt - 1]! * 1000),
        response_status: responseStatus,
        last_error: success ? null : error,
        updated_at: new Date(),
      })
      .where('id', '=', d.id)
      .execute(),
  );
  if (success) {
    await recordSuccess(db, d.endpoint_id);
  } else {
    log.warn(
      `[webhook] delivery ${d.id} attempt=${attempt} ${dead ? 'DEAD' : 'retry'} ${error}`,
    );
    // 熔断判定放在投递状态落库之后: 本次失败已计入窗口统计
    await recordFailureAndMaybeTrip(db, d.endpoint_id);
  }
  return success ? 'success' : dead ? 'dead' : 'failed';
}
