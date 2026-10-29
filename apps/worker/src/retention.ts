import { Kysely, sql, type RawBuilder } from 'kysely';
import { LpDb, withSystemTx } from '@lp/db';

/**
 * 数据保留清理(设计文档 §16 partition-keeper / 数据治理).
 *
 * 有几张表只增不减, 长期运行必然膨胀:
 *   notifications_outbox / webhook_deliveries / idempotency_keys /
 *   client_tokens / refresh_tokens / events / license_deliveries
 *
 * 保留策略(可按环境覆盖):
 *   - 幂等键: 过期即删(它们本来就有 expires_at)
 *   - client_token: 过期 1 天后删(留一点余量便于排障)
 *   - refresh_token: 吊销或过期 30 天后删
 *   - 出站通知与 webhook 投递: 终态保留 90 天
 *   - 领域事件: 已发布保留 180 天
 *   - 交付记录: 保留 365 天(业务对账需要更久)
 *
 * 审计表**不在此清理** —— 它是取证与合规凭据, 只能按分区归档, 不能按行删。
 */

export interface RetentionConfig {
  idempotency?: number;
  clientTokenDays?: number;
  refreshTokenDays?: number;
  outboxDays?: number;
  webhookDays?: number;
  eventDays?: number;
  deliveryDays?: number;
}

export interface RetentionSummary {
  idempotency: number;
  clientTokens: number;
  refreshTokens: number;
  notifications: number;
  webhookDeliveries: number;
  events: number;
  deliveries: number;
}

const DEFAULTS = {
  clientTokenDays: 1,
  refreshTokenDays: 30,
  outboxDays: 90,
  webhookDays: 90,
  eventDays: 180,
  deliveryDays: 365,
};

/** 单批上限: 一次删太多会长时间持锁, 影响线上写入 */
const BATCH = 5000;

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 86_400_000);
}

export async function runRetentionOnce(
  db: Kysely<LpDb>,
  cfg: RetentionConfig = {},
): Promise<RetentionSummary> {
  const c = { ...DEFAULTS, ...cfg };
  return withSystemTx(db, async (tx) => {
    const del = async (q: RawBuilder<unknown>): Promise<number> => {
      const res = await q.execute(tx);
      return Number(res.numAffectedRows ?? 0);
    };

    const idempotency = await del(sql`
      delete from idempotency_keys
       where ctid in (select ctid from idempotency_keys where expires_at < now() limit ${BATCH})
    `);

    const clientTokens = await del(sql`
      delete from client_tokens
       where ctid in (
         select ctid from client_tokens
          where expires_at < ${daysAgo(c.clientTokenDays)}
          limit ${BATCH})
    `);

    const refreshTokens = await del(sql`
      delete from refresh_tokens
       where ctid in (
         select ctid from refresh_tokens
          where expires_at < ${daysAgo(c.refreshTokenDays)}
             or (revoked_at is not null and revoked_at < ${daysAgo(c.refreshTokenDays)})
          limit ${BATCH})
    `);

    // 只删终态, pending 的行必须留着继续重试
    const notifications = await del(sql`
      delete from notifications_outbox
       where ctid in (
         select ctid from notifications_outbox
          where status in ('sent','dead','blocked')
            and created_at < ${daysAgo(c.outboxDays)}
          limit ${BATCH})
    `);

    const webhookDeliveries = await del(sql`
      delete from webhook_deliveries
       where ctid in (
         select ctid from webhook_deliveries
          where status in ('success','dead')
            and created_at < ${daysAgo(c.webhookDays)}
          limit ${BATCH})
    `);

    const events = await del(sql`
      delete from events
       where ctid in (
         select ctid from events
          where published_at is not null
            and created_at < ${daysAgo(c.eventDays)}
          limit ${BATCH})
    `);

    const deliveries = await del(sql`
      delete from license_deliveries
       where ctid in (
         select ctid from license_deliveries
          where created_at < ${daysAgo(c.deliveryDays)}
          limit ${BATCH})
    `);

    const summary: RetentionSummary = {
      idempotency,
      clientTokens,
      refreshTokens,
      notifications,
      webhookDeliveries,
      events,
      deliveries,
    };
    const total = Object.values(summary).reduce((a, b) => a + b, 0);
    if (total > 0) {
      console.log(
        `[retention] cleaned idem=${idempotency} ct=${clientTokens} rt=${refreshTokens} ` +
          `notif=${notifications} webhook=${webhookDeliveries} events=${events} deliveries=${deliveries}`,
      );
    }
    return summary;
  });
}
