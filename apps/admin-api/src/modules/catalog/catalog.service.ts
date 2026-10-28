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
}
