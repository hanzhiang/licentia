import crypto from 'node:crypto';
import { Kysely, sql } from 'kysely';
import { LpDb, withSystemTx } from '@lp/db';
import { decryptAead } from '@lp/keygen';
import {  getConfig, log } from '@lp/config';
import { renderForTenant } from './template-store';
import { fail, type NotificationChannel } from './channel';

/**
 * 通知投递器(设计文档 §16): notifications_outbox 的 pending → sent / retrying / dead.
 *
 * 关键语义(与 Webhook 投递器一致):
 *  - 状态推进只在投递结果确定后进行; 发送前绝不预写 sent
 *  - 失败按指数退避重排(状态 retrying + next_retry_at), 到点会被再次领取; 超过上限置 dead
 *  - 收件地址为空(许可证未绑定组织联系人)时置 blocked, 不算成功也不算失败
 *  - 多副本安全: 领取时把 next_retry_at 推后当租约, 并发进程抢同一行时只有一个能成功
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
  const nowDate = now();
  /**
   * 待投递 = pending + 退避到点的 retrying。
   *
   * 之前只取 pending: 投递失败被置成 retrying 之后就再也没人捡回来,
   * 所谓「指数退避重试」实际一次都不会发生, 通知会永远卡在 retrying 直到被清理。
   * next_retry_at 为空的 retrying 是领取后进程崩溃留下的, 也要回收。
   */
  const due = await withSystemTx(deps.db, (tx) =>
    tx
      .selectFrom('notifications_outbox')
      .selectAll()
      .where('status', 'in', ['pending', 'retrying'])
      .where('scheduled_for', '<=', nowDate.toISOString().slice(0, 10))
      .where((eb) =>
        eb.or([eb('next_retry_at', 'is', null), eb('next_retry_at', '<=', nowDate)]),
      )
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
    // 抢占: 顺手把 next_retry_at 推到 2 分钟后当租约, 并发进程抢同一行时第二个会扑空
    const claimed = await withSystemTx(deps.db, (tx) =>
      tx
        .updateTable('notifications_outbox')
        .set({
          status: `retrying` as never,
          retries: sql`retries`,
          next_retry_at: sql`now() + interval '2 minutes'`,
          updated_at: nowDate,
        } as never)
        .where('id', '=', row.id)
        .where('status', 'in', ['pending', 'retrying'])
        .where((eb) =>
          eb.or([eb('next_retry_at', 'is', null), eb('next_retry_at', '<=', nowDate)]),
        )
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
      // 租户可覆盖模板文案; 语言取租户 locale(内置中文/英文两版)
      const message = await renderForTenant(deps.db, claimed.tenant_id, claimed.template_code, {
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
    log.warn(
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
  // sent / dead / blocked 都是终态: 清掉退避时间, 免得被当成"待重试"再捡回来
  const terminal = status === 'sent' || status === 'dead' || status === 'blocked';
  await withSystemTx(db, (tx) =>
    tx
      .updateTable('notifications_outbox')
      // 0005 迁移新增列; 用显式 set 避免类型系统对扩展列的约束
      .set({
        status,
        retries,
        last_error: lastError,
        sent_at: status === 'sent' ? now : null,
        next_retry_at: terminal ? null : new Date(now.getTime() + (retryInSec ?? 60) * 1000),
        updated_at: now,
        ...(providerMessageId !== undefined ? { provider_message_id: providerMessageId } : {}),
      } as never)
      .where('id', '=', id)
      .execute(),
  );
}

/** 供测试: 判定是否应重试的状态 */
export function isRetryable(status: DeliveryStatus): boolean {
  return status === 'pending' || status === 'retrying';
}
