import { Global, Module } from '@nestjs/common';
import { Kysely } from 'kysely';
import type { Redis } from '@lp/cache';
import { LpDb, withSystemTx } from '@lp/db';
import { DB } from '../db.module';
import { REDIS } from '../redis.module';

export const RBAC = Symbol('RBAC');

export interface AuthUser {
  id: string;
  email: string;
  tenantId: string | null;
  roles: string[];
  actorType: string;
}

export interface UserRow {
  id: string;
  tenant_id: string | null;
  email: string;
  status: string;
  email_verified_at: Date | null;
}

/** 角色主类型映射(审计 actor_type 用) */
export function primaryActorType(roles: string[]): string {
  const order = [
    'platform_admin',
    'developer_owner',
    'developer_operator',
    'developer_support',
    'developer_finance',
    'developer_partner',
  ];
  for (const r of order) if (roles.includes(r)) return r;
  return 'system';
}

export class RbacService {
  constructor(
    private readonly db: Kysely<LpDb>,
    private readonly redis: Redis | null,
  ) {}

  async userById(userId: string): Promise<UserRow | null> {
    const row = await withSystemTx(this.db, async (tx) =>
      await tx
        .selectFrom('users')
        .select(['id', 'tenant_id', 'email', 'status', 'email_verified_at'])
        .where('id', '=', userId)
        .executeTakeFirst(),
    );
    return row ?? null;
  }

  async userByEmail(email: string): Promise<UserRow | null> {
    const row = await withSystemTx(this.db, async (tx) =>
      await tx
        .selectFrom('users')
        .select(['id', 'tenant_id', 'email', 'status', 'email_verified_at'])
        .where('email', '=', email)
        .orderBy('created_at')
        .executeTakeFirst(),
    );
    return row ?? null;
  }

  async rolesOf(userId: string): Promise<string[]> {
    const rows = await withSystemTx(this.db, (tx) =>
      tx.selectFrom('user_roles').select('role_code').where('user_id', '=', userId).execute(),
    );
    return rows.map((r) => r.role_code);
  }

  /** 权限点: Redis 缓存 60s, 改角色后最迟 60s 生效; Redis 不可用直落 DB */
  async permsOf(userId: string): Promise<string[]> {
    const cacheKey = `lp:rbac:user:${userId}`;
    if (this.redis) {
      try {
        const cached = await this.redis.get(cacheKey);
        if (cached) return JSON.parse(cached) as string[];
      } catch {
        /* fallthrough */
      }
    }
    const rows = await withSystemTx(this.db, (tx) =>
      tx
        .selectFrom('user_roles')
        .innerJoin('role_permissions', 'role_permissions.role_code', 'user_roles.role_code')
        .select('perm')
        .where('user_roles.user_id', '=', userId)
        .execute(),
    );
    const perms = [...new Set(rows.map((r) => r.perm))];
    if (this.redis) {
      try {
        await this.redis.set(cacheKey, JSON.stringify(perms), 'EX', 60);
      } catch {
        /* ignore */
      }
    }
    return perms;
  }
}

@Global()
@Module({
  providers: [
    {
      provide: RBAC,
      useFactory: (db: Kysely<LpDb>, redis: Redis | null) => new RbacService(db, redis),
      inject: [DB, REDIS],
    },
  ],
  exports: [RBAC],
})
export class IamModule {}
