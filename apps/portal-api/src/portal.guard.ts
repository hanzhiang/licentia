import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AppError } from '@lp/domain';
import { verifyJwt } from '@lp/auth';
import { getConfig } from '@lp/config';

export interface PortalRequest extends FastifyRequest {
  phoneHash?: string;
  tenantId?: string;
}

export function portalCtx(req: FastifyRequest): { phoneHash: string; tenantId: string } {
  const r = req as PortalRequest;
  if (!r.phoneHash || !r.tenantId) throw new AppError('AUTH_REQUIRED', '门户会话无效');
  return { phoneHash: r.phoneHash, tenantId: r.tenantId };
}

function extractBearer(req: FastifyRequest): string {
  const header = req.headers['authorization'];
  const token =
    typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!token) throw new AppError('AUTH_REQUIRED', '缺少门户令牌');
  return token;
}

/** 门户会话守卫: 仅接受 typ=portal 的 JWT(access 令牌不得调用门户, 反之亦然) */
@Injectable()
export class PortalAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const cfg = getConfig();
    let claims;
    try {
      claims = verifyJwt(
        extractBearer(req),
        {
          keysDir: cfg.AUTH_JWT_KEYS_DIR,
          kid: cfg.AUTH_JWT_KID,
        },
        ['portal'],
      );
    } catch {
      throw new AppError('AUTH_REQUIRED', '门户会话已过期或无效');
    }
    if (!claims.tid) throw new AppError('AUTH_REQUIRED', '门户令牌缺少租户上下文');
    (req as PortalRequest).phoneHash = claims.sub;
    (req as PortalRequest).tenantId = claims.tid;
    return true;
  }
}
