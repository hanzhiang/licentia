import { Inject, Injectable, Optional } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import {
  assertTransition,
  errIdempotencyConflict,
  errIdempotencyKeyRequired,
  errLicNotFound,
  errNotRenewable,
  errRenewWindow,
  errReqInvalid,
  errStatusInvalid,
  type LicenseStatus,
} from '@lp/domain';
import { maskCode } from '@lp/keygen';
import { LpDb, uuidv7, withTenantTx } from '@lp/db';
import { emitOutbox } from '@lp/events';
import { withIdempotency } from '@lp/idempotency';
import { writeAudit } from '@lp/audit';
import { publishLicenseInvalidated, type Redis } from '@lp/cache';
import { DB } from '../../db.module';
import { REDIS } from '../../redis.module';
import type { ActorInfo } from '../../iam/actor';
import type { RenewDto, RevokeDto } from '../dto';

/**
 * 管理端授权操作(设计文档 §4.5 吊销 / §4.6 续期):
 *  - 全部走 Idempotency-Key + 状态机 + FOR UPDATE, 重复请求保持正确
 *  - 审批流(客服申请→运营审批)在 P2 加 revocation_requests 页面, 当前直接执行
 */
@Injectable()
export class LicenseService {
  constructor(
    @Inject(DB) private readonly db: Kysely<LpDb>,
    @Optional() @Inject(REDIS) private readonly redis?: Redis | null,
  ) {}

  async get(tenantId: string, licenseId: string, channelId?: string | null) {
    const lic = await withTenantTx(this.db, tenantId, (tx) =>
      tx.selectFrom('licenses').selectAll().where('id', '=', licenseId).executeTakeFirst(),
    );
    // 渠道账号访问他渠道的码: 与不存在一样处理, 不泄露该码存在
    if (!lic || (channelId && lic.channel_id !== channelId)) throw errLicNotFound();
    return {
      id: lic.id,
      code_masked: maskCode(lic.code.replace(/-/g, '')),
      kind: lic.kind,
      status: lic.status,
      features: lic.features,
      device_limit: lic.device_limit,
      seat_limit: lic.seat_limit,
      concurrency_limit: lic.concurrency_limit,
      offline_window_days: lic.offline_window_days,
      heartbeat_hours: lic.heartbeat_hours,
      issued_at: lic.issued_at.toISOString(),
      activated_at: lic.activated_at?.toISOString() ?? null,
      expires_at: lic.expires_at?.toISOString() ?? null,
      revoked_at: lic.revoked_at?.toISOString() ?? null,
      revoked_reason: lic.revoked_reason,
      version: lic.version,
    };
  }

  /**
   * channelId 非空时只返回该渠道的授权码 —— 渠道账号看不到其他渠道发了多少码。
   */
  async list(
    tenantId: string,
    opts: { status?: string; limit?: number; channelId?: string | null },
  ) {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const rows = await withTenantTx(this.db, tenantId, (tx) => {
      let q = tx
        .selectFrom('licenses')
        .select([
          'id',
          'code',
          'kind',
          'status',
          'issued_at',
          'activated_at',
          'expires_at',
          'device_limit',
        ])
        .orderBy('created_at', 'desc')
        .limit(limit);
      if (opts.status) q = q.where('status', '=', opts.status as LicenseStatus);
      if (opts.channelId) q = q.where('channel_id', '=', opts.channelId);
      return q.execute();
    });
    // 设备数单独聚合: 列表里能看出"已激活但一台设备都没绑"的情况
    const ids = rows.map((r) => r.id);
    const devRows =
      ids.length === 0
        ? []
        : await withTenantTx(this.db, tenantId, (tx) =>
            tx
              .selectFrom('license_activations')
              .select((eb) => ['license_id', eb.fn.countAll().as('c')])
              .where('license_id', 'in', ids)
              .where('status', '=', 'active')
              .groupBy('license_id')
              .execute(),
          );
    const devCount = new Map(devRows.map((r) => [r.license_id, Number(r.c)]));

    return rows.map((r) => ({
      id: r.id,
      code_masked: maskCode(r.code.replace(/-/g, '')),
      kind: r.kind,
      status: r.status,
      issued_at: r.issued_at.toISOString(),
      activated_at: r.activated_at?.toISOString() ?? null,
      expires_at: r.expires_at?.toISOString() ?? null,
      active_devices: devCount.get(r.id) ?? 0,
      device_limit: r.device_limit,
    }));
  }

