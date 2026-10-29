/// <reference types="vitest" />
/**
 * 数据保留清理 e2e: 只删终态且超期的行，在途与未发布数据必须保留。
 * 前置: TEST_DATABASE_URL。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely } from 'kysely';
import { createDb, uuidv7, withSystemTx, type LpDb } from '@lp/db';
import { runRetentionOnce } from '../../apps/worker/src/retention';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;
const TENANT = '11111111-1111-4111-8111-111111111111';
const MARK = `retention-${Date.now()}`;

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 86_400_000);
}

d.sequential('data retention', () => {
  let db: Kysely<LpDb>;

  beforeAll(() => {
    db = createDb(url!, { max: 5 });
  });

  afterAll(async () => {
    await withSystemTx(db, async (tx) => {
      await tx.deleteFrom('notifications_outbox').where('template_code', 'like', `${MARK}%`).execute();
      await tx.deleteFrom('events').where('type', 'like', `${MARK}%`).execute();
      await tx.deleteFrom('idempotency_keys').where('idem_key', 'like', `${MARK}%`).execute();
    });
    await db.destroy();
  });

  it('deletes only settled, expired rows', async () => {
    const oldSentId = uuidv7();
    const oldPendingId = uuidv7();
    await withSystemTx(db, async (tx) => {
      // 幂等键: 过期的删, 未过期的留
      await tx
        .insertInto('idempotency_keys')
        .values([
          {
            tenant_id: TENANT,
            idem_key: `${MARK}-expired`,
            endpoint: 'POST /x',
            request_hash: Buffer.from('a'),
            status: 'completed',
            http_status: 200,
            response: {},
            locked_at: daysAgo(2),
            expires_at: daysAgo(1),
          },
          {
            tenant_id: TENANT,
            idem_key: `${MARK}-alive`,
            endpoint: 'POST /x',
            request_hash: Buffer.from('b'),
            status: 'completed',
            http_status: 200,
            response: {},
            locked_at: new Date(),
            expires_at: new Date(Date.now() + 86_400_000),
          },
        ] as never)
        .execute();

      // 通知: 终态且超期删, pending 即使很旧也留
      await tx
        .insertInto('notifications_outbox')
        .values([
          {
            id: oldSentId,
            tenant_id: TENANT,
            license_id: null,
            channel: 'email',
            template_code: `${MARK}-sent`,
            to_addr_enc: null,
            payload: {},
            scheduled_for: '2026-01-01',
            status: 'sent',
            retries: 1,
            last_error: null,
            created_at: daysAgo(120),
            sent_at: daysAgo(120),
            provider_message_id: null,
            next_retry_at: null,
            updated_at: daysAgo(120),
          },
          {
            id: oldPendingId,
            tenant_id: TENANT,
            license_id: null,
            channel: 'email',
            template_code: `${MARK}-pending`,
            to_addr_enc: null,
            payload: {},
            scheduled_for: '2026-01-01',
            status: 'pending',
            retries: 0,
            last_error: null,
            created_at: daysAgo(120),
            sent_at: null,
            provider_message_id: null,
            next_retry_at: null,
            updated_at: daysAgo(120),
          },
        ] as never)
        .execute();

      // 事件: 已发布且超期删; 未发布即使很旧也留
      await tx
        .insertInto('events')
        .values([
          {
            id: uuidv7(),
            tenant_id: TENANT,
            aggregate_type: 'license',
            aggregate_id: uuidv7(),
            type: `${MARK}-published`,
            payload: {},
            created_at: daysAgo(200),
            published_at: daysAgo(200),
          },
          {
            id: uuidv7(),
            tenant_id: TENANT,
            aggregate_type: 'license',
            aggregate_id: uuidv7(),
            type: `${MARK}-unpublished`,
            payload: {},
            created_at: daysAgo(200),
            published_at: null,
          },
          {
            id: uuidv7(),
            tenant_id: TENANT,
            aggregate_type: 'license',
            aggregate_id: uuidv7(),
            type: `${MARK}-recent`,
            payload: {},
            created_at: daysAgo(1),
            published_at: daysAgo(1),
          },
        ] as never)
        .execute();
    });

    const summary = await runRetentionOnce(db);
    expect(summary.idempotency).toBeGreaterThanOrEqual(1);
    expect(summary.notifications).toBeGreaterThanOrEqual(1);
    expect(summary.events).toBeGreaterThanOrEqual(1);

    const left = await withSystemTx(db, async (tx) => {
      const idem = await tx
        .selectFrom('idempotency_keys')
        .select(['idem_key'])
        .where('idem_key', 'like', `${MARK}%`)
        .execute();
      const notif = await tx
        .selectFrom('notifications_outbox')
        .select(['id', 'status'])
        .where('template_code', 'like', `${MARK}%`)
        .execute();
      const evs = await tx
        .selectFrom('events')
        .select(['type'])
        .where('type', 'like', `${MARK}%`)
        .execute();
      return { idem, notif, evs };
    });

    // 幂等: 只剩未过期的
    expect(left.idem.map((r) => r.idem_key)).toEqual([`${MARK}-alive`]);
    // 通知: 只剩 pending 那条
    expect(left.notif.map((r) => r.status)).toEqual(['pending']);
    // 事件: 只剩未发布与近期两条
    expect(left.evs.map((r) => r.type).sort()).toEqual(
      [`${MARK}-recent`, `${MARK}-unpublished`].sort(),
    );
  }, 60000);
});
