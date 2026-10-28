import { Inject, Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { errLicNotFound } from '@lp/domain';
import {
  LpDb,
  uuidv7,
  withTenantTx,
  generateApiKey,
  sha256ApiKey,
  API_KEY_PREFIX_LEN,
} from '@lp/db';
import { writeAudit } from '@lp/audit';
import { DB } from '../../db.module';
import type { ActorInfo } from '../../iam/actor';

export interface ApiKeyView {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  rate_limit_qps: number;
  status: string;
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

/**
 * API Key 生命周期(设计文档 §14): 明文仅创建/轮换时返回一次; 存储 SHA-256;
 * 前缀定位 + 常数时间比较; 轮换保留旧 key 7 天重叠.
 */
@Injectable()
export class ApiKeysService {
  constructor(@Inject(DB) private readonly db: Kysely<LpDb>) {}

  async create(
    tenantId: string,
    cmd: { name: string; scopes: string[]; rate_limit_qps?: number },
    actor: ActorInfo,
  ): Promise<{ key: string; view: ApiKeyView }> {
    const { key, prefix, keyHash } = generateApiKey();
    const row = await withTenantTx(this.db, tenantId, async (tx) => {
      const inserted = await tx
        .insertInto('api_keys')
        .values({
          id: uuidv7(),
          tenant_id: tenantId,
          name: cmd.name,
          prefix,
          key_hash: keyHash,
          scopes: cmd.scopes,
          rate_limit_qps: cmd.rate_limit_qps ?? 500,
          ip_allowlist: [],
          status: 'active',
          expires_at: null,
          last_used_at: null,
          rotated_from_id: null,
          created_by: actor.userId,
          created_at: new Date(),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await writeAudit(tx, {
        tenantId,
        actorType: actor.actorType as 'tenant_admin',
        actorId: actor.userId,
        action: 'api_key.create',
        resourceType: 'api_key',
        resourceId: inserted.id,
        detail: { name: cmd.name, scopes: cmd.scopes },
        ip: actor.ip ?? null,
        requestId: actor.requestId ?? null,
      });
      return inserted;
    });
    return { key, view: this.toView(row) };
  }

  async list(tenantId: string): Promise<ApiKeyView[]> {
    const rows = await withTenantTx(this.db, tenantId, (tx) =>
      tx
        .selectFrom('api_keys')
        .selectAll()
        .where('status', '<>', 'revoked')
        .orderBy('created_at', 'desc')
        .limit(100)
        .execute(),
    );
    return rows.map((r) => this.toView(r));
  }

  async rotate(
    tenantId: string,
    id: string,
    actor: ActorInfo,
  ): Promise<{ key: string; view: ApiKeyView }> {
    const { key, prefix, keyHash } = generateApiKey();
    const view = await withTenantTx(this.db, tenantId, async (tx) => {
      const old = await tx
        .selectFrom('api_keys')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!old) throw errLicNotFound();
      const inserted = await tx
        .insertInto('api_keys')
        .values({
          id: uuidv7(),
          tenant_id: tenantId,
          name: old.name,
          prefix,
          key_hash: keyHash,
          scopes: old.scopes,
          rate_limit_qps: old.rate_limit_qps,
          ip_allowlist: old.ip_allowlist,
          status: 'active',
          expires_at: null,
          last_used_at: null,
          rotated_from_id: old.id,
          created_by: actor.userId,
          created_at: new Date(),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await tx
        .updateTable('api_keys')
        .set({ status: 'rotated', expires_at: new Date(Date.now() + 7 * 86_400_000) })
        .where('id', '=', old.id)
        .execute();
      await writeAudit(tx, {
        tenantId,
        actorType: actor.actorType as 'tenant_admin',
        actorId: actor.userId,
        action: 'api_key.rotate',
        resourceType: 'api_key',
        resourceId: id,
        detail: { new_key_id: inserted.id, overlap_days: 7 },
        ip: actor.ip ?? null,
        requestId: actor.requestId ?? null,
      });
      return inserted;
    });
    return { key, view: this.toView(view) };
  }

  async revoke(tenantId: string, id: string, actor: ActorInfo): Promise<ApiKeyView> {
    const row = await withTenantTx(this.db, tenantId, async (tx) => {
      const existing = await tx
        .selectFrom('api_keys')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!existing) throw errLicNotFound();
      if (existing.status === 'revoked') return existing; // 幂等
      const updated = await tx
        .updateTable('api_keys')
        .set({ status: 'revoked' })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await writeAudit(tx, {
        tenantId,
        actorType: actor.actorType as 'tenant_admin',
        actorId: actor.userId,
        action: 'api_key.revoke',
        resourceType: 'api_key',
        resourceId: id,
        detail: { name: existing.name },
        ip: actor.ip ?? null,
        requestId: actor.requestId ?? null,
      });
      return updated;
    });
    return this.toView(row);
  }

  /** 开放 API 鉴权统一走 @lp/db 的 authenticateApiKey(供 open-api 复用) */

  private toView(r: {
    id: string;
    name: string;
    prefix: string;
    scopes: string[];
    rate_limit_qps: number;
    status: string;
    expires_at: Date | null;
    last_used_at: Date | null;
    created_at: Date;
  }): ApiKeyView {
    return {
      id: r.id,
      name: r.name,
      prefix: r.prefix,
      scopes: r.scopes,
      rate_limit_qps: r.rate_limit_qps,
      status: r.status,
      expires_at: r.expires_at?.toISOString() ?? null,
      last_used_at: r.last_used_at?.toISOString() ?? null,
      created_at: r.created_at.toISOString(),
    };
  }
}