  async renew(
    tenantId: string,
    licenseId: string,
    cmd: RenewDto,
    idemKey: string | undefined,
    actor?: ActorInfo,
  ): Promise<{ status: number; body: unknown }> {
    if (!idemKey) throw errIdempotencyKeyRequired();
    if (!Number.isInteger(cmd.days) || cmd.days < 1 || cmd.days > 36500) {
      throw errReqInvalid('days 必须为 1-36500 的整数');
    }
    return withIdempotency(
      this.db,
      {
        tenantId,
        key: idemKey,
        endpoint: 'POST /admin/v1/licenses/:id/renew',
        requestBody: cmd,
      },
      async () => {
        const data = await withTenantTx(this.db, tenantId, async (tx) => {
          const lic = await tx
            .selectFrom('licenses')
            .selectAll()
            .where('id', '=', licenseId)
            .forUpdate()
            .executeTakeFirst();
          if (!lic) throw errLicNotFound();
          if (lic.status === 'revoked') throw errStatusInvalid('已吊销授权不可续期');
          if (lic.status === 'issued') throw errStatusInvalid('未激活授权无需续期');
          if (!lic.allow_renewal || lic.kind === 'perpetual') throw errNotRenewable();
          if (
            lic.status === 'expired' &&
            lic.expires_at !== null &&
            Date.now() - lic.expires_at.getTime() > lic.renew_window_days * 86_400_000
          ) {
            throw errRenewWindow();
          }
          if (cmd.order_ref) {
            const dup = await tx
              .selectFrom('renewals')
              .selectAll()
              .where('license_id', '=', licenseId)
              .where('order_ref', '=', cmd.order_ref)
              .executeTakeFirst();
            if (dup) throw errIdempotencyConflict(`order_ref ${cmd.order_ref} 已入账`);
          }

          const oldExpires = lic.expires_at;
          await tx
            .updateTable('licenses')
            .set({
              expires_at: sql`greatest(coalesce(expires_at, now()), now()) + make_interval(days => ${cmd.days})`,
              status: lic.status === 'expired' ? 'activated' : lic.status,
              version: lic.version + 1,
              updated_at: new Date(),
            })
            .where('id', '=', licenseId)
            .execute();

          const updated = await tx
            .selectFrom('licenses')
            .selectAll()
            .where('id', '=', licenseId)
            .executeTakeFirstOrThrow();

          await tx
            .insertInto('renewals')
            .values({
              id: uuidv7(),
              tenant_id: tenantId,
              license_id: licenseId,
              days: cmd.days,
              old_expires_at: oldExpires,
              new_expires_at: updated.expires_at ?? new Date(),
              order_ref: cmd.order_ref ?? null,
              source: 'admin',
              operator_id: null,
              idem_key: idemKey,
              created_at: new Date(),
            })
            .execute();

          await emitOutbox(tx, 'license.renewed', tenantId, 'license', licenseId, {
            license_id: licenseId,
            days: cmd.days,
            new_expires_at: updated.expires_at?.toISOString() ?? null,
          });
          await writeAudit(tx, {
            tenantId,
            actorType: (actor?.actorType ?? 'system') as 'operator',
            actorId: actor?.userId ?? '00000000-0000-0000-0000-000000000000',
            action: 'license.renew',
            resourceType: 'license',
            resourceId: licenseId,
            detail: {
              days: cmd.days,
              order_ref: cmd.order_ref ?? null,
              code_masked: maskCode(lic.code.replace(/-/g, '')),
            },
            ip: actor?.ip ?? null,
            requestId: actor?.requestId ?? null,
          });

          return {
            license_id: licenseId,
            old_expires_at: oldExpires?.toISOString() ?? null,
            new_expires_at: updated.expires_at?.toISOString() ?? null,
            status: updated.status,
          };
        });
        return { status: 200, body: { data } };
      },
    );
  }

