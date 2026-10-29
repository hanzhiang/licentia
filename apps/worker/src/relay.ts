import { Kysely } from 'kysely';
import { log } from '@lp/config';
import { LpDb, withSystemTx } from '@lp/db';
import { reviveExpired } from './breaker';

/**
 * Outbox relay(设计文档 §4.8 / §16 worker):
 *  0) 冷却到期的熔断端点恢复
 *  1) 未发布事件打点(Kafka 生产管线在 P3 接入)
 *  2) 扇出到 webhook_deliveries(按租户端点的事件订阅), 幂等: (endpoint_id, event_id) 去重
 *     —— 已熔断端点不扇出: 否则事件会在停投期间堆积成大量 dead, 冷却恢复后也补不回来
 */
export async function relayOnce(db: Kysely<LpDb>): Promise<number> {
  await reviveExpired(db);
  return withSystemTx(db, async (tx) => {
    const rows = await tx
      .selectFrom('events')
      .selectAll()
      .where('published_at', 'is', null)
      .orderBy('created_at', 'asc')
      .limit(100)
      .execute();

    for (const ev of rows) {
      log.info(
        `[outbox] publish ${ev.type} tenant=${ev.tenant_id ?? '-'} agg=${ev.aggregate_type}/${ev.aggregate_id}`,
      );
      if (ev.tenant_id === null) continue; // 平台级事件不投租户 webhook
      const endpoints = await tx
        .selectFrom('webhook_endpoints')
        .selectAll()
        .where('tenant_id', '=', ev.tenant_id)
        .where('status', '=', 'active')
        .where('deleted_at', 'is', null)
        .execute();
      for (const ep of endpoints) {
        if (!ep.events.includes('*') && !ep.events.includes(ev.type)) continue;
        const dup = await tx
          .selectFrom('webhook_deliveries')
          .select('id')
          .where('endpoint_id', '=', ep.id)
          .where('event_id', '=', ev.id)
          .executeTakeFirst();
        if (dup) continue;
        await tx
          .insertInto('webhook_deliveries')
          .values({
            tenant_id: ev.tenant_id,
            endpoint_id: ep.id,
            event_id: ev.id,
            event_type: ev.type,
            payload: ev.payload,
            attempt: 0,
            status: 'pending',
            next_retry_at: new Date(),
            response_status: null,
            last_error: null,
            created_at: new Date(),
            updated_at: new Date(),
          })
          .execute();
      }
    }

    if (rows.length > 0) {
      await tx
        .updateTable('events')
        .set({ published_at: new Date() })
        .where('id', 'in', rows.map((r) => r.id))
        .execute();
    }
    return rows.length;
  });
}
