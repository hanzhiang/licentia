import { Inject, Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { errLicNotFound } from '@lp/domain';
import { maskCode } from '@lp/keygen';
import { LpDb, withTenantTx } from '@lp/db';
import { emitOutbox } from '@lp/events';
import { writeAudit } from '@lp/audit';
import { DB } from '../../db.module';
import type { ActorInfo } from '../../iam/actor';

export interface ActivationView {
  activation_id: string;
  status: string;
  activated_at: string;
  last_seen_at: string | null;
  device: {
    id: string;
    fp_type: string;
    platform: string;
    display_name: string | null;
    blocked: boolean;
  } | null;
}

/**
 * 设备管理(设计文档 §4.4 / §12):
 *  - 解绑即时生效: 同事务删除该激活的全部 client_token, 设备下次心跳 401
 *  - 激活行不删除(留痕), released_by/reason 满足审计要求
 */
@Injectable()
export class ActivationsService {
  constructor(@Inject(DB) private readonly db: Kysely<LpDb>) {}

  async listByLicense(tenantId: string, licenseId: string): Promise<ActivationView[]> {
    const rows = await withTenantTx(this.db, tenantId, (tx) =>
      tx
        .selectFrom('license_activations')
        .selectAll('license_activations')
        .leftJoin('devices', 'devices.id', 'license_activations.device_id')
        .select([
          'devices.id as dev_id',
          'devices.fp_type',
          'devices.platform',
          'devices.display_name',
          'devices.blocked',
        ])
        .where('license_activations.license_id', '=', licenseId)
        .where('license_activations.status', '=', 'active')
        .orderBy('license_activations.activated_at', 'desc')
        .limit(200)
        .execute(),
    );
    return rows.map((r) => ({
      activation_id: r.id,
      status: r.status,
      activated_at: r.activated_at.toISOString(),
      last_seen_at: r.last_seen_at?.toISOString() ?? null,
      device: r.dev_id
        ? {
            id: r.dev_id,
            fp_type: r.fp_type ?? '',
            platform: r.platform ?? '',
            display_name: r.display_name,
            blocked: r.blocked ?? false,
          }
        : null,
    }));
  }

  async release(
    tenantId: string,
    activationId: string,
    cmd: { reason: string },
    actor: ActorInfo,
  ): Promise<{ released: boolean; activation_id: string }> {
    return withTenantTx(this.db, tenantId, async (tx) => {
      const act = await tx
        .selectFrom('license_activations')
        .selectAll()
        .where('id', '=', activationId)
        .forUpdate()
        .executeTakeFirst();
      if (!act) throw errLicNotFound();
      if (act.status === 'released') {
        return { released: false, activation_id: act.id }; // 幂等: 重复解绑
      }
      await tx
        .updateTable('license_activations')
        .set({
          status: 'released',
          released_at: new Date(),
          released_by: actor.userId,
          released_reason: cmd.reason,
        })
        .where('id', '=', act.id)
        .execute();
      // 解绑即时生效: 杀掉该激活的全部 client token
      await tx.deleteFrom('client_tokens').where('activation_id', '=', act.id).execute();

      const lic = await tx
        .selectFrom('licenses')
        .select(['code'])
        .where('id', '=', act.license_id)
        .executeTakeFirstOrThrow();
      await emitOutbox(tx, 'license.device_unbound', tenantId, 'license', act.license_id, {
        license_id: act.license_id,
        activation_id: act.id,
        device_id: act.device_id,
        reason: cmd.reason,
      });
      await writeAudit(tx, {
        tenantId,
        actorType: actor.actorType as 'support',
        actorId: actor.userId,
        action: 'device.release',
        resourceType: 'license',
        resourceId: act.license_id,
        detail: {
          activation_id: act.id,
          device_id: act.device_id,
          reason: cmd.reason,
          code_masked: maskCode(lic.code.replace(/-/g, '')),
        },
        ip: actor.ip ?? null,
        requestId: actor.requestId ?? null,
      });
      return { released: true, activation_id: act.id };
    });
  }
}
