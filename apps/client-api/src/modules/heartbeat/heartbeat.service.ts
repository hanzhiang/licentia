import { Inject, Injectable, Optional } from '@nestjs/common';
import { Kysely } from 'kysely';
import { AppError, errAuthRequired, errSeatConcurrency } from '@lp/domain';
import { hmacCode } from '@lp/keygen';
import { LpDb, setBypassRls, setTenantGuc, withSystemTx } from '@lp/db';
import { generateClientToken, hashClientToken } from '@lp/auth';
import type { Redis } from '@lp/cache';
import type { LicenseSigner } from '@lp/signer';
import { getConfig, type AppConfig } from '@lp/config';
import { DB } from '../../db.module';
import { REDIS } from '../../redis.module';
import { SIGNER } from '../../signer.module';
import { entitlementErrorOrThrow } from '../activate/activate.service';

export interface HeartbeatResult {
  status: string;
  features: string[];
  expires_at: string | null;
  client_token: string;
  offline_license: string | null;
  server_time: number;
}

/**
 * 心跳续验(设计文档 §4.3): token 验证 → 惰性权益判定 → last_seen 节流写库 → token 轮换(5min 重叠).
 */
@Injectable()
export class HeartbeatService {
  constructor(
    @Inject(DB) private readonly db: Kysely<LpDb>,
    @Inject(SIGNER) private readonly signer: LicenseSigner,
    @Optional() @Inject(REDIS) private readonly redis?: Redis | null,
  ) {}

