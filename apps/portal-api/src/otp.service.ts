import { Inject, Injectable, Optional } from '@nestjs/common';
import crypto from 'node:crypto';
import { Kysely } from 'kysely';
import { AppError } from '@lp/domain';
import { hmacCode } from '@lp/keygen';
import { LpDb, withSystemTx } from '@lp/db';
import { signJwt } from '@lp/auth';
import type { Redis } from '@lp/cache';
import { getConfig } from '@lp/config';
import { DB } from './db.module';
import { REDIS } from './redis.module';

const OTP_TTL_S = 300;
const OTP_RESEND_COOLDOWN_S = 60;
const OTP_DAILY_LIMIT = 10;

export interface OtpRequestResult {
  sent: boolean;
  /** 仅 NODE_ENV=dev 返回(无短信网关的开发链路), 生产恒为 undefined */
  dev_code?: string;
}

export interface PortalLoginResult {
  portal_token: string;
  expires_in: number;
  tenant_id: string;
}

/**
 * 门户 OTP 登录(设计文档 §12 自助门户 / §14):
 *  - Redis 频控: 同手机号 60s 一次、每日 10 条
 *  - 验证码 5min 有效, 一次一用(验证后删除)
 *  - 骨架无短信网关: dev 环境把验证码随响应返回, 生产接 SMS 后移除 dev_code
 *  - 手机号原文不落库: 全程 HMAC(FINGERPRINT_PEPPER), 会话 JWT sub=phoneHash
 */
@Injectable()
export class OtpService {
  constructor(
    @Inject(DB) private readonly db: Kysely<LpDb>,
    @Optional() @Inject(REDIS) private readonly redis?: Redis | null,
  ) {}

  phoneHash(phone: string): Buffer {
    return hmacCode(getConfig().FINGERPRINT_PEPPER, `phone:${phone}`);
  }

  async requestOtp(phone: string, tenantId: string): Promise<OtpRequestResult> {
    if (!this.redis) throw new AppError('DEPENDENCY_UNAVAILABLE', 'OTP 需要 Redis');
    const day = new Date().toISOString().slice(0, 10);
    const dailyKey = `lp:otp:cnt:${tenantId}:${phone}:${day}`;
    const count = await this.redis.incr(dailyKey);
    if (count === 1) await this.redis.expire(dailyKey, 86_400);
    if (count > OTP_DAILY_LIMIT) {
      throw new AppError('RATE_LIMITED', '今日验证码发送次数已达上限');
    }
    const cooldownKey = `lp:otp:cd:${tenantId}:${phone}`;
    const ok = await this.redis.set(cooldownKey, '1', 'EX', OTP_RESEND_COOLDOWN_S, 'NX');
    if (!ok) throw new AppError('RATE_LIMITED', '发送过于频繁, 请稍后再试');

    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    await this.redis.set(`lp:otp:${tenantId}:${phone}`, code, 'EX', OTP_TTL_S);
    // 生产: 接入短信网关发送(§16 notify); 非生产环境(含 e2e 的 NODE_ENV=test)随响应返回验证码
    const dev = getConfig().NODE_ENV !== 'prod';
    return { sent: true, ...(dev ? { dev_code: code } : {}) };
  }

  async verifyOtp(phone: string, code: string, tenantId: string): Promise<PortalLoginResult> {
    if (!this.redis) throw new AppError('DEPENDENCY_UNAVAILABLE', 'OTP 需要 Redis');
    const key = `lp:otp:${tenantId}:${phone}`;
    const stored = await this.redis.get(key);
    if (!stored || stored !== code) {
      throw new AppError('AUTH_REQUIRED', '验证码错误或已过期');
    }
    await this.redis.del(key); // 一次一用
    const cfg = getConfig();
    const token = signJwt(
      { sub: this.phoneHash(phone).toString('base64url'), tid: tenantId, typ: 'portal' },
      cfg.PORTAL_TOKEN_TTL_H * 3600,
      { keysDir: cfg.AUTH_JWT_KEYS_DIR, kid: cfg.AUTH_JWT_KID },
    );
    void this.db;
    return {
      portal_token: token,
      expires_in: cfg.PORTAL_TOKEN_TTL_H * 3600,
      tenant_id: tenantId,
    };
  }
}
