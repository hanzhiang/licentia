import type { FastifyRequest } from 'fastify';
import { currentUser, type RequestWithAuth } from './guards';

/** 写操作审计的主体信息(谁在何时从哪发起) */
export interface ActorInfo {
  userId: string;
  actorType: string;
  ip?: string | null;
  requestId?: string | null;
}

export function actorFrom(req: FastifyRequest): ActorInfo {
  const u = currentUser(req);
  return {
    userId: u.id,
    actorType: u.actorType,
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