  async heartbeat(
    authorization: string | undefined,
    context?: { userId?: string },
  ): Promise<HeartbeatResult> {
    const cfg = getConfig() as AppConfig;
    const token = extractBearer(authorization);
    const tokenHash = hashClientToken(token);

    return withSystemTx(this.db, async (tx) => {
      const row = await tx
        .selectFrom('client_tokens')
        .selectAll()
        .where('token_hash', '=', tokenHash)
        .executeTakeFirst();
      if (!row || row.expires_at.getTime() <= Date.now()) {
        throw errAuthRequired('client token 无效或已过期');
      }
      await setTenantGuc(tx, row.tenant_id);
      await setBypassRls(tx, false);

      const lic = await tx
        .selectFrom('licenses')
        .selectAll()
        .where('id', '=', row.license_id)
        .executeTakeFirstOrThrow();
      entitlementErrorOrThrow(lic); // 410/423 语义化失败

      const act = await tx
        .selectFrom('license_activations')
        .selectAll()
        .where('id', '=', row.activation_id)
        .where('status', '=', 'active')
        .executeTakeFirst();
      if (!act) {
        // 已被解绑(管理端/自助换机): token 随解绑删除, 此处兜底
        throw errAuthRequired('设备已解绑或会话失效, 请重新激活');
      }

      // last_seen 节流: 距上次超过心跳间隔一半才写库(50万日活下的写放大控制)
      const throttleBefore = new Date(Date.now() - Math.floor(lic.heartbeat_hours * 1_800_000));
      await tx
        .updateTable('license_activations')
        .set({ last_seen_at: new Date() })
        .where('id', '=', act.id)
        .where((eb) =>
          eb.or([eb('last_seen_at', 'is', null), eb('last_seen_at', '<', throttleBefore)]),
        )
        .execute();
      await tx
        .updateTable('devices')
        .set({ last_seen_at: new Date() })
        .where('id', '=', act.device_id)
        .where((eb) =>
          eb.or([eb('last_seen_at', 'is', null), eb('last_seen_at', '<', throttleBefore)]),
        )
        .execute();

      const newToken = generateClientToken();
      await tx
        .insertInto('client_tokens')
        .values({
          token_hash: hashClientToken(newToken),
          activation_id: act.id,
          license_id: lic.id,
          tenant_id: lic.tenant_id,
          expires_at: new Date(Date.now() + cfg.CLIENT_TOKEN_TTL_HOURS * 3_600_000),
          created_at: new Date(),
        })
        .execute();
      // 旧 token 保留重叠窗口后失效(客户端崩溃时重试仍可用)
      await tx
        .updateTable('client_tokens')
        .set({ expires_at: new Date(Date.now() + cfg.CLIENT_TOKEN_OVERLAP_MIN * 60_000) })
        .where('token_hash', '=', tokenHash)
        .execute();

      // 席位/浮动并发在线计数(设计文档 §12): Redis ZSET 滑动窗, score=last_seen_ms
      // 组织许可按 user_id 计席位(HMAC 后成员), 个人许可按激活记录。
      // 策略里的 seat_limit / concurrency_limit 在这里**真正生效**——此前只是
      // 写进离线许可的元数据, 服务端从不校验, 等于摆设。
      if (this.redis) {
        // 在线窗口取心跳间隔: 超过一个心跳周期没上报的成员不再占席位
        const windowMs = Math.max(lic.heartbeat_hours, 1) * 3_600_000;
        const seatKey = `lp:seats:${lic.id}`;
        const concKey = `lp:conc:${lic.id}`;
        const seatMember = context?.userId
          ? hmacCode(cfg.FINGERPRINT_PEPPER, `user:${context.userId}`).toString('base64url')
          : act.id;
        const nowMs = Date.now();
        try {
          // 先清窗口外的条目, 否则历史成员会一直占着席位
          await this.redis.zremrangebyscore(seatKey, 0, nowMs - windowMs);
          await this.redis.zremrangebyscore(concKey, 0, nowMs - windowMs);

          if (lic.seat_limit !== null) {
            const already = await this.redis.zscore(seatKey, seatMember);
            const used = await this.redis.zcard(seatKey);
            if (already === null && used >= lic.seat_limit) {
              throw errSeatConcurrency(`席位已满(${lic.seat_limit} 个)`);
            }
          }
          if (lic.concurrency_limit !== null) {
            const already = await this.redis.zscore(concKey, act.id);
            const used = await this.redis.zcard(concKey);
            if (already === null && used >= lic.concurrency_limit) {
              throw errSeatConcurrency(`并发已满(${lic.concurrency_limit} 个)`);
            }
          }

          await this.redis.zadd(seatKey, nowMs, seatMember);
          await this.redis.zadd(concKey, nowMs, act.id);
          // 没有新心跳时 key 自然过期, 避免许可删除后残留
          await this.redis.pexpire(seatKey, windowMs);
          await this.redis.pexpire(concKey, windowMs);
        } catch (e) {
          // 限额必须真的拒绝; 仅 Redis 自身故障时降级放行(否则抖一下会踢掉所有客户端)
          if (e instanceof AppError) throw e;
          console.warn('[heartbeat] 席位/并发计数不可用:', (e as Error).message);
        }
      }

      const product = await tx
        .selectFrom('products')
        .selectAll()
        .where('id', '=', lic.product_id)
        .executeTakeFirstOrThrow();

      const device = act.device_id
        ? await tx.selectFrom('devices').selectAll().where('id', '=', act.device_id).executeTakeFirstOrThrow()
        : null;

      const offline =
        lic.offline_window_days > 0
          ? await this.signer.issueOfflineLicense({
              licenseId: lic.id,
              tenantId: lic.tenant_id,
              productCode: product.code,
              features: lic.features,
              offlineWindowDays: lic.offline_window_days,
              deviceHash: device?.fingerprint,
              seatLimit: lic.seat_limit,
              concurrencyLimit: lic.concurrency_limit,
            })
          : null;

      return {
        status: lic.status,
        features: lic.features,
        expires_at: lic.expires_at ? lic.expires_at.toISOString() : null,
        client_token: newToken,
        offline_license: offline,
        server_time: Math.floor(Date.now() / 1000),
      };
    });
  }
}

export function extractBearer(header: string | undefined): string {
  if (!header || !header.startsWith('Bearer ')) {
    throw errAuthRequired('缺少 Bearer client token');
  }
  const token = header.slice(7).trim();
  if (token.length < 16) throw new AppError('AUTH_REQUIRED', 'client token 格式错误');
  return token;
}
