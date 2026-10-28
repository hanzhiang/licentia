import { CanActivate, ExecutionContext, Inject, Injectable, Optional } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { AppError } from '@lp/domain';
import { authenticateApiKey, type LpDb } from '@lp/db';
import type { Redis } from '@lp/cache';
import { DB } from './db.module';
import { REDIS } from './redis.module';

function extractBearer(req: FastifyRequest): string | null {
  const header = req.headers['authorization'];
  return typeof header === 'string' && header.startsWith('Bearer ')
    ? header.slice(7).trim()
    : null;
}

/**
 * 开放 API 鉴权(设计文档 §13/§14): api_keys 表 + scope 校验 + 每 Key 秒级限流(Redis 固定窗).
 * Key 体系: lpk_live_ 前缀, 前 20 字符定位, SHA-256 常数时间比较.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    @Inject(DB) private readonly db: Kysely<LpDb>,
    @Optional() @Inject(REDIS) private readonly redis?: Redis | null,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const key = extractBearer(req);
    if (!key) throw new AppError('API_KEY_INVALID', '缺少 Bearer API Key');
    const auth = await authenticateApiKey(this.db, key);
    if (!auth.scopes.includes('validate') && !auth.scopes.includes('*')) {
      throw new AppError('API_KEY_SCOPE_DENIED', '该 Key 无 validate 权限');
    }
    if (this.redis) {
      try {
        const sec = Math.floor(Date.now() / 1000);
        const rlKey = `lp:rl:apikey:${auth.id}:${sec}`;
        const n = await this.redis.incr(rlKey);
        if (n === 1) await this.redis.expire(rlKey, 2);
        if (n > auth.rateLimitQps) {
          throw new AppError('RATE_LIMITED', `超过该 Key 限流(${auth.rateLimitQps} QPS)`);
        }
      } catch (e) {
        if (e instanceof AppError) throw e;
        // Redis 不可用 → 限流降级放行(容量保护由 Ingress 层承担)
      }
    }
    (req as unknown as { tenantId: string }).tenantId = auth.tenantId;
    (req as unknown as { apiKeyId: string }).apiKeyId = auth.id;
    return true;
  }
}
