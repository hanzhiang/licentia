import { Inject, Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { AppError } from '@lp/domain';
import { hashPassword } from '@lp/auth';
import { LpDb, uuidv7, withTenantTx } from '@lp/db';
import { writeAudit } from '@lp/audit';
import { DB } from '../../db.module';
import type { ActorInfo } from '../../iam/actor';

/** 开发者可以给自己团队分配的成员角色；platform_admin 永远不在其中 */
export const MEMBER_ROLES = [
  'developer_owner',
  'developer_operator',
  'developer_support',
  'developer_finance',
  'developer_partner',
] as const;

export type MemberRole = (typeof MEMBER_ROLES)[number];

export interface MemberView {
  id: string;
  email: string;
  status: 'active' | 'disabled';
  roles: string[];
  created_at: string;
  last_login_at: string | null;
}

/**
 * 租户成员管理(开发者自己的事): 加人、改角色、停用。
 * 全部在 withTenantTx 内执行，RLS 保证只能看到/修改本租户的成员。
 */
@Injectable()
export class MemberService {
  constructor(@Inject(DB) private readonly db: Kysely<LpDb>) {}

  async list(tenantId: string): Promise<MemberView[]> {
    return withTenantTx(this.db, tenantId, async (tx) => {
      const users = await tx
        .selectFrom('users')
        .select(['id', 'email', 'status', 'created_at', 'last_login_at'])
        .where('tenant_id', '=', tenantId)
        .where('deleted_at', 'is', null)
        .orderBy('created_at', 'asc')
        .execute();
      const roles = await tx
        .selectFrom('user_roles')
        .select(['user_id', 'role_code'])
        .where(
          'user_id',
          'in',
          users.length > 0 ? users.map((u) => u.id) : [''],
        )
        .execute();
      const byUser = new Map<string, string[]>();
      for (const r of roles) {
        byUser.set(r.user_id, [...(byUser.get(r.user_id) ?? []), r.role_code]);
      }
      return users.map((u) => ({
        id: u.id,
        email: u.email,
        status: u.status as MemberView['status'],
        roles: byUser.get(u.id) ?? [],
        created_at: u.created_at.toISOString(),
        last_login_at: u.last_login_at?.toISOString() ?? null,
      }));
    });
  }

  async create(
    tenantId: string,
    cmd: { email: string; password: string; role: MemberRole },
    actor: ActorInfo,
  ): Promise<MemberView> {
    const email = cmd.email.trim().toLowerCase();
    const passwordHash = hashPassword(cmd.password);
    return withTenantTx(this.db, tenantId, async (tx) => {
      const dup = await tx
        .selectFrom('users')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('email', '=', email)
        .executeTakeFirst();
      if (dup) throw new AppError('EMAIL_TAKEN', '该邮箱已存在');

      const id = uuidv7();
      const now = new Date();
      await tx
        .insertInto('users')
        .values({
          id,
          tenant_id: tenantId,
          email,
          phone_hash: null,
          password_hash: passwordHash,
          status: 'active',
          last_login_at: null,
          // 由租户所有者创建, 视为已验证(邮箱归属由邀请人担保)
          email_verified_at: now,
          created_at: now,
          updated_at: now,
          deleted_at: null,
        })
        .execute();
      await tx.insertInto('user_roles').values({ user_id: id, role_code: cmd.role }).execute();
      await writeAudit(tx, {
        tenantId,
        actorType: actor.actorType as 'developer_owner',
        actorId: actor.userId,
        action: 'member.create',
        resourceType: 'user',
        resourceId: id,
        detail: { email, role: cmd.role },
        ip: actor.ip ?? null,
        requestId: actor.requestId ?? null,
      });
      return {
        id,
        email,
        status: 'active',
        roles: [cmd.role],
        created_at: now.toISOString(),
        last_login_at: null,
      };
    });
  }

  /** 改角色(整体替换) + 启停用。不允许操作自己，避免把唯一的 owner 锁死。 */
  async update(
    tenantId: string,
    userId: string,
    cmd: { role?: MemberRole; status?: 'active' | 'disabled' },
    actor: ActorInfo,
  ): Promise<void> {
    if (userId === actor.userId && cmd.status === 'disabled') {
      throw new AppError('REQ_INVALID', '不能停用自己的账号');
    }
    await withTenantTx(this.db, tenantId, async (tx) => {
      const target = await tx
        .selectFrom('users')
        .select(['id', 'email', 'status'])
        .where('id', '=', userId)
        .where('tenant_id', '=', tenantId)
        .executeTakeFirst();
      if (!target) throw new AppError('REQ_INVALID', '成员不存在');

      if (cmd.status) {
        await tx
          .updateTable('users')
          .set({ status: cmd.status, updated_at: new Date() })
          .where('id', '=', userId)
          .execute();
        // 停用即刻失效: 吊销全部 refresh token，下一次刷新就登不回来
        if (cmd.status === 'disabled') {
          await tx
            .updateTable('refresh_tokens')
            .set({ revoked_at: new Date() })
            .where('user_id', '=', userId)
            .where('revoked_at', 'is', null)
            .execute();
        }
      }
      if (cmd.role) {
        if (userId === actor.userId) {
          throw new AppError('REQ_INVALID', '不能修改自己的角色');
        }
        await tx.deleteFrom('user_roles').where('user_id', '=', userId).execute();
        await tx
          .insertInto('user_roles')
          .values({ user_id: userId, role_code: cmd.role })
          .execute();
      }
      await writeAudit(tx, {
        tenantId,
        actorType: actor.actorType as 'developer_owner',
        actorId: actor.userId,
        action: 'member.update',
        resourceType: 'user',
        resourceId: userId,
        detail: { email: target.email, role: cmd.role ?? null, status: cmd.status ?? null },
        ip: actor.ip ?? null,
        requestId: actor.requestId ?? null,
      });
    });
  }
}
