import { sql, Kysely } from 'kysely';
import { LpDb, uuidv7, withSystemTx } from '@lp/db';
import { emitOutbox } from '@lp/events';

const WARN_DAYS = [30, 7, 1];

/**
 * 到期提醒(设计文档 场景6 / §16 notifier):
 *  - 扫描 activated 且剩余天数恰为 30/7/1 的授权码
 *  - notifications_outbox 唯一键(license_id, template_code, scheduled_for) 天然去重
 *  - 只入队 status='pending', 由 packages/notify 的投递器真实发送后才置 sent;
 *    此处绝不能预写 sent —— 否则库里有记录但用户从未收到, 故障时无法与「已送达」区分
 *  - 同时并发 license.expire_warning 领域事件(Webhook 订阅者可并行提醒)
 */
export async function notifyOnce(db: Kysely<LpDb>): Promise<number> {
  let total = 0;
  const today = new Date().toISOString().slice(0, 10);
  for (const days of WARN_DAYS) {
    await withSystemTx(db, async (tx) => {
      const due = await tx
        .selectFrom('licenses')
        .select(['id', 'tenant_id', 'expires_at'])
        .where('status', '=', 'activated')
        .where('expires_at', 'is not', null)
        .where(sql<boolean>`expires_at::date - current_date = ${days}`)
        .limit(5000)
        .execute();
      for (const lic of due) {
        const inserted = await tx
          .insertInto('notifications_outbox')
          .values({
            id: uuidv7(),
            tenant_id: lic.tenant_id,
            license_id: lic.id,
            channel: 'email',
            template_code: `expire_warning_${days}d`,
            to_addr_enc: null,
            payload: {
              license_id: lic.id,
              due_in_days: days,
              expires_at: lic.expires_at?.toISOString() ?? null,
            },
            scheduled_for: today,
            // 只入队, 不预写 sent: 真实投递结果由 deliverPending 回填
            status: 'pending',
            retries: 0,
            last_error: null,
            created_at: new Date(),
            sent_at: null,
            provider_message_id: null,
            next_retry_at: null,
            updated_at: new Date(),
          })
          .onConflict((oc) =>
            oc.columns(['license_id', 'template_code', 'scheduled_for']).doNothing(),
          )
          .returningAll()
          .execute();
        for (const n of inserted) {
          await emitOutbox(tx, 'license.expire_warning', lic.tenant_id, 'license', lic.id, {
            license_id: lic.id,
            due_in_days: days,
            expires_at: lic.expires_at?.toISOString() ?? null,
            notification_id: n.id,
          });
        }
        total += inserted.length;
      }
    });
  }
  if (total > 0) console.log(`[notifier] ${total} expire warning(s) queued`);
  return total;
}
