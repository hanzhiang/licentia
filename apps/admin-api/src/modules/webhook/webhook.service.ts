import { Inject, Injectable } from '@nestjs/common';
import crypto from 'node:crypto';
import { Kysely } from 'kysely';
import { errReqInvalid } from '@lp/domain';
import { encryptAead } from '@lp/keygen';
import { LpDb, uuidv7, withTenantTx } from '@lp/db';
import { writeAudit } from '@lp/audit';
import { getConfig } from '@lp/config';
import { DB } from '../../db.module';
import type { ActorInfo } from '../../iam/actor';

export const KNOWN_EVENTS = [
  '*',
  'license.activated',
  'license.device_bound',
  'license.device_unbound',
  'license.renewed',
  'license.suspended',
  'license.revoked',
  'license.expired',
  'license.expire_warning',
  'batch.completed',
  'batch.failed',
] as const;

export interface WebhookEndpointView {
  id: string;
  url: string;
  events: string[];
  status: string;
  /** 已熔断次数(决定下次冷却时长: 1m→5m→15m→1h) */
  failure_count: number;
  /** 熔断中时的自动恢复时间 */
  disabled_until: string | null;
  created_at: string;
}

/** Webhook 端点管理(设计文档 §4.8): secret 创建/轮换时明文返回一次, 库内存 AES 密文 */
@Injectable()
export class WebhooksService {
  constructor(@Inject(DB) private readonly db: Kysely<LpDb>) {}

  async create(
    tenantId: string,
    cmd: { url: string; events: string[] },
    actor: ActorInfo,
  ): Promise<{ view: WebhookEndpointView; secret: string }> {
    validateUrl(cmd.url);
    validateEvents(cmd.events);
    const cfg = getConfig();
    const secret = crypto.randomBytes(32).toString('base64url');
    const row = await withTenantTx(this.db, tenantId, async (tx) => {
      const inserted = await tx
        .insertInto('webhook_endpoints')
        .values({
          id: uuidv7(),
          tenant_id: tenantId,
          url: cmd.url,
          secret_cipher: encryptAead(cfg.WEBHOOK_ENC_KEY, secret),
          events: cmd.events,
          status: 'active',
          concurrency: 5,
          failure_count: 0,
          disabled_until: null,
          created_at: new Date(),
          deleted_at: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await writeAudit(tx, {
        tenantId,
        actorType: actor.actorType as 'tenant_admin',
        actorId: actor.userId,
        action: 'webhook.create',
        resourceType: 'webhook_endpoint',
        resourceId: inserted.id,
        detail: { url: cmd.url, events: cmd.events },
        ip: actor.ip ?? null,
        requestId: actor.requestId ?? null,
      });
      return inserted;
    });
    return { view: this.toView(row), secret };
  }

  async list(tenantId: string): Promise<WebhookEndpointView[]> {
    const rows = await withTenantTx(this.db, tenantId, (tx) =>
      tx
        .selectFrom('webhook_endpoints')
        .select([
          'id',
          'url',
          'events',
          'status',
          'failure_count',
          'disabled_until',
          'created_at',
        ])
        .where('deleted_at', 'is', null)
        .orderBy('created_at', 'desc')
        .limit(100)
        .execute(),
    );
    return rows.map((r) => this.toView(r));
  }

  async rotateSecret(tenantId: string, id: string, actor: ActorInfo): Promise<{ secret: string }> {
    const cfg = getConfig();
    const secret = crypto.randomBytes(32).toString('base64url');
    await withTenantTx(this.db, tenantId, async (tx) => {
      const row = await tx
        .selectFrom('webhook_endpoints')
        .select('id')
        .where('id', '=', id)
        .executeTakeFirst();
      if (!row) throw errReqInvalid('端点不存在');
      await tx
        .updateTable('webhook_endpoints')
        .set({ secret_cipher: encryptAead(cfg.WEBHOOK_ENC_KEY, secret), failure_count: 0 })
        .where('id', '=', id)
        .execute();
      await writeAudit(tx, {
        tenantId,
        actorType: actor.actorType as 'tenant_admin',
        actorId: actor.userId,
        action: 'webhook.rotate_secret',
        resourceType: 'webhook_endpoint',
        resourceId: id,
        detail: {},
        ip: actor.ip ?? null,
        requestId: actor.requestId ?? null,
      });
    });
    return { secret };
  }

  /**
   * 人工恢复熔断: 清零 failure_count, 回到 1m 起步.
   * 只清熔断状态, 不重投已经耗尽重试的历史投递(那是 dead, 需要单独的补投操作).
   */
  async resetBreaker(tenantId: string, id: string, actor: ActorInfo): Promise<void> {
    await withTenantTx(this.db, tenantId, async (tx) => {
      const row = await tx
        .selectFrom('webhook_endpoints')
        .select(['id', 'status', 'failure_count'])
        .where('id', '=', id)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!row) throw errReqInvalid('端点不存在');
      await tx
        .updateTable('webhook_endpoints')
        .set({ status: 'active', failure_count: 0, disabled_until: null })
        .where('id', '=', id)
        .execute();
      await writeAudit(tx, {
        tenantId,
        actorType: actor.actorType as 'tenant_admin',
        actorId: actor.userId,
        action: 'webhook.reset_breaker',
        resourceType: 'webhook_endpoint',
        resourceId: id,
        detail: { previous_status: row.status, previous_failure_count: row.failure_count },
        ip: actor.ip ?? null,
        requestId: actor.requestId ?? null,
      });
    });
  }

  private toView(r: {
    id: string;
    url: string;
    events: string[];
    status: string;
    failure_count: number;
    disabled_until: Date | null;
    created_at: Date;
  }): WebhookEndpointView {
    return {
      id: r.id,
      url: r.url,
      events: r.events,
      status: r.status,
      failure_count: r.failure_count,
      disabled_until: r.disabled_until?.toISOString() ?? null,
      created_at: r.created_at.toISOString(),
    };
  }
}

function validateUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw errReqInvalid('url 不合法');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw errReqInvalid('url 必须为 http(s)');
  }
}

function validateEvents(events: string[]): void {
  if (events.length === 0) throw errReqInvalid('events 不能为空');
  for (const e of events) {
    if (!(KNOWN_EVENTS as readonly string[]).includes(e)) {
      throw errReqInvalid(`未知事件类型: ${e}`);
    }
  }
}
