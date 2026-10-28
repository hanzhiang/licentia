import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { AppError, errAuthRequired, errPermDenied } from '@lp/domain';
import { verifyJwt } from '@lp/auth';
import { getConfig } from '@lp/config';
import { RBAC, RbacService, primaryActorType, type AuthUser } from './iam.module';

export interface RequestWithAuth extends FastifyRequest {
  user?: AuthUser;
  tenantId?: string;
}

export function currentUser(req: FastifyRequest): AuthUser {
  const u = (req as RequestWithAuth).user;
  if (!u) throw errAuthRequired();
  return u;
}

/**
 * 取租户上下文: 租户账号锁定本租户; 平台账号(super_admin)必须用 X-Tenant-Id 指定目标租户.
 * 服务端唯一信任来源是 JWT → DB, 请求体/查询参数中的 tenant_id 一律不信任(§3 四层强制第3层).
 */
export function requireTenantId(req: FastifyRequest): string {
  const tid = (req as RequestWithAuth).tenantId;
  if (!tid) {
    throw new AppError('REQ_INVALID', '平台账号需通过 X-Tenant-Id 头指定目标租户');
  }
  return tid;
}

function extractBearer(req: FastifyRequest): string {
  const header = req.headers['authorization'];
  const token =
    typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!token) throw errAuthRequired('缺少 Bearer token');
  return token;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(@Inject(RBAC) private readonly rbac: RbacService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const cfg = getConfig();
    let claims;
    try {
      claims = verifyJwt(extractBearer(req), {
        keysDir: cfg.AUTH_JWT_KEYS_DIR,
        kid: cfg.AUTH_JWT_KID,
      });
    } catch (e) {
      const code = (e as Error).message;
      throw errAuthRequired(code === 'JWT_EXPIRED' ? '登录已过期' : '访问令牌无效');
    }
    const user = await this.rbac.userById(claims.sub);
    if (!user || user.status !== 'active') throw errAuthRequired('用户不存在或已停用');
    const roles = await this.rbac.rolesOf(user.id);
    const authUser: AuthUser = {
      id: user.id,
      email: user.email,
      tenantId: user.tenant_id,
      roles,
      actorType: primaryActorType(roles),
    };
    const override = req.headers['x-tenant-id'];
    if (typeof override === 'string' && override.length > 0) {
      if (!roles.includes('super_admin')) throw errPermDenied('仅平台账号可切换租户');
      (req as RequestWithAuth).tenantId = override;
    } else {
      (req as RequestWithAuth).tenantId = user.tenant_id ?? undefined;
    }
    (req as RequestWithAuth).user = authUser;
    return true;
  }
}

export const RequirePerms = (...perms: string[]) => SetMetadata('perms', perms);

@Injectable()
export class PermGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(RBAC) private readonly rbac: RbacService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const need = this.reflector.get<string[]>('perms', context.getHandler()) ?? [];
    if (need.length === 0) return true;
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const u = currentUser(req);
    const perms = await this.rbac.permsOf(u.id);
    const ok = perms.includes('*') || need.every((p) => perms.includes(p));
    if (!ok) throw errPermDenied(`缺少权限: ${need.join(',')}`);
    return true;
  }
}

/** 管理端受保护路由的简写: JWT 认证 + 权限点 */
export const Authed = (...perms: string[]) => UseGuards(JwtAuthGuard, PermGuard);
