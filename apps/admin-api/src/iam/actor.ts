import type { FastifyRequest } from 'fastify';
import { currentUser, type RequestWithAuth } from './guards';

/** 写操作审计的主体信息(谁在何时从哪发起) */
export interface ActorInfo {
  userId: string;
  actorType: string;
  ip?: string | null;
  requestId?: string | null;
  /** 渠道账号绑定的渠道; 非渠道账号为 null —— 服务层据此收窄数据范围 */
  channelId?: string | null;
}

export function actorFrom(req: FastifyRequest): ActorInfo {
  const u = currentUser(req);
  return {
    userId: u.id,
    actorType: u.actorType,
    channelId: (req as unknown as { channelId?: string }).channelId ?? null,
    ip: clientIp(req),
    requestId: req.id != null ? String(req.id) : null,
  };
}

export function clientIp(req: FastifyRequest): string | null {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0]!.trim();
  return req.ip ?? null;
}

export type { RequestWithAuth };
