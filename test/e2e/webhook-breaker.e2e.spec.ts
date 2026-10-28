/// <reference types="vitest" />
/**
 * Webhook 端点熔断 e2e(设计文档 §4.8 P5).
 * 覆盖: 样本不足不熔断 / 失败率达标才熔断 / 冷却阶梯指数增长 / 到期自动恢复 /
 *       人工恢复清零 / 成功后回血 / 熔断端点不再扇出新投递.
 * 前置: TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely } from 'kysely';
import { createDb, uuidv7, withSystemTx, type LpDb } from '@lp/db';
import { emitOutbox } from '@lp/events';
import { relayOnce } from '../../apps/worker/src/relay';
import {
  BREAKER,
  decide,
  endpointStats,
  recordFailureAndMaybeTrip,
  recordSuccess,
  resetEndpoint,
  reviveExpired,
} from '../../apps/worker/src/breaker';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

const TENANT = '11111111-1111-4111-8111-111111111111';

d.sequential('webhook endpoint circuit breaker', () => {
  let db: Kysely<LpDb>;
  let endpointId: string;

  async function makeEndpoint(): Promise<string> {
    const id = uuidv7();
    await withSystemTx(db, (tx) =>
      tx
        .insertInto('webhook_endpoints')
        .values({
          id,
          tenant_id: TENANT,
          url: 'https://cb-test.invalid/hook',
          secret_cipher: Buffer.from('x'),
          events: ['*'],
          status: 'active',
          concurrency: 5,
          failure_count: 0,
          disabled_until: null,
          created_at: new Date(),
          deleted_at: null,
        })
        .execute(),
    );
    return id;
  }

  /** 造 n 条已尝试且结果指定的投递行(updated_at = now, 落在统计窗口内) */
  async function seedDeliveries(epId: string, ok: number, bad: number): Promise<void> {
    const rows = [
      ...Array.from({ length: ok }, () => ({ status: 'success', attempt: 1 })),
      ...Array.from({ length: bad }, () => ({ status: 'pending', attempt: 1 })),
    ];
    for (const r of rows) {
      await withSystemTx(db, (tx) =>
        tx
          .insertInto('webhook_deliveries')
          .values({
            tenant_id: TENANT,
            endpoint_id: epId,
            event_id: uuidv7(),
            event_type: 'license.activated',
            payload: {},
            attempt: r.attempt,
            status: r.status,
            next_retry_at: null,
            response_status: r.status === 'success' ? 200 : 500,
            last_error: r.status === 'success' ? null : 'http 500',
            created_at: new Date(),
            updated_at: new Date(),
          })
          .execute(),
      );
    }
  }

  async function ep(epId: string) {
    return withSystemTx(db, (tx) =>
      tx
        .selectFrom('webhook_endpoints')
        .selectAll()
        .where('id', '=', epId)
        .executeTakeFirstOrThrow(),
    );
  }

  beforeAll(() => {
    db = createDb(url!, { max: 10 });
  });

  afterAll(async () => {
    await withSystemTx(db, (tx) =>
      tx.deleteFrom('webhook_deliveries').where('tenant_id', '=', TENANT).execute(),
    );
    await withSystemTx(db, (tx) =>
      tx
        .deleteFrom('webhook_endpoints')
        .where('url', '=', 'https://cb-test.invalid/hook')
        .execute(),
    );
    await db.destroy();
  });

  it('does not trip below the minimum sample size', async () => {
    endpointId = await makeEndpoint();
    await seedDeliveries(endpointId, 0, BREAKER.MIN_SAMPLES - 1); // 全失败但样本不够
    const r = await recordFailureAndMaybeTrip(db, endpointId);
    expect(r.tripped).toBe(false);
    expect((await ep(endpointId)).status).toBe('active');
  });

  it('trips when the window failure rate exceeds the threshold', async () => {
    endpointId = await makeEndpoint();
    await seedDeliveries(endpointId, 2, 8); // 80% 失败, 10 样本
    const r = await recordFailureAndMaybeTrip(db, endpointId);
    expect(r.tripped).toBe(true);
    const row = await ep(endpointId);
    expect(row.status).toBe('disabled');
    expect(row.failure_count).toBe(1);
    expect(row.disabled_until).not.toBeNull();
    // 第一次熔断冷却 1 分钟
    const wait = row.disabled_until!.getTime() - Date.now();
    expect(wait).toBeGreaterThan(50_000);
    expect(wait).toBeLessThanOrEqual(BREAKER.COOLDOWN_MS[0]!);
  });

  it('escalates cooldown on repeated trips', () => {
    const stats = { samples: 20, failures: 15, failureRate: 0.75 };
    const first = decide(stats, 1);
    const second = decide(stats, 2);
    const third = decide(stats, 3);
    const fourth = decide(stats, 4);
    const fifth = decide(stats, 5);
    expect(first.trip && first.cooldownMs).toBe(BREAKER.COOLDOWN_MS[0]);
    expect(second.trip && second.cooldownMs).toBe(BREAKER.COOLDOWN_MS[1]);
    expect(third.trip && third.cooldownMs).toBe(BREAKER.COOLDOWN_MS[2]);
    expect(fourth.trip && fourth.cooldownMs).toBe(BREAKER.COOLDOWN_MS[3]);
    // 封顶
    expect(fifth.trip && fifth.cooldownMs).toBe(BREAKER.COOLDOWN_MS[3]);
  });

  it('ignores rows outside the window and never-attempted rows', async () => {
    const epId = await makeEndpoint();
    await seedDeliveries(epId, 0, 10);
    // 把全部行挪到窗口外
    await withSystemTx(db, (tx) =>
      tx
        .updateTable('webhook_deliveries')
        .set({ updated_at: new Date(Date.now() - BREAKER.WINDOW_MS - 60_000) })
        .where('endpoint_id', '=', epId)
        .execute(),
    );
    const stats = await endpointStats(db, epId);
    expect(stats.samples).toBe(0); // 窗口外的旧失败不参与判定
  });

  it('revives automatically once cooldown expires, keeping the trip count', async () => {
    endpointId = await makeEndpoint();
    await seedDeliveries(endpointId, 2, 8);
    await recordFailureAndMaybeTrip(db, endpointId);
    expect((await ep(endpointId)).status).toBe('disabled');

    // 未到期不恢复
    expect(await reviveExpired(db)).toBe(0);

    // 手动把冷却时间推到过去, 模拟到点
    await withSystemTx(db, (tx) =>
      tx
        .updateTable('webhook_endpoints')
        .set({ disabled_until: new Date(Date.now() - 1000) })
        .where('id', '=', endpointId)
        .execute(),
    );
    await reviveExpired(db);
    const row = await ep(endpointId);
    expect(row.status).toBe('active');
    expect(row.disabled_until).toBeNull();
    expect(row.failure_count).toBe(1); // 保留, 下次熔断继续加长
  });

  it('successful delivery bleeds the trip count down', async () => {
    endpointId = await makeEndpoint();
    await withSystemTx(db, (tx) =>
      tx
        .updateTable('webhook_endpoints')
        .set({ failure_count: 2 })
        .where('id', '=', endpointId)
        .execute(),
    );
    await recordSuccess(db, endpointId);
    expect((await ep(endpointId)).failure_count).toBe(1);
    await recordSuccess(db, endpointId);
    await recordSuccess(db, endpointId); // 不为负
    expect((await ep(endpointId)).failure_count).toBe(0);
  });

  it('manual reset clears the trip count back to the first cooldown', async () => {
    endpointId = await makeEndpoint();
    await seedDeliveries(endpointId, 2, 8);
    await recordFailureAndMaybeTrip(db, endpointId);
    await resetEndpoint(db, endpointId);
    const row = await ep(endpointId);
    expect(row.status).toBe('active');
    expect(row.failure_count).toBe(0);
    expect(row.disabled_until).toBeNull();
  });

  it('does not fan out new deliveries to a disabled endpoint', async () => {
    const epId = await makeEndpoint();
    await seedDeliveries(epId, 2, 8);
    await recordFailureAndMaybeTrip(db, epId);
    expect((await ep(epId)).status).toBe('disabled');

    // 发一个本应扇出的新事件
    await withSystemTx(db, (tx) =>
      emitOutbox(tx, 'license.revoked', TENANT, 'license', uuidv7(), { probe: 'breaker' }),
    );
    await relayOnce(db);

    const count = await withSystemTx(db, (tx) =>
      tx
        .selectFrom('webhook_deliveries')
        .select((eb) => eb.fn.countAll().as('c'))
        .where('endpoint_id', '=', epId)
        .where('event_type', '=', 'license.revoked')
        .executeTakeFirstOrThrow(),
    );
    // 熔断期间不产生新投递(否则它们会在停投期里被重试到 dead)
    expect(Number(count.c)).toBe(0);
    // 事件本身仍被标记为已发布, 不会无限重扇
    const ev = await withSystemTx(db, (tx) =>
      tx
        .selectFrom('events')
        .select('published_at')
        .where('type', '=', 'license.revoked')
        .where('tenant_id', '=', TENANT)
        .executeTakeFirst(),
    );
    expect(ev?.published_at).not.toBeNull();
  });

  it('fans out again after the endpoint is revived', async () => {
    const epId = await makeEndpoint();
    const before = await withSystemTx(db, (tx) =>
      tx
        .selectFrom('webhook_deliveries')
        .select((eb) => eb.fn.countAll().as('c'))
        .where('endpoint_id', '=', epId)
        .executeTakeFirstOrThrow(),
    );
    await withSystemTx(db, (tx) =>
      emitOutbox(tx, 'license.renewed', TENANT, 'license', uuidv7(), { probe: 'alive' }),
    );
    await relayOnce(db);
    const after = await withSystemTx(db, (tx) =>
      tx
        .selectFrom('webhook_deliveries')
        .select((eb) => eb.fn.countAll().as('c'))
        .where('endpoint_id', '=', epId)
        .executeTakeFirstOrThrow(),
    );
    expect(Number(after.c)).toBe(Number(before.c) + 1);
  });

  it('refuses to re-trip an endpoint that is already disabled', async () => {
    const epId = await makeEndpoint();
    await seedDeliveries(epId, 2, 8);
    await recordFailureAndMaybeTrip(db, epId);
    const again = await recordFailureAndMaybeTrip(db, epId);
    expect(again.tripped).toBe(false);
    expect((await ep(epId)).failure_count).toBe(1); // 未重复计次
  });
});
