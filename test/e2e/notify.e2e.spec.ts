/// <reference types="vitest" />
/**
 * 通知投递 e2e(设计文档 §16): 入队必须停在 pending, 只有通道真实返回成功才置 sent.
 * 覆盖: 正常投递 / 失败重试 / 超限 dead / 缺收件地址 blocked / 旧数据语义校验.
 * 前置: docker compose up + pnpm db:migrate, TEST_DATABASE_URL 已设.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely } from 'kysely';
import { createDb, withSystemTx, uuidv7, type LpDb } from '@lp/db';
import { getConfig } from '@lp/config';
import { encryptAead } from '@lp/keygen';
import { deliverPending, type NotificationChannel } from '../../packages/notify/src/index';
import { notifyOnce } from '../../apps/worker/src/notifier';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

const TENANT = '11111111-1111-4111-8111-111111111111';
const PRODUCT = '22222222-2222-4222-8222-222222222222';

/** 可控通道: 记录调用次数并按预设结果返回 */
function fakeChannel(results: Array<boolean>): NotificationChannel & { calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  return {
    name: 'email',
    calls,
    async send(target, message) {
      calls.push(target.to);
      const good = results[Math.min(i, results.length - 1)];
      i++;
      return good
        ? { ok: true, providerMessageId: `fake-${i}`, error: null }
        : { ok: false, providerMessageId: null, error: 'smtp down' };
    },
  };
}

