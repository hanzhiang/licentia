import { Inject, Injectable, Optional } from '@nestjs/common';
import crypto from 'node:crypto';
import { Kysely } from 'kysely';
import { AppError } from '@lp/domain';
import { hmacCode } from '@lp/keygen';
import { LpDb, uuidv7, withSystemTx } from '@lp/db';
import { getConfig } from '@lp/config';
import type { Redis } from '@lp/cache';
import { DB } from '../../db.module';
import { REDIS } from '../../redis.module';

/** 设备码有效期: 太短用户来不及报给客服, 太长会堆积僵尸请求 */
const REQUEST_TTL_MS = 10 * 60 * 1000;
const POLL_INTERVAL_S = 3;
/** 同一设备每小时最多申请次数, 防刷 */
const CREATE_PER_HOUR = 5;

/** 展示用字符集: 去掉 0/O/1/I/L 等易混字符 */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export interface CreateDeviceRequestInput {
  productCode: string;
  tenantCode?: string;
  appVersion?: string;
  userId?: string;
  device: { fpType: string; fingerprint: string; platform: string };
}

export interface CreateDeviceRequestResult {
  request_code: string;
  expires_at: string;
  poll_interval_s: number;
}

export type PollResult =
  | { status: 'pending'; expires_at: string }
  | { status: 'expired' }
  | { status: 'rejected'; note: string | null }
  | { status: 'approved'; code: string; product_code: string };

function randomRequestCode(): string {
  const pick = (): string => CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)]!;
  const raw = Array.from({ length: 8 }, pick).join('');
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/**
 * 远程授权(设计文档 §4.2 的第二种激活方式).
 *
 * 客户端没有授权码时, 把自己的设备指纹上报, 拿到一个短码展示给用户;
 * 用户把短码报给客服/开发者, 后者在后台批准, 客户端轮询到结果后自行完成激活。
 *
 * 批准后下发的仍是一张普通授权码 —— 心跳/离线/校验全部复用现有链路,
 * 不存在第二套鉴权。
 */
@Injectable()
export class DeviceRequestService {
  constructor(
    @Inject(DB) private readonly db: Kysely<LpDb>,
    @Optional() @Inject(REDIS) private readonly redis?: Redis | null,
  ) {}

  async create(
    input: CreateDeviceRequestInput,
    ip: string | null,
  ): Promise<CreateDeviceRequestResult> {
    const cfg = getConfig();
    const fingerprint = hmacCode(
      cfg.FINGERPRINT_PEPPER,
      `${input.device.fpType}:${input.device.fingerprint}`,
    );
    await this.enforceRateLimit(fingerprint);

    return withSystemTx(this.db, async (tx) => {
      // 产品在租户内唯一, 但跨租户可能重名: 带 tenant_code 时按租户定位,
      // 否则要求全局唯一, 有歧义就直接报错而不是猜。
      let q = tx
        .selectFrom('products')
        .innerJoin('tenants', 'tenants.id', 'products.tenant_id')
        .select([
          'products.id as product_id',
          'products.tenant_id',
          'products.code as product_code',
          'tenants.status as tenant_status',
        ])
        .where('products.code', '=', input.productCode)
        .where('products.deleted_at', 'is', null)
        .where('products.status', '=', 'active');
      if (input.tenantCode) q = q.where('tenants.code', '=', input.tenantCode);
      const found = await q.execute();
      if (found.length === 0) throw new AppError('PRODUCT_NOT_FOUND', '产品不存在或未启用');
      if (found.length > 1) {
        throw new AppError('REQ_INVALID', '该产品编码在多个开发者下存在，请带上开发者编码');
      }
      const product = found[0]!;
      if (product.tenant_status !== 'active') {
        throw new AppError('TENANT_SUSPENDED', '该开发者账号已被停用');
      }

      const requestCode = randomRequestCode();
      const expiresAt = new Date(Date.now() + REQUEST_TTL_MS);
      await tx
        .insertInto('device_requests')
        .values({
          id: uuidv7(),
          request_code: requestCode,
          tenant_id: product.tenant_id,
          product_id: product.product_id,
          fp_type: input.device.fpType,
          fingerprint,
          platform: input.device.platform,
          app_version: input.appVersion ?? null,
          user_id: input.userId ?? null,
          status: 'pending',
          license_id: null,
          decided_by: null,
          decided_at: null,
          decision_note: null,
          created_at: new Date(),
          expires_at: expiresAt,
        })
        .execute();

      return {
        request_code: requestCode,
        expires_at: expiresAt.toISOString(),
        poll_interval_s: POLL_INTERVAL_S,
      };
    });
  }

  /**
   * 客户端轮询。必须带同样的设备指纹——否则拿到短码的人就能把别人的授权领走。
   */
  async poll(
    requestCode: string,
    device: { fpType: string; fingerprint: string },
  ): Promise<PollResult> {
    const cfg = getConfig();
    const fingerprint = hmacCode(
      cfg.FINGERPRINT_PEPPER,
      `${device.fpType}:${device.fingerprint}`,
    );

    return withSystemTx(this.db, async (tx) => {
      const row = await tx
        .selectFrom('device_requests')
        .selectAll()
        .where('request_code', '=', requestCode)
        .executeTakeFirst();
      // 短码不存在或指纹不符, 一律按不存在处理
      if (!row || !row.fingerprint.equals(fingerprint)) {
        throw new AppError('LIC_NOT_FOUND', '设备申请不存在');
      }

      if (row.status === 'pending' && row.expires_at.getTime() <= Date.now()) {
        await tx
          .updateTable('device_requests')
          .set({ status: 'expired' })
          .where('id', '=', row.id)
          .execute();
        return { status: 'expired' };
      }

      if (row.status === 'pending') {
        return { status: 'pending', expires_at: row.expires_at.toISOString() };
      }
      if (row.status === 'rejected') {
        return { status: 'rejected', note: row.decision_note };
      }
      if (row.status === 'expired') {
        return { status: 'expired' };
      }

      // approved: 下发授权码, 客户端随后走标准激活流程
      const lic = await tx
        .selectFrom('licenses')
        .select(['code'])
        .where('id', '=', row.license_id!)
        .executeTakeFirstOrThrow();
      const product = await tx
        .selectFrom('products')
        .select(['code'])
        .where('id', '=', row.product_id)
        .executeTakeFirstOrThrow();
      return { status: 'approved', code: lic.code, product_code: product.code };
    });
  }

  private async enforceRateLimit(fingerprint: Buffer): Promise<void> {
    if (!this.redis) return;
    const key = `lp:devreq:${fingerprint.toString('base64url')}`;
    try {
      const n = await this.redis.incr(key);
      if (n === 1) await this.redis.expire(key, 3600);
      if (n > CREATE_PER_HOUR) {
        throw new AppError('RATE_LIMITED', '设备码申请过于频繁, 请稍后再试');
      }
    } catch (e) {
      if (e instanceof AppError) throw e;
      /* Redis 故障时不阻断申请 */
    }
  }
}
