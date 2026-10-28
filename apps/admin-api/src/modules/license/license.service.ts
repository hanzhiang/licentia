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

  async get(tenantId: string, licenseId: string) {
    const lic = await withTenantTx(this.db, tenantId, (tx) =>
      tx.selectFrom('licenses').selectAll().where('id', '=', licenseId).executeTakeFirst(),
    );
    if (!lic) throw errLicNotFound();
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

  async list(tenantId: string, opts: { status?: string; limit?: number }) {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const rows = await withTenantTx(this.db, tenantId, (tx) => {
      let q = tx
        .selectFrom('licenses')
        .select(['id', 'code', 'kind', 'status', 'issued_at', 'activated_at', 'expires_at'])
        .orderBy('created_at', 'desc')
        .limit(limit);
      if (opts.status) q = q.where('status', '=', opts.status as LicenseStatus);
      return q.execute();
    });
    return rows.map((r) => ({
      id: r.id,
      code_masked: maskCode(r.code.replace(/-/g, '')),
      kind: r.kind,
      status: r.status,
      issued_at: r.issued_at.toISOString(),
      activated_at: r.activated_at?.toISOString() ?? null,
      expires_at: r.expires_at?.toISOString() ?? null,
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
}