d.sequential('notification delivery e2e', () => {
  let db: Kysely<LpDb>;
  let orgId: string;
  let licenseId: string;

  beforeAll(async () => {
    db = createDb(url!, { max: 10 });
    await withSystemTx(db, async (tx) => {
      await tx.deleteFrom('notifications_outbox').execute();
    });
    // 组织许可 + 可还原的邮箱
    orgId = uuidv7();
    licenseId = uuidv7();
    await withSystemTx(db, async (tx) => {
      await tx
        .insertInto('end_customers')
        .values({
          id: orgId,
          tenant_id: TENANT,
          name: '投递测试组织',
          type: 'org',
          contact_phone_hash: null,
          contact_email_enc: encryptAead(getConfig().NOTIFY_ADDR_ENC_KEY, 'ops@school.edu.cn'),
          status: 'active',
          created_at: new Date(),
          deleted_at: null,
        })
        .execute();
      const policy = await tx
        .selectFrom('policies')
        .select('id')
        .where('tenant_id', '=', TENANT)
        .executeTakeFirstOrThrow();
      await tx
        .insertInto('licenses')
        .values({
          id: licenseId,
          tenant_id: TENANT,
          product_id: PRODUCT,
          policy_id: policy.id,
          batch_id: null,
          channel_id: null,
          end_customer_id: orgId,
          code: 'NOTIFY-E2E-0001',
          code_hmac: Buffer.from(uuidv7().replace(/-/g, ''), 'hex'),
          code_cipher: encryptAead(getConfig().CODE_ENC_KEY, 'NOTIFY-E2E-0001'),
          kind: 'standard',
          status: 'activated',
          device_limit: 5,
          seat_limit: null,
          concurrency_limit: null,
          features: '[]' as unknown as string[],
          offline_window_days: 7,
          heartbeat_hours: 24,
          grace_hours: 72,
          activate_within_days: 0,
          renew_window_days: 90,
          allow_renewal: true,
          min_version: null,
          duration_days: null,
          issued_at: new Date(),
          activated_at: new Date(),
          expires_at: new Date(Date.now() + 30 * 86400_000),
          suspended_at: null,
          revoked_at: null,
          revoked_reason: null,
          version: 1,
          created_by: '00000000-0000-0000-0000-000000000000',
          created_at: new Date(),
          updated_at: new Date(),
        })
        .execute();
    });
  });

  afterAll(async () => {
    await withSystemTx(db, async (tx) => {
      await tx.deleteFrom('notifications_outbox').execute();
      await tx.deleteFrom('licenses').where('id', '=', licenseId).execute();
      await tx.deleteFrom('end_customers').where('id', '=', orgId).execute();
    });
    await db.destroy();
  });

  /** dayOffset 用于绕开 (license_id, template_code, scheduled_for) 唯一键: 过去日期同样到期 */
  async function enqueue(template: string, dayOffset = 0): Promise<string> {
    const id = uuidv7();
    const day = new Date(Date.now() + dayOffset * 86400_000).toISOString().slice(0, 10);
    await withSystemTx(db, (tx) =>
      tx
        .insertInto('notifications_outbox')
        .values({
          id,
          tenant_id: TENANT,
          license_id: licenseId,
          channel: 'email',
          template_code: template,
          to_addr_enc: null,
          payload: { due_in_days: 30, expires_at: new Date().toISOString() },
          scheduled_for: day,
          status: 'pending',
          retries: 0,
          last_error: null,
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

  async function rowOf(id: string) {
    return withSystemTx(db, (tx) =>
      tx
        .selectFrom('notifications_outbox')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow(),
    );
  }

  it('notifier enqueues as pending — never as sent before delivery', async () => {
    // 许可证 30 天后到期 → 应产生 1 条 expire_warning_30d
    const n = await notifyOnce(db);
    expect(n).toBeGreaterThanOrEqual(1);
    const rows = await withSystemTx(db, (tx) =>
      tx
        .selectFrom('notifications_outbox')
        .select(['status', 'provider_message_id'])
        .where('license_id', '=', licenseId)
        .execute(),
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.status).toBe('pending');
    expect(rows[0]!.provider_message_id).toBeNull();
  });

  it('delivers to the org contact email and marks sent with provider id', async () => {
    const ch = fakeChannel([true]);
    const s = await deliverPending({ db, channels: { email: ch } });
    expect(s.sent).toBeGreaterThanOrEqual(1);
    expect(ch.calls).toContain('ops@school.edu.cn');
    const rows = await withSystemTx(db, (tx) =>
      tx
        .selectFrom('notifications_outbox')
        .selectAll()
        .where('license_id', '=', licenseId)
        .execute(),
    );
    expect(rows[0]!.status).toBe('sent');
    expect(rows[0]!.provider_message_id).toMatch(/^fake-/);
    expect(rows[0]!.sent_at).not.toBeNull();
  });

  it('failed delivery goes to retrying with backoff, never to sent', async () => {
    const id = await enqueue('expire_warning_7d');
    const s = await deliverPending({ db, channels: { email: fakeChannel([false]) } });
    expect(s.retrying).toBeGreaterThanOrEqual(1);
    const row = await rowOf(id);
    expect(row.status).toBe('retrying');
    expect(row.retries).toBe(1);
    expect(row.last_error).toContain('smtp down');
    expect(row.sent_at).toBeNull();
    expect(row.next_retry_at).not.toBeNull();
  });

  it('gives up (dead) after the retry schedule is exhausted', async () => {
    const id = await enqueue('expire_warning_1d');
    // 直接在重试上限之前: schedule 长度 5, 第 5 次失败即 dead
    await withSystemTx(db, (tx) =>
      tx
        .updateTable('notifications_outbox')
        .set({ retries: 4 })
        .where('id', '=', id)
        .execute(),
    );
    const s = await deliverPending({ db, channels: { email: fakeChannel([false]) } });
    expect(s.dead).toBeGreaterThanOrEqual(1);
    const row = await rowOf(id);
    expect(row.status).toBe('dead');
    expect(row.retries).toBe(5);
  });

  it('blocks when the license has no org contact instead of pretending success', async () => {
    const orphanId = uuidv7();
    await withSystemTx(db, (tx) =>
      tx
        .insertInto('notifications_outbox')
        .values({
          id: orphanId,
          tenant_id: TENANT,
          license_id: null, // 无许可证 → 无法解析收件人
          channel: 'email',
          template_code: 'expire_warning_7d',
          to_addr_enc: null,
          payload: {},
          scheduled_for: new Date().toISOString().slice(0, 10),
          status: 'pending',
          retries: 0,
          last_error: null,
          created_at: new Date(),
          sent_at: null,
          provider_message_id: null,
          next_retry_at: null,
          updated_at: new Date(),
        })
        .execute(),
    );
    const s = await deliverPending({ db, channels: { email: fakeChannel([true]) } });
    expect(s.blocked).toBeGreaterThanOrEqual(1);
    const row = await rowOf(orphanId);
    expect(row.status).toBe('blocked');
    expect(row.last_error).toContain('收件地址缺失');
  });

  it('blocks when the channel is not configured at all', async () => {
    // 与前面用例同模板同日会撞唯一键, 用 -2 天(仍到期)错开
    const id = await enqueue('expire_warning_7d', -2);
    const s = await deliverPending({ db, channels: {} });
    expect(s.blocked).toBeGreaterThanOrEqual(1);
    const row = await rowOf(id);
    expect(row.status).toBe('blocked');
    expect(row.last_error).toContain('通道未配置');
  });
});
