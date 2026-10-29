import { Inject, Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { AppError } from '@lp/domain';
import { LpDb, withTenantTx } from '@lp/db';
import { writeAudit } from '@lp/audit';
import { DB } from '../../db.module';
import type { ActorInfo } from '../../iam/actor';

export interface NotificationItem {
  id: string;
  license_id: string | null;
  channel: string;
  template_code: string;
  status: string;
  retries: number;
  last_error: string | null;
  scheduled_for: string;
  next_retry_at: Date | null;
  sent_at: Date | null;
  created_at: Date;
}

export interface NotificationPage {
  items: NotificationItem[];
  total: number;
  /** 各状态计数, 用于顶部的状态筛选条 */
  counts: Record<string, number>;
}

/** 可以手动重投的状态: 已送达的不重发, 投递中的等它自己跑完 */
const RETRYABLE = new Set(['failed', 'dead', 'blocked', 'retrying']);

type NotificationStatus = 'pending' | 'retrying' | 'sent' | 'failed' | 'dead' | 'blocked';

/** pg 的 date 列可能是 Date 也可能是 'YYYY-MM-DD' 字符串 */
function formatDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

/**
 * 通知投递记录(notifications_outbox 的读侧).
 *
 * 此前 outbox 只有投递器在读, 界面上完全看不到: 邮件是发出去了、被退信、
 * 还是根本找不到收件人被 blocked, 只能翻日志。这里把状态与错误暴露出来, 并允许重投。
 */
@Injectable()
export class NotificationService {
  constructor(@Inject(DB) private readonly db: Kysely<LpDb>) {}

  async list(
    tenantId: string,
    filter: {
      status?: string | null;
      channel?: string | null;
      template_code?: string | null;
      limit?: number;
      offset?: number;
    },
  ): Promise<NotificationPage> {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const offset = Math.max(filter.offset ?? 0, 0);

    return withTenantTx(this.db, tenantId, async (tx) => {
      let q = tx.selectFrom('notifications_outbox').where('tenant_id', '=', tenantId);
      if (filter.status) q = q.where('status', '=', filter.status as NotificationStatus);
      if (filter.channel) q = q.where('channel', '=', filter.channel);
      if (filter.template_code) q = q.where('template_code', '=', filter.template_code);

      const totalRow = await q
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .executeTakeFirst();
      const items = await q
        .select([
          'id',
          'license_id',
          'channel',
          'template_code',
          'status',
          'retries',
          'last_error',
          'scheduled_for',
          'next_retry_at',
          'sent_at',
          'created_at',
        ])
        .orderBy('created_at', 'desc')
        .limit(limit)
        .offset(offset)
        .execute();

      const counts = await tx
        .selectFrom('notifications_outbox')
        .select(['status', sql<string>`count(*)`.as('n')])
        .where('tenant_id', '=', tenantId)
        .groupBy('status')
        .execute();

      return {
        // pg 对 date 列可能给 Date 也可能给字符串, 统一成 ISO 日期
        items: items.map((r) => ({ ...r, scheduled_for: formatDate(r.scheduled_for) })),
        total: Number(totalRow?.n ?? 0),
        counts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])),
      };
    });
  }

  /** 手动重投: 清零重试次数并回到 pending, 由 worker 下一轮领取 */
  async retry(tenantId: string, id: string, actor: ActorInfo): Promise<void> {
    await withTenantTx(this.db, tenantId, async (tx) => {
      const row = await tx
        .selectFrom('notifications_outbox')
        .select(['id', 'status', 'template_code'])
        .where('tenant_id', '=', tenantId)
        .where('id', '=', id)
        .executeTakeFirst();
      if (!row) throw new AppError('REQ_INVALID', '通知不存在');
      if (row.status === 'sent') throw new AppError('REQ_INVALID', '该通知已送达, 无需重投');
      if (!RETRYABLE.has(row.status)) {
        throw new AppError('REQ_INVALID', `当前状态(${row.status})不可重投`);
      }

      await tx
        .updateTable('notifications_outbox')
        .set({
          status: 'pending',
          retries: 0,
          next_retry_at: null,
          updated_at: new Date(),
        } as never)
        .where('id', '=', id)
        .execute();

      await writeAudit(tx, {
        tenantId,
        actorType: actor.actorType as 'developer_operator',
        actorId: actor.userId,
        action: 'notify.retry',
        resourceType: 'notification',
        resourceId: id,
        detail: { template_code: row.template_code, from_status: row.status },
        ip: actor.ip ?? null,
        requestId: actor.requestId ?? null,
      });
    });
  }
}
