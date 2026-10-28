import crypto from 'node:crypto';
import { Kysely, sql } from 'kysely';
import { LpDb, withSystemTx } from '@lp/db';
import { decryptAead } from '@lp/keygen';
import { getConfig } from '@lp/config';
import { renderTemplate } from './templates';
import { fail, type NotificationChannel } from './channel';

/**
 * 通知投递器(设计文档 §16): notifications_outbox 的 pending → sent / retrying / dead.
 *
 * 关键语义(与 Webhook 投递器一致):
 *  - 状态推进只在投递结果确定后进行; 发送前绝不预写 sent
 *  - 失败按指数退避重排, 超过上限置 dead(不再无限重试)
 *  - 收件地址为空(许可证未绑定组织联系人)时置 blocked, 不算成功也不算失败
 *  - 单实例语义; 多副本需 FOR UPDATE SKIP LOCKED 抢占(pending 行加锁)
 */
const RETRY_SCHEDULE_SEC = [60, 300, 1800, 7200, 21600];

/** notifications_outbox.status 的取值集合(0001 DDL 之外的扩展, 见 0005 迁移) */
export type DeliveryStatus = 'pending' | 'sent' | 'retrying' | 'failed' | 'dead' | 'blocked';

export interface NotifyRunSummary {
  processed: number;
  sent: number;
  retrying: number;
  dead: number;
  blocked: number;
}

export interface DeliverDeps {
  db: Kysely<LpDb>;
  channels: Partial<Record<'email' | 'sms', NotificationChannel>>;
  /** 投递方身份, 写审计/日志时用 */
  now?: () => Date;
}

export async function deliverPending(deps: DeliverDeps, limit = 50): Promise<NotifyRunSummary> {
  const now = deps.now ?? (() => new Date());
  const cfg = getConfig();
  const due = await withSystemTx(deps.db, (tx) =>
    tx
      .selectFrom('notifications_outbox')
      .selectAll()
      .where('status', '=', 'pending')
      .where('scheduled_for', '<=', now().toISOString().slice(0, 10))
      .orderBy('created_at', 'asc')
      .limit(limit)
      .execute(),
  );
  const summary: NotifyRunSummary = {
    processed: due.length,
    sent: 0,
    retrying: 0,
    dead: 0,
    blocked: 0,
  };

  for (const row of due) {
    // 抢占: 只有状态仍为 pending 才处理, 避免多进程重复发送
    const claimed = await withSystemTx(deps.db, (tx) =>
      tx
        .updateTable('notifications_outbox')
        .set({ status: `retrying` as never, retries: sql`retries` })
        .where('id', '=', row.id)
        .where('status', '=', 'pending')
        .returningAll()
        .executeTakeFirst(),
    );
    if (!claimed) continue;

    const channelName = row.channel === 'sms' ? 'sms' : 'email';
    const channel = deps.channels[channelName];
    const attempt = claimed.retries + 1;

    // 收件地址: 组织许可取 end_customers.contact_email_enc / phone_hash 无法还原手机号,
    // 因此只有显式配置了邮箱的客户可投递; 其余置 blocked 明确暴露而非假装已发
    const to = await resolveRecipient(deps.db, claimed.license_id, channelName, cfg.NOTIFY_ADDR_ENC_KEY);
    if (!to) {
      await mark(deps.db, claimed.id, 'blocked', attempt, now(), '收件地址缺失');
      summary.blocked++;
      continue;
    }
    if (!channel) {
      await mark(deps.db, claimed.id, 'blocked', attempt, now(), `通道未配置: ${channelName}`);
      summary.blocked++;
      continue;
    }

    let result;
    try {
      const message = renderTemplate(claimed.template_code, {
        license_id: claimed.license_id ?? '',
        due_in_days: Number(claimed.payload.due_in_days ?? 0),
        expires_at: (claimed.payload.expires_at as string | null | undefined) ?? null,
        product_name: claimed.payload.product_name as string | undefined,
        org_name: claimed.payload.org_name as string | undefined,
      });
      result = await channel.send({ to }, message);
    } catch (e) {
      result = fail(e);
    }

    if (result.ok) {
      await mark(deps.db, claimed.id, 'sent', attempt, now(), null, result.providerMessageId);
      summary.sent++;
      continue;
    }
    const dead = attempt >= RETRY_SCHEDULE_SEC.length;
    await mark(
      deps.db,
      claimed.id,
      dead ? 'dead' : 'retrying',
      attempt,
      now(),
      result.error,
      null,
      dead ? undefined : RETRY_SCHEDULE_SEC[attempt - 1]!,
    );
    if (dead) summary.dead++;
    else summary.retrying++;
    console.warn(
      `[notify] ${claimed.id} attempt=${attempt} ${dead ? 'DEAD' : 'retry'} ${result.error}`,
    );
  }
  return summary;
}

async function resolveRecipient(
  db: Kysely<LpDb>,
  licenseId: string | null,
  channel: 'email' | 'sms',
  encKey: string,
): Promise<string | null> {
  if (!licenseId) return null;
  const lic = await withSystemTx(db, (tx) =>
    tx
      .selectFrom('licenses')
      .select(['end_customer_id'])
      .where('id', '=', licenseId)
      .executeTakeFirst(),
  );
  if (!lic?.end_customer_id) return null;
  const org = await withSystemTx(db, (tx) =>
    tx
      .selectFrom('end_customers')
      .select(['name', 'contact_email_enc'])
      .where('id', '=', lic.end_customer_id!)
      .executeTakeFirst(),
  );
  // 手机号以 HMAC 存储(不可逆), 短信通道需要明文, 因此只有邮箱可还原
  if (!org?.contact_email_enc) return null;
  try {
    return decryptAead(encKey, org.contact_email_enc);
  } catch {
    return null;
  }
}

async function mark(
  db: Kysely<LpDb>,
  id: string,
  status: DeliveryStatus,
  retries: number,
  now: Date,
  lastError: string | null,
  providerMessageId?: string | null,
  retryInSec?: number,
): Promise<void> {
  await withSystemTx(db, (tx) =>
    tx
      .updateTable('notifications_outbox')
      // 0005 迁移新增列; 用显式 set 避免类型系统对扩展列的约束
      .set({
        status,
        retries,
        last_error: lastError,
        sent_at: status === 'sent' ? now : null,
        ...(providerMessageId !== undefined ? { provider_message_id: providerMessageId } : {}),
        ...(retryInSec !== undefined
          ? { next_retry_at: new Date(now.getTime() + retryInSec * 1000) }
          : {}),
      } as never)
      .where('id', '=', id)
      .execute(),
  );
}

/** 供测试: 判定是否应重试的状态 */
export function isRetryable(status: DeliveryStatus): boolean {
  return status === 'pending' || status === 'retrying';
}
