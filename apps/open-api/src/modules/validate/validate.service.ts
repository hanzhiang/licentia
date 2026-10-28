import {
  Inject,
  Injectable,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { Kysely } from 'kysely';
import { computeEntitlement } from '@lp/domain';
import { hmacCode, normalizeCode } from '@lp/keygen';
import { LpDb, withTenantTx } from '@lp/db';
import { subscribeInvalidation, type Redis } from '@lp/cache';
import { getConfig } from '@lp/config';
import { DB } from '../../db.module';
import { REDIS } from '../../redis.module';
import { TtlCache } from './ttl-cache';

export interface ValidateResult {
  valid: boolean;
  reason?: string;
  license_id?: string;
  status?: string;
  features?: string[];
  expires_at?: string | null;
  device?: { bound: number; limit: number };
  seats?: { used: number; limit: number | null };
  concurrency?: { used: number; limit: number | null };
  cache: 'HIT' | 'MISS';
  server_time: number;
}

/**
 * 开放 API 校验(设计文档 §4.7): Redis 共享缓存(60s, 跨实例) + 吊销事件主动失效 + TTL 兜底.
 * 席位 used 来自 Redis ZSET 滑动窗(lp:seats:{license_id}, 24h), 无 Redis 时退化为激活设备数.
 */
@Injectable()
export class ValidateService implements OnModuleInit {
  private readonly cache: TtlCache<Omit<ValidateResult, 'cache'>>;

  constructor(
    @Inject(DB) private readonly db: Kysely<LpDb>,
    @Optional() @Inject(REDIS) private readonly redis?: Redis | null,
  ) {
    this.cache = new TtlCache(getConfig().VALIDATE_CACHE_TTL_S * 1000);
  }

  /** 订阅吊销/状态变更失效广播: 同删本地与 Redis 缓存 */
  onModuleInit(): void {
    if (!this.redis) return;
    subscribeInvalidation(this.redis, async (msg) => {
      this.cache.invalidate(`${msg.tenantId}|${msg.code_hmac}`);
      try {
        await this.redis?.del(`lp:val:${msg.tenantId}|${msg.code_hmac}`);
      } catch {
        /* TTL 兜底 */
      }
    });
  }

  async validate(tenantId: string, code: string): Promise<ValidateResult> {
    const normalized = normalizeCode(code); // 400 LIC_CODE_MALFORMED
    const codeHmac = hmacCode(getConfig().CODE_HMAC_KEY, normalized);
    const key = `${tenantId}|${codeHmac.toString('base64url')}`;
    const redisKey = `lp:val:${key}`;

    if (this.redis) {
      try {
        const cached = await this.redis.get(redisKey);
        if (cached) return { ...(JSON.parse(cached) as Omit<ValidateResult, 'cache'>), cache: 'HIT' };
      } catch {
        /* fallthrough 到本地缓存 */
      }
    }
    const local = this.cache.get(key);
    if (local) return { ...local, cache: 'HIT' };

    const result = await this.compute(tenantId, codeHmac);
    this.cache.set(key, result);
    if (this.redis) {
      try {
        await this.redis.set(redisKey, JSON.stringify(result), 'EX', getConfig().VALIDATE_CACHE_TTL_S);
      } catch {
        /* ignore */
      }
    }
    return { ...result, cache: 'MISS' };
  }

  private async compute(
    tenantId: string,
    codeHmac: Buffer,
  ): Promise<Omit<ValidateResult, 'cache'>> {
    const nowSec = Math.floor(Date.now() / 1000);
    const lic = await withTenantTx(this.db, tenantId, (tx) =>
      tx.selectFrom('licenses').selectAll().where('code_hmac', '=', codeHmac).executeTakeFirst(),
    );
    if (!lic) return { valid: false, reason: 'LIC_NOT_FOUND', server_time: nowSec };

    const ent = computeEntitlement({ status: lic.status, expiresAt: lic.expires_at });
    if (!ent.valid) {
      return {
        valid: false,
        reason: ent.reason,
        license_id: lic.id,
        status: lic.status,
        server_time: nowSec,
      };
    }

    const bound = await withTenantTx(this.db, tenantId, (tx) =>
      tx
        .selectFrom('license_activations')
        .select((eb) => eb.fn.countAll().as('cnt'))
        .where('license_id', '=', lic.id)
        .where('status', '=', 'active')
        .executeTakeFirstOrThrow(),
    );
    const boundCount = Number(bound.cnt);
    let seatsUsed = boundCount;
    if (this.redis) {
      try {
        seatsUsed = await this.redis.zcount(
          `lp:seats:${lic.id}`,
          Date.now() - 24 * 3600 * 1000,
          '+inf',
        );
      } catch {
        /* 保留激活设备数 */
      }
    }
    return {
      valid: true,
      license_id: lic.id,
      status: lic.status,
      features: lic.features,
      expires_at: lic.expires_at?.toISOString() ?? null,
      device: { bound: boundCount, limit: lic.device_limit },
      seats: { used: seatsUsed, limit: lic.seat_limit },
      concurrency: { used: 0, limit: lic.concurrency_limit },
      server_time: nowSec,
    };
  }
}
