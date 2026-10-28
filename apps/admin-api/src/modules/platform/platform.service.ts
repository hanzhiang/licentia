import { Inject, Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { AppError } from '@lp/domain';
import { LpDb, withSystemTx } from '@lp/db';
import { writeAudit } from '@lp/audit';
import { DB } from '../../db.module';
import type { ActorInfo } from '../../iam/actor';

/**
 * 平台层: 管理"开发者账号"(= 租户)的存在与状态。
 *
 * 边界(硬性):
 *  - 只返回聚合数字与账号元信息，绝不返回授权码、终端用户、设备等业务明细
 *  - 没有任何写入租户业务数据的入口；停用只是改 tenants.status
 *  - 平台账号本身没有 tenant_id，租户业务接口在 requireTenantId 处就被拒绝
 */
export interface DeveloperAccountView {
  id: string;
  code: string;
  name: string;
  status: 'active' | 'suspended' | 'closed';
  plan: string;
  created_at: string;
  /** 以下均为聚合计数，不含任何实体明细 */
  usage: {
    users: number;
    products: number;
    licenses_total: number;
    licenses_activated: number;
    last_activity_at: string | null;
  };
}

@Injectable()
export class PlatformService {
  constructor(@Inject(DB) private readonly db: Kysely<LpDb>) {}

  async listDevelopers(limit = 200): Promise<DeveloperAccountView[]> {
    return withSystemTx(this.db, async (tx) => {
      const tenants = await tx
        .selectFrom('tenants')
        .select(['id', 'code', 'name', 'status', 'plan', 'created_at'])
        .where('deleted_at', 'is', null)
        .orderBy('created_at', 'desc')
        .limit(Math.min(Math.max(limit, 1), 500))
        .execute();

      const userAgg = await tx
        .selectFrom('users')
        .select(['tenant_id', sql<string>`count(*)`.as('c')])
        .where('tenant_id', 'is not', null)
        .groupBy('tenant_id')
        .execute();

      const productAgg = await tx
        .selectFrom('products')
        .select(['tenant_id', sql<string>`count(*)`.as('c')])
        .groupBy('tenant_id')
        .execute();

      const licenseAgg = await tx
        .selectFrom('licenses')
        .select([
          'tenant_id',
          sql<string>`count(*)`.as('total'),
          sql<string>`count(*) filter (where status = 'activated')`.as('activated'),
          sql<string>`max(updated_at)`.as('last_at'),
        ])
        .groupBy('tenant_id')
        .execute();

      const users = new Map(userAgg.map((r) => [r.tenant_id!, Number(r.c)]));
      const products = new Map(productAgg.map((r) => [r.tenant_id, Number(r.c)]));
      const licenses = new Map(licenseAgg.map((r) => [r.tenant_id, r]));

      return tenants.map((t) => {
        const lic = licenses.get(t.id);
        return {
          id: t.id,
          code: t.code,
          name: t.name,
          status: t.status as DeveloperAccountView['status'],
          plan: t.plan,
          created_at: t.created_at.toISOString(),
          usage: {
            users: users.get(t.id) ?? 0,
            products: products.get(t.id) ?? 0,
            licenses_total: lic ? Number(lic.total) : 0,
            licenses_activated: lic ? Number(lic.activated) : 0,
            last_activity_at: lic?.last_at ? new Date(lic.last_at).toISOString() : null,
          },
        };
      });
    });
  }

  async getDeveloper(id: string): Promise<DeveloperAccountView> {
    const all = await this.listDevelopers(500);
    const found = all.find((d) => d.id === id);
    if (!found) throw new AppError('REQ_INVALID', '开发者账号不存在');
    return found;
  }

  /** 停用/恢复开发者账号。停用后该租户所有成员无法登录，客户端心跳也会被拒。 */
  async setStatus(
    id: string,
    status: 'active' | 'suspended',
    actor: ActorInfo,
  ): Promise<void> {
    await withSystemTx(this.db, async (tx) => {
      const t = await tx
        .selectFrom('tenants')
        .select(['id', 'name', 'status'])
        .where('id', '=', id)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!t) throw new AppError('REQ_INVALID', '开发者账号不存在');
      await tx
        .updateTable('tenants')
        .set({ status, updated_at: new Date() })
        .where('id', '=', id)
        .execute();
      await writeAudit(tx, {
        tenantId: null, // 平台动作记在平台链上，不进租户审计链
        actorType: 'platform_admin',
        actorId: actor.userId,
        action: status === 'active' ? 'platform.developer.resume' : 'platform.developer.suspend',
        resourceType: 'tenant',
        resourceId: id,
        detail: { developer: t.name, previous_status: t.status },
        ip: actor.ip ?? null,
        requestId: actor.requestId ?? null,
      });
    });
  }
}
