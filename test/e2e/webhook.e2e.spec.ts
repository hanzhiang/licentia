/// <reference types="vitest" />
/**
 * Webhook 投递 e2e: 事件扇出 → HMAC 签名投递 → 失败退避 → 死信.
 * 前置: docker compose up + pnpm db:migrate, TEST_DATABASE_URL 已设.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';
import { Kysely } from 'kysely';
import { createDb, withSystemTx, type LpDb } from '@lp/db';
import { emitOutbox } from '@lp/events';
import { getConfig } from '@lp/config';
import { relayOnce } from '../../apps/worker/src/relay';
import { dispatchOnce } from '../../apps/worker/src/dispatcher';
import { WebhooksService } from '../../apps/admin-api/src/modules/webhook/webhook.service';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

const TENANT = '11111111-1111-4111-8111-111111111111';

d.sequential('webhook dispatch e2e', () => {
  let db: Kysely<LpDb>;
  let webhooks: WebhooksService;
  let server: http.Server;
  let received: Array<{ body: string; headers: http.IncomingHttpHeaders }> = [];
  let port = 0;

  const actor = { userId: '00000000-0000-0000-0000-000000000000', actorType: 'tenant_admin' };

  beforeAll(async () => {
    db = createDb(url!, { max: 10 });
    webhooks = new WebhooksService(db);
    // 清场: 前序测试文件可能遗留未发布事件(会被本文件的 relay 扇出)
    await withSystemTx(db, async (tx) => {
      await tx.deleteFrom('webhook_deliveries').execute();
      await tx.deleteFrom('webhook_endpoints').execute();
      await tx.deleteFrom('events').execute();
    });
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ body, headers: req.headers });
        res.writeHead(200);
        res.end('ok');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await withSystemTx(db, async (tx) => {
      await tx.deleteFrom('webhook_deliveries').execute();
      await tx.deleteFrom('webhook_endpoints').execute();
      await tx.deleteFrom('events').execute();
    });
    await db.destroy();
  });

  it('delivers signed webhook and verifies HMAC', async () => {
    received = [];
    const { view, secret } = await webhooks.create(
      TENANT,
      { url: `http://127.0.0.1:${port}/hook`, events: ['*'] },
      actor,
    );

    await withSystemTx(db, (tx) =>
      emitOutbox(tx, 'license.revoked', TENANT, 'license', crypto.randomUUID(), {
        license_id: 'test-license',
        reason: 'e2e',
      }),
    );
    const relayed = await relayOnce(db);
    expect(relayed).toBeGreaterThanOrEqual(1);

    const summary = await dispatchOnce(db);
    expect(summary.success).toBeGreaterThanOrEqual(1);

    expect(received.length).toBeGreaterThanOrEqual(1);
    // 按事件 id 精确匹配本次事件(端点订阅 '*', 可能收到同文件其他事件)
    const expectedEventId = (await withSystemTx(db, (tx) =>
      tx
        .selectFrom('events')
        .select('id')
        .where('type', '=', 'license.revoked')
        .orderBy('created_at', 'desc')
        .limit(1)
        .executeTakeFirst(),
    ))!.id;
    const hit = received.find((r) => {
      try {
        return (JSON.parse(r.body) as { event_id?: string }).event_id === expectedEventId;
      } catch {
        return false;
      }
    });
    expect(hit).toBeTruthy();
    const body = JSON.parse(hit!.body) as { type: string; data: { reason: string } };
    expect(body.type).toBe('license.revoked');
    expect(body.data.reason).toBe('e2e');

    // 签名验证: v1 = HMAC_SHA256(secret, t + '.' + body)
    const sig = hit.headers['x-lp-signature'] as string;
    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(sig);
    expect(m).toBeTruthy();
    const expectV1 = crypto
      .createHmac('sha256', secret)
      .update(`${m![1]}.${hit.body}`, 'utf8')
      .digest('hex');
    expect(m![2]).toBe(expectV1);
    expect(hit.headers['x-lp-event']).toBe('license.revoked');
    void view;
  });

  it('retries with backoff and eventually marks pending (receiver down)', async () => {
    // 指向未监听端口
    await webhooks.create(
      TENANT,
      { url: 'http://127.0.0.1:1/hook', events: ['*'] },
      actor,
    );
    await withSystemTx(db, (tx) =>
      emitOutbox(tx, 'batch.completed', TENANT, 'batch', crypto.randomUUID(), { batch_id: 'b1' }),
    );
    await relayOnce(db);
    const summary = await dispatchOnce(db);
    expect(summary.processed).toBeGreaterThanOrEqual(1);
    const rows = await withSystemTx(db, (tx) =>
      tx
        .selectFrom('webhook_deliveries')
        .selectAll()
        .where('status', '=', 'pending')
        .execute(),
    );
    const failed = rows.find((r) => r.attempt >= 1 && r.next_retry_at !== null);
    expect(failed).toBeTruthy();
    expect(failed!.last_error).toBeTruthy();
  });
});