  async revoke(
    tenantId: string,
    licenseId: string,
    cmd: RevokeDto,
    idemKey: string | undefined,
    actor?: ActorInfo,
  ): Promise<{ status: number; body: unknown }> {
    if (!idemKey) throw errIdempotencyKeyRequired();
    return withIdempotency(
      this.db,
      {
        tenantId,
        key: idemKey,
        endpoint: 'POST /admin/v1/licenses/:id/revoke',
        requestBody: cmd,
      },
      async () => {
        const data = await withTenantTx(this.db, tenantId, async (tx) => {
          const lic = await tx
            .selectFrom('licenses')
            .selectAll()
            .where('id', '=', licenseId)
            .forUpdate()
            .executeTakeFirst();
          if (!lic) throw errLicNotFound();
          assertTransition(lic.status, 'revoked'); // revoked 是绝对终态: 再吊销 → 409
          await tx
            .updateTable('licenses')
            .set({
              status: 'revoked',
              revoked_at: new Date(),
              revoked_reason: cmd.reason,
              version: lic.version + 1,
              updated_at: new Date(),
            })
            .where('id', '=', licenseId)
            .execute();
          await emitOutbox(tx, 'license.revoked', tenantId, 'license', licenseId, {
            license_id: licenseId,
            reason: cmd.reason,
          });
          await writeAudit(tx, {
            tenantId,
            actorType: (actor?.actorType ?? 'system') as 'operator',
            actorId: actor?.userId ?? '00000000-0000-0000-0000-000000000000',
            action: 'license.revoke',
            resourceType: 'license',
            resourceId: licenseId,
            detail: {
              reason: cmd.reason,
              code_masked: maskCode(lic.code.replace(/-/g, '')),
            },
            ip: actor?.ip ?? null,
            requestId: actor?.requestId ?? null,
          });
          return { license_id: licenseId, status: 'revoked', reason: cmd.reason, code_hmac: lic.code_hmac };
        });
        // 事务提交后广播失效 validate 缓存(各 open-api 实例); 失败由 TTL(60s) 兜底
        if (this.redis && data.code_hmac) {
          try {
            await publishLicenseInvalidated(this.redis, {
              tenantId,
              code_hmac: Buffer.from(data.code_hmac).toString('base64url'),
            });
          } catch (e) {
            console.warn(
              '[revoke] cache invalidation publish failed (TTL 兜底):',
              (e as Error).message,
            );
          }
        }
        const { code_hmac: _ignored, ...payload } = data;
        return { status: 200, body: { data: payload } };
      },
    );
  }

  /**
   * 授权码完整轨迹: 发码 → 激活/解绑 → 续费 → 吊销, 按时间排序。
   * 数据来自 licenses 自身时间戳、renewals、license_activations 与 events。
   */
  async timeline(
    tenantId: string,
    licenseId: string,
    channelId?: string | null,
  ): Promise<Array<{ at: string; type: string; detail: Record<string, unknown> }>> {
    return withTenantTx(this.db, tenantId, async (tx) => {
      const lic = await tx
        .selectFrom('licenses')
        .selectAll()
        .where('id', '=', licenseId)
        .executeTakeFirst();
      if (!lic || (channelId && lic.channel_id !== channelId)) throw errLicNotFound();

      const events: Array<{ at: Date; type: string; detail: Record<string, unknown> }> = [];

      events.push({ at: lic.issued_at, type: 'issued', detail: { code_masked: maskCode(lic.code.replace(/-/g, '')) } });
      if (lic.activated_at) events.push({ at: lic.activated_at, type: 'activated', detail: {} });
      if (lic.suspended_at) events.push({ at: lic.suspended_at, type: 'suspended', detail: {} });
      if (lic.revoked_at) {
        events.push({ at: lic.revoked_at, type: 'revoked', detail: { reason: lic.revoked_reason } });
      }

      const acts = await tx
        .selectFrom('license_activations')
        .select(['id', 'activated_at', 'released_at', 'released_reason', 'device_id', 'end_customer_id'])
        .where('license_id', '=', licenseId)
        .execute();
      for (const a of acts) {
        events.push({
          at: a.activated_at,
          type: 'device_activated',
          detail: { activation_id: a.id, device_id: a.device_id, end_customer_id: a.end_customer_id },
        });
        if (a.released_at) {
          events.push({
            at: a.released_at,
            type: 'device_released',
            detail: { activation_id: a.id, reason: a.released_reason },
          });
        }
      }

      const renews = await tx
        .selectFrom('renewals')
        .select(['days', 'old_expires_at', 'new_expires_at', 'source', 'created_at'])
        .where('license_id', '=', licenseId)
        .execute();
      for (const r of renews) {
        events.push({
          at: r.created_at,
          type: 'renewed',
          detail: {
            days: r.days,
            source: r.source,
            old_expires_at: r.old_expires_at?.toISOString() ?? null,
            new_expires_at: r.new_expires_at.toISOString(),
          },
        });
      }

      const evs = await tx
        .selectFrom('events')
        .select(['type', 'created_at', 'payload'])
        .where('aggregate_id', '=', licenseId)
        .orderBy('created_at', 'asc')
        .limit(200)
        .execute();
      for (const e of evs) {
        // 只补尚未由时间戳覆盖的事件类型, 避免重复
        if (e.type === 'license.expire_warning') {
          events.push({ at: e.created_at, type: 'expire_warning', detail: e.payload });
        }
      }

      return events
        .sort((a, b) => a.at.getTime() - b.at.getTime())
        .map((e) => ({ at: e.at.toISOString(), type: e.type, detail: e.detail }));
    });
  }
}
