import { Inject, Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import {
  errProductNotFound,
  errReqInvalid,
  validatePolicy,
  type PolicyInput,
} from '@lp/domain';
import { LpDb, uuidv7, withTenantTx } from '@lp/db';
import { writeAudit } from '@lp/audit';
import { DB } from '../../db.module';
import type { ActorInfo } from '../../iam/actor';

export interface ProductView {
  id: string;
  code: string;
  name: string;
  status: string;
}

export interface ChannelView {
  id: string;
  code: string;
  name: string;
  status: string;
}

export interface PolicyCatalogView {
  id: string;
  product_id: string;
  product_code: string;
  product_name: string;
  code: string;
  name: string;
  kind: PolicyInput['kind'];
  duration_days: number | null;
  device_limit: number;
  seat_limit: number | null;
  concurrency_limit: number | null;
  features: string[];
  offline_window_days: number;
  heartbeat_hours: number;
  grace_hours: number;
  activate_within_days: number;
  allow_renewal: boolean;
  renew_window_days: number;
  min_version: string | null;
  status: string;
}

export interface CatalogView {
  products: ProductView[];
  policies: PolicyCatalogView[];
  channels: ChannelView[];
}

export interface CreatePolicyInput extends PolicyInput {
  productId: string;
  code: string;
  name: string;
  heartbeatHours: number;
  graceHours: number;
  activateWithinDays: number;
  renewWindowDays: number;
  minVersion: string | null;
}

/** 策略可改字段: kind/product_id/code 不可变 */
export interface UpdatePolicyInput {
  name?: string;
  status?: 'active' | 'disabled';
  durationDays?: number | null;
  deviceLimit?: number;
  seatLimit?: number | null;
  concurrencyLimit?: number | null;
  features?: string[];
  offlineWindowDays?: number;
  heartbeatHours?: number;
  graceHours?: number;
  activateWithinDays?: number;
  allowRenewal?: boolean;
  renewWindowDays?: number;
  minVersion?: string | null;
}

@Injectable()
export class CatalogService {
  constructor(@Inject(DB) private readonly db: Kysely<LpDb>) {}

  async list(tenantId: string): Promise<CatalogView> {
    return withTenantTx(this.db, tenantId, async (tx) => {
      const [products, policyRows, channels] = await Promise.all([
        tx
          .selectFrom('products')
          .select(['id', 'code', 'name', 'status'])
          .where('deleted_at', 'is', null)
          .orderBy('created_at')
          .execute(),
        tx
          .selectFrom('policies')
          .innerJoin('products', 'products.id', 'policies.product_id')
          .select([
            'policies.id',
            'policies.product_id',
            'products.code as product_code',
            'products.name as product_name',
            'policies.code',
            'policies.name',
            'policies.kind',
            'policies.duration_days',
            'policies.device_limit',
            'policies.seat_limit',
            'policies.concurrency_limit',
            'policies.features',
            'policies.offline_window_days',
            'policies.heartbeat_hours',
            'policies.grace_hours',
            'policies.activate_within_days',
            'policies.allow_renewal',
            'policies.renew_window_days',
            'policies.min_version',
            'policies.status',
          ])
          .where('policies.deleted_at', 'is', null)
          .orderBy('policies.created_at')
          .execute(),
        tx
          .selectFrom('channels')
          .select(['id', 'code', 'name', 'status'])
          .where('deleted_at', 'is', null)
          .orderBy('created_at')
          .execute(),
      ]);
      return {
        products,
        channels,
        policies: policyRows.map((p) => ({
          id: p.id,
          product_id: p.product_id,
          product_code: p.product_code,
          product_name: p.product_name,
          code: p.code,
          name: p.name,
          kind: p.kind as PolicyInput['kind'],
          duration_days: p.duration_days,
          device_limit: p.device_limit,
          seat_limit: p.seat_limit,
          concurrency_limit: p.concurrency_limit,
          features: p.features,
          offline_window_days: p.offline_window_days,
          heartbeat_hours: p.heartbeat_hours,
          grace_hours: p.grace_hours,
          activate_within_days: p.activate_within_days,
          allow_renewal: p.allow_renewal,
          renew_window_days: p.renew_window_days,
          min_version: p.min_version,
          status: p.status,
        })),
      };
    });
  }

  async createProduct(
    tenantId: string,
    cmd: { code: string; name: string },
    actor: ActorInfo,
  ): Promise<ProductView> {
    return withTenantTx(this.db, tenantId, async (tx) => {
      const dup = await tx
        .selectFrom('products')
        .select('id')
        .where('code', '=', cmd.code)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (dup) throw errReqInvalid('产品编码已存在');
      const row = await tx
        .insertInto('products')
        .values({
          id: uuidv7(),
          tenant_id: tenantId,
          code: cmd.code,
          name: cmd.name,
          status: 'active',
          created_at: new Date(),
          updated_at: new Date(),
          deleted_at: null,
        })
        .returning(['id', 'code', 'name', 'status'])
        .executeTakeFirstOrThrow();
      await writeAudit(tx, {
        tenantId,
        actorType: actor.actorType as 'tenant_admin',
        actorId: actor.userId,
        action: 'product.create',
        resourceType: 'product',
        resourceId: row.id,
        detail: { code: row.code, name: row.name },
        ip: actor.ip ?? null,
        requestId: actor.requestId ?? null,
      });
      return row;
    });
  }

  async createChannel(
    tenantId: string,
    cmd: { code: string; name: string },
    actor: ActorInfo,
  ): Promise<ChannelView> {
    return withTenantTx(this.db, tenantId, async (tx) => {
      const dup = await tx
        .selectFrom('channels')
        .select('id')
        .where('code', '=', cmd.code)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (dup) throw errReqInvalid('渠道编码已存在');
      const row = await tx
        .insertInto('channels')
        .values({
          id: uuidv7(),
          tenant_id: tenantId,
          code: cmd.code,
          name: cmd.name,
          status: 'active',
          created_at: new Date(),
          deleted_at: null,
        })
        .returning(['id', 'code', 'name', 'status'])
        .executeTakeFirstOrThrow();
      await writeAudit(tx, {
        tenantId,
        actorType: actor.actorType as 'operator',
        actorId: actor.userId,
        action: 'channel.create',
        resourceType: 'channel',
        resourceId: row.id,
        detail: { code: row.code, name: row.name },
        ip: actor.ip ?? null,
        requestId: actor.requestId ?? null,
      });
      return row;
    });
  }

  async createPolicy(
    tenantId: string,
    cmd: CreatePolicyInput,
    actor: ActorInfo,
  ): Promise<{ id: string; code: string; name: string }> {
    const errors = validatePolicy(cmd);
    if (errors.length > 0) throw errReqInvalid(errors.join('; '), { errors });

    return withTenantTx(this.db, tenantId, async (tx) => {
      const product = await tx
        .selectFrom('products')
        .select('id')
        .where('id', '=', cmd.productId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!product) throw errProductNotFound();
      const dup = await tx
        .selectFrom('policies')
        .select('id')
        .where('code', '=', cmd.code)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (dup) throw errReqInvalid('策略编码已存在');
      const row = await tx
        .insertInto('policies')
        .values({
          id: uuidv7(),
          tenant_id: tenantId,
          product_id: cmd.productId,
          code: cmd.code,
          name: cmd.name,
          kind: cmd.kind,
          duration_days: cmd.durationDays,
          device_limit: cmd.deviceLimit,
          seat_limit: cmd.seatLimit,
          concurrency_limit: cmd.concurrencyLimit,
          features: JSON.stringify(cmd.features) as unknown as string[],
          offline_window_days: cmd.offlineWindowDays,
          heartbeat_hours: cmd.heartbeatHours,
          grace_hours: cmd.graceHours,
          activate_within_days: cmd.activateWithinDays,
          allow_renewal: cmd.allowRenewal,
          renew_window_days: cmd.renewWindowDays,
          min_version: cmd.minVersion,
          status: 'active',
          created_by: actor.userId,
          created_at: new Date(),
          updated_at: new Date(),
          deleted_at: null,
        })
        .returning(['id', 'code', 'name'])
        .executeTakeFirstOrThrow();
      await writeAudit(tx, {
        tenantId,
        actorType: actor.actorType as 'tenant_admin',
        actorId: actor.userId,
        action: 'policy.create',
        resourceType: 'policy',
        resourceId: row.id,
        detail: { code: row.code, kind: cmd.kind },
        ip: actor.ip ?? null,
        requestId: actor.requestId ?? null,
      });
      return row;
    });
  }

  /**
   * 改产品名/启停。停用只是不再允许发新码，已发出的授权不受影响。
   * 编码不可改: 它是授权码前缀与产品归属的锚点。
   */
  async updateProduct(
    tenantId: string,
    id: string,
    cmd: { name?: string; status?: 'active' | 'disabled' },
    actor: ActorInfo,
  ): Promise<ProductView> {
    return withTenantTx(this.db, tenantId, async (tx) => {
      const current = await tx
        .selectFrom('products')
        .select(['id', 'code', 'name', 'status'])
        .where('id', '=', id)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!current) throw errProductNotFound();
      const row = await tx
        .updateTable('products')
        .set({
          name: cmd.name ?? current.name,
          status: cmd.status ?? current.status,
          updated_at: new Date(),
        })
        .where('id', '=', id)
        .returning(['id', 'code', 'name', 'status'])
        .executeTakeFirstOrThrow();
      await writeAudit(tx, {
        tenantId,
        actorType: actor.actorType as 'developer_owner',
        actorId: actor.userId,
        action: 'product.update',
        resourceType: 'product',
        resourceId: id,
        detail: { code: row.code, name: row.name, status: row.status },
        ip: actor.ip ?? null,
        requestId: actor.requestId ?? null,
      });
      return row;
    });
  }

  async updateChannel(
    tenantId: string,
    id: string,
    cmd: { name?: string; status?: 'active' | 'disabled' },
    actor: ActorInfo,
  ): Promise<ChannelView> {
    return withTenantTx(this.db, tenantId, async (tx) => {
      const current = await tx
        .selectFrom('channels')
        .select(['id', 'code', 'name', 'status'])
        .where('id', '=', id)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!current) throw errReqInvalid('渠道不存在');
      const row = await tx
        .updateTable('channels')
        .set({
          name: cmd.name ?? current.name,
          status: cmd.status ?? current.status,
        })
        .where('id', '=', id)
        .returning(['id', 'code', 'name', 'status'])
        .executeTakeFirstOrThrow();
      await writeAudit(tx, {
        tenantId,
        actorType: actor.actorType as 'developer_operator',
        actorId: actor.userId,
        action: 'channel.update',
        resourceType: 'channel',
        resourceId: id,
        detail: { code: row.code, name: row.name, status: row.status },
        ip: actor.ip ?? null,
        requestId: actor.requestId ?? null,
      });
      return row;
    });
  }

  /**
   * 改策略。注意: 已发出的授权在发码时复制了策略字段, 这里改的只影响之后新发的码。
   * kind / product_id / code 不可改 —— 它们决定商业形态与授权码归属, 改了会让历史码语义漂移。
   */
  async updatePolicy(
    tenantId: string,
    id: string,
    cmd: UpdatePolicyInput,
    actor: ActorInfo,
  ): Promise<{ id: string; code: string; name: string; status: string }> {
    return withTenantTx(this.db, tenantId, async (tx) => {
      const current = await tx
        .selectFrom('policies')
        .selectAll()
        .where('id', '=', id)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!current) throw errReqInvalid('策略不存在');

      const merged = {
        kind: current.kind as PolicyInput['kind'],
        durationDays: cmd.durationDays !== undefined ? cmd.durationDays : current.duration_days,
        deviceLimit: cmd.deviceLimit ?? current.device_limit,
        seatLimit: cmd.seatLimit !== undefined ? cmd.seatLimit : current.seat_limit,
        concurrencyLimit:
          cmd.concurrencyLimit !== undefined ? cmd.concurrencyLimit : current.concurrency_limit,
        features: cmd.features ?? current.features,
        offlineWindowDays: cmd.offlineWindowDays ?? current.offline_window_days,
        allowRenewal: cmd.allowRenewal ?? current.allow_renewal,
      };
      const errors = validatePolicy(merged);
      if (errors.length > 0) throw errReqInvalid(errors.join('; '), { errors });

      const row = await tx
        .updateTable('policies')
        .set({
          name: cmd.name ?? current.name,
          duration_days: merged.durationDays,
          device_limit: merged.deviceLimit,
          seat_limit: merged.seatLimit,
          concurrency_limit: merged.concurrencyLimit,
          features: JSON.stringify(merged.features) as unknown as string[],
          offline_window_days: merged.offlineWindowDays,
          heartbeat_hours: cmd.heartbeatHours ?? current.heartbeat_hours,
          grace_hours: cmd.graceHours ?? current.grace_hours,
          activate_within_days: cmd.activateWithinDays ?? current.activate_within_days,
          allow_renewal: merged.allowRenewal,
          renew_window_days: cmd.renewWindowDays ?? current.renew_window_days,
          min_version: cmd.minVersion !== undefined ? cmd.minVersion : current.min_version,
          status: cmd.status ?? current.status,
          updated_at: new Date(),
        })
        .where('id', '=', id)
        .returning(['id', 'code', 'name', 'status'])
        .executeTakeFirstOrThrow();
      await writeAudit(tx, {
        tenantId,
        actorType: actor.actorType as 'developer_owner',
        actorId: actor.userId,
        action: 'policy.update',
        resourceType: 'policy',
        resourceId: id,
        detail: { code: row.code, status: row.status, changes: Object.keys(cmd) },
        ip: actor.ip ?? null,
        requestId: actor.requestId ?? null,
      });
      return row;
    });
  }

  /**
   * 删除产品(软删)。已有授权码的产品不允许删——那会让历史授权失去归属;
   * 这种情况应改用停用。
   */
  async deleteProduct(tenantId: string, id: string, actor: ActorInfo): Promise<void> {
    await withTenantTx(this.db, tenantId, async (tx) => {
      const p = await tx
        .selectFrom('products')
        .select(['id', 'code', 'name'])
        .where('id', '=', id)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!p) throw errProductNotFound();

      const used = await tx
        .selectFrom('licenses')
        .select((eb) => eb.fn.countAll().as('c'))
        .where('product_id', '=', id)
        .executeTakeFirstOrThrow();
      if (Number(used.c) > 0) {
        throw errReqInvalid(`该产品下还有 ${used.c} 个授权码，不能删除；请改用「停用」`);
      }
      const pols = await tx
        .selectFrom('policies')
        .select((eb) => eb.fn.countAll().as('c'))
        .where('product_id', '=', id)
        .where('deleted_at', 'is', null)
        .executeTakeFirstOrThrow();
      if (Number(pols.c) > 0) {
        throw errReqInvalid(`该产品下还有 ${pols.c} 个策略，请先删除策略`);
      }

      await tx
        .updateTable('products')
        .set({ deleted_at: new Date(), updated_at: new Date() })
        .where('id', '=', id)
        .execute();
      await writeAudit(tx, {
        tenantId,
        actorType: actor.actorType as 'developer_owner',
        actorId: actor.userId,
        action: 'product.delete',
        resourceType: 'product',
        resourceId: id,
        detail: { code: p.code, name: p.name },
        ip: actor.ip ?? null,
        requestId: actor.requestId ?? null,
      });
    });
  }

  /** 删除策略(软删)；已发过码的策略不允许删 */
  async deletePolicy(tenantId: string, id: string, actor: ActorInfo): Promise<void> {
    await withTenantTx(this.db, tenantId, async (tx) => {
      const p = await tx
        .selectFrom('policies')
        .select(['id', 'code', 'name'])
        .where('id', '=', id)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!p) throw errReqInvalid('策略不存在');

      const used = await tx
        .selectFrom('licenses')
        .select((eb) => eb.fn.countAll().as('c'))
        .where('policy_id', '=', id)
        .executeTakeFirstOrThrow();
      if (Number(used.c) > 0) {
        throw errReqInvalid(`该策略已用于 ${used.c} 个授权码，不能删除；请改用「停用」`);
      }

      await tx
        .updateTable('policies')
        .set({ deleted_at: new Date(), updated_at: new Date() })
        .where('id', '=', id)
        .execute();
      await writeAudit(tx, {
        tenantId,
        actorType: actor.actorType as 'developer_owner',
        actorId: actor.userId,
        action: 'policy.delete',
        resourceType: 'policy',
        resourceId: id,
        detail: { code: p.code, name: p.name },
        ip: actor.ip ?? null,
        requestId: actor.requestId ?? null,
      });
    });
  }

  /** 删除渠道(软删)；已发过码或建过批次的渠道不允许删 */
  async deleteChannel(tenantId: string, id: string, actor: ActorInfo): Promise<void> {
    await withTenantTx(this.db, tenantId, async (tx) => {
      const c = await tx
        .selectFrom('channels')
        .select(['id', 'code', 'name'])
        .where('id', '=', id)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!c) throw errReqInvalid('渠道不存在');

      const used = await tx
        .selectFrom('licenses')
        .select((eb) => eb.fn.countAll().as('c'))
        .where('channel_id', '=', id)
        .executeTakeFirstOrThrow();
      const batches = await tx
        .selectFrom('license_batches')
        .select((eb) => eb.fn.countAll().as('c'))
        .where('channel_id', '=', id)
        .executeTakeFirstOrThrow();
      if (Number(used.c) > 0 || Number(batches.c) > 0) {
        throw errReqInvalid(
          `该渠道已有 ${batches.c} 个批次 / ${used.c} 个授权码，不能删除；请改用「停用」`,
        );
      }

      await tx
        .updateTable('channels')
        .set({ deleted_at: new Date() })
        .where('id', '=', id)
        .execute();
      await writeAudit(tx, {
        tenantId,
        actorType: actor.actorType as 'developer_operator',
        actorId: actor.userId,
        action: 'channel.delete',
        resourceType: 'channel',
        resourceId: id,
        detail: { code: c.code, name: c.name },
        ip: actor.ip ?? null,
        requestId: actor.requestId ?? null,
      });
    });
  }
}
