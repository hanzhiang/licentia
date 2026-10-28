import { Kysely, sql } from 'kysely';
import { LpDb, withSystemTx } from '@lp/db';

/**
 * Webhook 端点熔断(设计文档 §4.8 P5).
 *
 * 为什么需要: dispatcher 只按单个投递的退避表重试, 一个已经瘫痪的对端会被
 * 每条事件都打一遍, 直到每条投递各自耗尽 6 次重试. 端点数 × 事件量 × 6 次
 * 的无效请求既浪费连接, 也容易被对端当成攻击; 反过来对端恢复后也要等很久
 * 才有流量回去.
 *
 * 规则(窗口内统计, 不是连续失败计数):
 *  - 窗口 60s, 至少 MIN_SAMPLES 个样本(避免低频端点偶发一次失败就熔断)
 *  - 失败率 >= 50% 则熔断: status='disabled', disabled_until = now + cooldown
 *  - cooldown 指数退避: 1m → 5m → 15m → 1h(封顶), 由 failure_count 记录已熔断次数
 *  - 冷却到期由 relay 恢复为 active, 但保留 failure_count 以便下次熔断继续加长
 *  - 人工恢复(reset)清零 failure_count, 回到 1m 起步
 *  - 任何一次成功投递都会把 failure_count 减 1, 避免偶发失败导致退避只增不减
 */
export const BREAKER = {
  WINDOW_MS: 60_000,
  MIN_SAMPLES: 10,
  FAILURE_RATE: 0.5,
  /** 第 n 次熔断的冷却时长(n 从 1 开始), 超出取最后一项 */
  COOLDOWN_MS: [60_000, 300_000, 900_000, 3_600_000],
} as const;

export interface BreakerStats {
  samples: number;
  failures: number;
  failureRate: number;
}

export type BreakerVerdict =
  | { trip: false; stats: BreakerStats }
  | { trip: true; stats: BreakerStats; disabledUntil: Date; cooldownMs: number };

/** 统计窗口内的投递结果(只算已有终态/失败的行, pending 不计入) */
export async function endpointStats(
  db: Kysely<LpDb>,
  endpointId: string,
  now: Date = new Date(),
): Promise<BreakerStats> {
  const since = new Date(now.getTime() - BREAKER.WINDOW_MS);
  const row = await withSystemTx(db, (tx) =>
    tx
      .selectFrom('webhook_deliveries')
      .select((eb) => [
        eb.fn.countAll().as('samples'),
        eb.fn
          .count('id')
          .filterWhere(sql<boolean>`status <> 'success' and attempt > 0`)
          .as('failures'),
      ])
      .where('endpoint_id', '=', endpointId)
      .where('updated_at', '>=', since)
      .where((eb) => eb.or([eb('status', '=', 'success'), eb('attempt', '>', 0)]))
      .executeTakeFirstOrThrow(),
  );
  const samples = Number(row.samples);
  const failures = Number(row.failures);
  return {
    samples,
    failures,
    failureRate: samples === 0 ? 0 : failures / samples,
  };
}

/** 依据窗口统计判定是否熔断(不改库) */
export function decide(stats: BreakerStats, tripCount: number): BreakerVerdict {
  if (stats.samples < BREAKER.MIN_SAMPLES) return { trip: false, stats };
  if (stats.failureRate < BREAKER.FAILURE_RATE) return { trip: false, stats };
  const idx = Math.min(Math.max(tripCount, 1), BREAKER.COOLDOWN_MS.length) - 1;
  const cooldownMs = BREAKER.COOLDOWN_MS[idx]!;
  return {
    trip: true,
    stats,
    cooldownMs,
    disabledUntil: new Date(Date.now() + cooldownMs),
  };
}

/**
 * 投递失败后调用: 判定并落库. 返回是否刚触发熔断(供日志/审计).
 * 已处于 disabled 的端点直接返回 false, 不重复计次.
 */
export async function recordFailureAndMaybeTrip(
  db: Kysely<LpDb>,
  endpointId: string,
): Promise<{ tripped: boolean; verdict?: BreakerVerdict }> {
  const ep = await withSystemTx(db, (tx) =>
    tx
      .selectFrom('webhook_endpoints')
      .select(['status', 'failure_count'])
      .where('id', '=', endpointId)
      .executeTakeFirst(),
  );
  if (!ep || ep.status !== 'active') return { tripped: false };

  const stats = await endpointStats(db, endpointId);
  const verdict = decide(stats, ep.failure_count + 1);
  if (!verdict.trip) return { tripped: false, verdict };

  await withSystemTx(db, (tx) =>
    tx
      .updateTable('webhook_endpoints')
      .set({
        status: 'disabled',
        failure_count: sql`failure_count + 1`,
        disabled_until: verdict.disabledUntil,
      })
      .where('id', '=', endpointId)
      .where('status', '=', 'active')
      .execute(),
  );
  console.warn(
    `[webhook] endpoint ${endpointId} 熔断 ${Math.round(verdict.cooldownMs / 1000)}s ` +
      `(窗口 ${stats.failures}/${stats.samples} 失败, ${(stats.failureRate * 100).toFixed(0)}%)`,
  );
  return { tripped: true, verdict };
}

/** 成功投递后调用: 缓慢回血, 防止一次故障让退避阶梯永久抬高 */
export async function recordSuccess(db: Kysely<LpDb>, endpointId: string): Promise<void> {
  await withSystemTx(db, (tx) =>
    tx
      .updateTable('webhook_endpoints')
      .set({ failure_count: sql`greatest(failure_count - 1, 0)` })
      .where('id', '=', endpointId)
      .where('failure_count', '>', 0)
      .execute(),
  );
}

/**
 * 冷却到期恢复(由 relay 每轮调用). 保留 failure_count, 使下一次熔断继续加长;
 * 只有人工恢复才清零.
 */
export async function reviveExpired(
  db: Kysely<LpDb>,
  now: Date = new Date(),
): Promise<number> {
  const rows = await withSystemTx(db, (tx) =>
    tx
      .updateTable('webhook_endpoints')
      .set({ status: 'active', disabled_until: null })
      .where('status', '=', 'disabled')
      .where('disabled_until', 'is not', null)
      .where('disabled_until', '<=', now)
      .where('deleted_at', 'is', null)
      .returning(['id'])
      .execute(),
  );
  if (rows.length > 0) {
    console.log(`[webhook] ${rows.length} 个端点冷却结束, 恢复投递`);
  }
  return rows.length;
}

/** 人工恢复(管理端): 清空熔断计数, 回到 1m 起步 */
export async function resetEndpoint(db: Kysely<LpDb>, endpointId: string): Promise<void> {
  await withSystemTx(db, (tx) =>
    tx
      .updateTable('webhook_endpoints')
      .set({ status: 'active', failure_count: 0, disabled_until: null })
      .where('id', '=', endpointId)
      .execute(),
  );
}
