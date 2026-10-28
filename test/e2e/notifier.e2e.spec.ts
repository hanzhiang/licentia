/// <reference types="vitest" />
/**
 * 到期提醒 e2e(设计文档 场景6): 30/7/1 天通知去重 + expire_warning 领域事件.
 * 前置: docker compose up + pnpm db:migrate, TEST_DATABASE_URL 已设.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, sql } from 'kysely';
import { createDb, withSystemTx, type LpDb } from '@lp/db';
import { hmacCode } from '@lp/keygen';
import { getConfig } from '@lp/config';
import { notifyOnce } from '../../apps/worker/src/notifier';
import { BatchService } from '../../apps/admin-api/src/modules/batch/batch.service';
import { ActivateService } from '../../apps/client-api/src/modules/activate/activate.service';
import { LicenseSigner, LocalSignerProvider } from '@lp/signer';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

const TENANT = '11111111-1111-4111-8111-111111111111';
const PRODUCT = '22222222-2222-4222-8222-222222222222';
const POLICY = '33333333-3333-4333-8333-333333333333';
const CHANNEL = '44444444-4444-4444-8444-444444444444';

d.sequential('notifier e2e (expire warnings)', () => {
  let db: Kysely<LpDb>;

  beforeAll(() => {
    db = createDb(url!, { max: 10 });
  });

  afterAll(async () => {
    await db.destroy();
  });

  async function reset(): Promise<void> {
    await withSystemTx(db, async (tx) => {
      for (const t of [
        'idempotency_keys','events','notifications_outbox','renewals','client_tokens',
        'license_activations','devices','licenses','license_batches','end_customers',
      ]) {
        await tx.deleteFrom(t as 'licenses').execute();
      }
    });
  }

  it('generates 30/7/1 warnings exactly once (dedup) and emits domain events', async () => {
    await reset();
    const batch = new BatchService(db);
    const signer = new LicenseSigner(new LocalSignerProvider('e2e-kid', 'e2e-seed'));
    const activate = new ActivateService(db, signer);

    // 激活 3 张码, 把 expires_at 分别改成 30/7/1 天后
    const r = await batch.issue(
      TENANT,
      { product_id: PRODUCT, policy_id: POLICY, channel_id: CHANNEL, quantity: 3 },
      `notifier-key-${Date.now()}`,
    );
    const codes = r.body.data.codes!;
    const offsets = [30, 7, 1];
    for (let i = 0; i < 3; i++) {
      await activate.activate({
        code: codes[i]!,
        app: { productCode: 'dorm-check', version: '2.4.1' },
        device: {
          fpType: 'machine_id',
          fingerprint: `notifier-fp-${i}`,
          platform: 'windows',
        },
      });
      await withSystemTx(db, (tx) =>
        tx
          .updateTable('licenses')
          .set({ expires_at: sql`now() + make_interval(days => ${offsets[i]})` })
          .where(
            'code_hmac',
            '=',
            hmacCode(getConfig().CODE_HMAC_KEY, codes[i]!.replace(/-/g, '')),
          )
          .execute(),
      );
    }

    const first = await notifyOnce(db);
    expect(first).toBe(3); // 30/7/1 各一条

    // 幂等: 同日重跑不重复
    const second = await notifyOnce(db);
    expect(second).toBe(0);

    // 领域事件已发出(webhook 订阅者可提醒)
    const events = await withSystemTx(db, (tx) =>
      tx
        .selectFrom('events')
        .select((eb) => eb.fn.countAll().as('cnt'))
        .where('type', '=', 'license.expire_warning')
        .executeTakeFirstOrThrow(),
    );
    expect(Number(events.cnt)).toBe(3);
  });
});
