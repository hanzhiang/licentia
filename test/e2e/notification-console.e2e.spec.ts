/// <reference types="vitest" />
/**
 * 通知中心 e2e: 投递记录可查、失败可重投、已送达不再重投。
 * 前置: TEST_DATABASE_URL。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely } from 'kysely';
import { createDb, uuidv7, withSystemTx, type LpDb } from '@lp/db';
import { NotificationService } from '../../apps/admin-api/src/modules/notification/notification.service';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;
const TENANT = '11111111-1111-4111-8111-111111111111';
const actor = {
  userId: 'a1111111-0000-4000-8000-000000000002',
  actorType: 'developer_operator',
  ip: null,
  requestId: 'notify-console-e2e',
};

d.sequential('notification console', () => {
  let db: Kysely<LpDb>;
  let svc: NotificationService;
  const ids: string[] = [];

  async function enqueue(status: string): Promise<string> {
    const id = uuidv7();
    ids.push(id);
    await withSystemTx(db, (tx) =>
      tx
        .insertInto('notifications_outbox')
        .values({
          id,
          tenant_id: TENANT,
          license_id: null,
          channel: 'email',
          template_code: 'expire_warning_7d',
          to_addr_enc: null,
          payload: {},
          // 与唯一键无关(license_id 为空时不参与唯一约束), 用今天
          scheduled_for: new Date().toISOString().slice(0, 10),
          status: status as 'pending',
          retries: 3,
          last_error: 'smtp down',
          created_at: new Date(),
          sent_at: null,
          provider_message_id: null,
          next_retry_at: null,
          updated_at: new Date(),
        })
        .execute(),
    );
    return id;
  }

  beforeAll(async () => {
    db = createDb(url!, { max: 3 });
    svc = new NotificationService(db);
  });

  afterAll(async () => {
    if (ids.length > 0) {
      await withSystemTx(db, (tx) =>
        tx.deleteFrom('notifications_outbox').where('id', 'in', ids).execute(),
      );
    }
    await db.destroy();
  });

  it('lists delivery records with per-status counts', async () => {
    const id = await enqueue('dead');
    const page = await svc.list(TENANT, { limit: 100 });
    const row = page.items.find((x) => x.id === id);
    expect(row).toBeDefined();
    expect(row!.status).toBe('dead');
    expect(row!.last_error).toBe('smtp down');
    expect(page.total).toBeGreaterThanOrEqual(1);
    // 只校验形状: 别的 spec 可能同时在清空这张表, 计数不适合做等值断言
    expect(typeof page.counts.dead).toBe('number');
  });

  it('filters by status', async () => {
    const id = await enqueue('blocked');
    const page = await svc.list(TENANT, { status: 'blocked', limit: 100 });
    expect(page.items.some((x) => x.id === id)).toBe(true);
    expect(page.items.every((x) => x.status === 'blocked')).toBe(true);
  });

  it('re-queues a dead notification and resets the retry counter', async () => {
    const id = await enqueue('dead');
    await svc.retry(TENANT, id, actor);
    const row = await withSystemTx(db, (tx) =>
      tx
        .selectFrom('notifications_outbox')
        .select(['status', 'retries', 'next_retry_at'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow(),
    );
    expect(row.status).toBe('pending');
    expect(row.retries).toBe(0);
    expect(row.next_retry_at).toBeNull();
  });

  it('refuses to re-send an already delivered notification', async () => {
    const id = await enqueue('sent');
    await expect(svc.retry(TENANT, id, actor)).rejects.toThrow(/已送达/);
  });

  it('rejects unknown ids', async () => {
    await expect(svc.retry(TENANT, uuidv7(), actor)).rejects.toThrow(/通知不存在/);
  });
});
