import { Inject, Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { AppError, errPolicyNotFound, errReqInvalid } from '@lp/domain';
import { encryptAead, generateCode, hmacCode, normalizePrefix } from '@lp/keygen';
import { LpDb, uuidv7, withTenantTx } from '@lp/db';
import { writeAudit } from '@lp/audit';
import { emitOutbox } from '@lp/events';
import { getConfig } from '@lp/config';
import { DB } from '../../db.module';
import type { ActorInfo } from '../../iam/actor';

export interface DeviceRequestView {
  id: string;
  request_code: string;
  product_id: string;
  product_code: string;
  product_name: string;
  platform: string;
  app_version: string | null;
  user_id: string | null;
  status: string;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
  decision_note: string | null;
  /** 批准后对应的授权码(脱敏) */
  license_id: string | null;
}

/**
 * 远程授权的"开发者侧": 查看待批准设备、批准或拒绝。
 *
 * 批准时按策略生成一张普通授权码并绑定到该设备申请；客户端轮询拿到码后
 * 走标准激活流程——这里不产生第二套鉴权。
 */
@Injectable()
export class DeviceRequestAdminService {
  constructor(@Inject(DB) private readonly db: Kysely<LpDb>) {}

  async list(tenantId: string, status = 'pending'): Promise<DeviceRequestView[]> {
    return withTenantTx(this.db, tenantId, async (tx) => {
      const rows = await tx
        .selectFrom('device_requests')
        .innerJoin('products', 'products.id', 'device_requests.product_id')
        .select([
          'device_requests.id',
          'device_requests.request_code',
          'device_requests.product_id',
          'device_requests.platform',
          'device_requests.app_version',
          'device_requests.user_id',
          'device_requests.status',
          'device_requests.created_at',
          'device_requests.expires_at',
          'device_requests.decided_at',
          'device_requests.decision_note',
          'device_requests.license_id',
          'products.code as product_code',
          'products.name as product_name',
        ])
        .where('device_requests.status', '=', status as 'pending')
        .orderBy('device_requests.created_at', 'desc')
        .limit(200)
        .execute();

      return rows.map((r) => ({
        id: r.id,
        request_code: r.request_code,
        product_id: r.product_id,
        product_code: r.product_code,
        product_name: r.product_name,
        platform: r.platform,
        app_version: r.app_version,
        user_id: r.user_id,
        status: r.status,
        created_at: r.created_at.toISOString(),
        expires_at: r.expires_at.toISOString(),
        decided_at: r.decided_at?.toISOString() ?? null,
        decision_note: r.decision_note,
        license_id: r.license_id,
      }));
    });
  }

  /** 批准: 生成授权码并绑定该设备申请 */
  async approve(
    tenantId: string,
    id: string,
    cmd: { policyId: string },
    actor: ActorInfo,
  ): Promise<{ license_id: string; code: string }> {
    const cfg = getConfig();
    return withTenantTx(this.db, tenantId, async (tx) => {
      const req = await tx
        .selectFrom('device_requests')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      if (!req) throw new AppError('REQ_INVALID', '设备申请不存在');
      if (req.status !== 'pending') throw new AppError('REQ_INVALID', '该申请已处理');
      if (req.expires_at.getTime() <= Date.now()) {
        await tx.updateTable('device_requests').set({ status: 'expired' }).where('id', '=', id).execute();
        throw new AppError('REQ_INVALID', '该设备码已过期');
      }

      const policy = await tx
        .selectFrom('policies')
        .selectAll()
        .where('id', '=', cmd.policyId)
        .where('tenant_id', '=', tenantId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!policy) throw errPolicyNotFound();
      if (policy.status !== 'active') throw errReqInvalid('策略已停用, 不能批准');
      if (policy.product_id !== req.product_id) {
        throw errReqInvalid('策略与设备申请的产品不一致');
      }

      const product = await tx
        .selectFrom('products')
        .select(['code', 'status'])
        .where('id', '=', req.product_id)
        .executeTakeFirstOrThrow();
      if (product.status !== 'active') throw errReqInvalid('产品已停用, 不能批准');

      const prefix = normalizePrefix(product.code.slice(0, 4));
      const { code, normalized } = generateCode(prefix);
      const licenseId = uuidv7();
      const now = new Date();

      await tx
        .insertInto('licenses')
        .values({
          id: licenseId,
          tenant_id: tenantId,
          product_id: req.product_id,
          policy_id: policy.id,
          batch_id: null,
          channel_id: null,
          end_customer_id: null,
          code,
          code_hmac: hmacCode(cfg.CODE_HMAC_KEY, normalized),
          code_cipher: encryptAead(cfg.CODE_ENC_KEY, code),
          kind: policy.kind,
          status: 'issued',
          device_limit: policy.device_limit,
          seat_limit: policy.seat_limit,
          concurrency_limit: policy.concurrency_limit,
          // jsonb 列: 必须显式 stringify, 否则 node-pg 会写成 PG 数组字面量
          features: JSON.stringify(policy.features) as unknown as string[],
          offline_window_days: policy.offline_window_days,
          heartbeat_hours: policy.heartbeat_hours,
          grace_hours: policy.grace_hours,
          activate_within_days: policy.activate_within_days,
          renew_window_days: policy.renew_window_days,
          allow_renewal: policy.allow_renewal,
          min_version: policy.min_version,
          duration_days: policy.duration_days,
          issued_at: now,
          activated_at: null,
          expires_at: null,
          suspended_at: null,
          revoked_at: null,
          revoked_reason: null,
          version: 1,
          created_by: actor.userId,
          created_at: now,
          updated_at: now,
        })
        .execute();

      await tx
        .updateTable('device_requests')
        .set({
          status: 'approved',
          license_id: licenseId,
          decided_by: actor.userId,
          decided_at: now,
        })
        .where('id', '=', id)
        .execute();

      await emitOutbox(tx, 'license.issued_by_approval', tenantId, 'license', licenseId, {
        license_id: licenseId,
        request_id: id,
      });
      await writeAudit(tx, {
        tenantId,
        actorType: actor.actorType as 'developer_owner',
        actorId: actor.userId,
        action: 'device_request.approve',
        resourceType: 'device_request',
        resourceId: id,
        detail: { license_id: licenseId, policy_id: policy.id, product_code: product.code },
        ip: actor.ip ?? null,
        requestId: actor.requestId ?? null,
      });

      return { license_id: licenseId, code };
    });
  }

  async reject(
    tenantId: string,
    id: string,
    note: string | null,
    actor: ActorInfo,
  ): Promise<void> {
    await withTenantTx(this.db, tenantId, async (tx) => {
      const req = await tx
        .selectFrom('device_requests')
        .select(['id', 'status'])
        .where('id', '=', id)
        .executeTakeFirst();
      if (!req) throw new AppError('REQ_INVALID', '设备申请不存在');
      if (req.status !== 'pending') throw new AppError('REQ_INVALID', '该申请已处理');

      await tx
        .updateTable('device_requests')
        .set({
          status: 'rejected',
          decided_by: actor.userId,
          decided_at: new Date(),
          decision_note: note,
        })
        .where('id', '=', id)
        .execute();
      await writeAudit(tx, {
        tenantId,
        actorType: actor.actorType as 'developer_owner',
        actorId: actor.userId,
        action: 'device_request.reject',
        resourceType: 'device_request',
        resourceId: id,
        detail: { note },
        ip: actor.ip ?? null,
        requestId: actor.requestId ?? null,
      });
    });
  }
}
