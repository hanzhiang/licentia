import { Inject, Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { AppError, errLicNotFound } from '@lp/domain';
import { encryptAead } from '@lp/keygen';
import { LpDb, withTenantTx } from '@lp/db';
import { writeAudit } from '@lp/audit';
import { getConfig } from '@lp/config';
import { DB } from '../../db.module';
import type { ActorInfo } from '../../iam/actor';

export interface EndCustomerView {
  id: string;
  name: string;
  type: string;
  has_email: boolean;
  status: string;
  license_count: number;
}

/**
 * 终端客户(设计文档 §16): 到期提醒的收件人来源.
 *
 * 手机号以 HMAC 存(不可逆, 门户用它做登录主体), 因此短信通道无法直接取明文;
 * 邮箱走 AES 加密存储, 是当前唯一可还原的投递地址 —— 所以这里提供「维护联系邮箱」
 * 的入口, 否则通知会永久停在 blocked.
 */
@Injectable()
export class EndCustomersService {
  constructor(@Inject(DB) private readonly db: Kysely<LpDb>) {}

  async list(tenantId: string, limit = 100): Promise<EndCustomerView[]> {
    const rows = await withTenantTx(this.db, tenantId, (tx) =>
      tx
        .selectFrom('end_customers')
        .leftJoin('licenses', 'licenses.end_customer_id', 'end_customers.id')
        .select((eb) => [
          'end_customers.id',
          'end_customers.name',
          'end_customers.type',
          'end_customers.status',
          'end_customers.contact_email_enc',
          eb.fn.count('licenses.id').as('license_count'),
        ])
        .where('end_customers.deleted_at', 'is', null)
        .groupBy([
          'end_customers.id',
          'end_customers.name',
          'end_customers.type',
          'end_customers.status',
          'end_customers.contact_email_enc',
        ])
        .orderBy('end_customers.created_at', 'desc')
        .limit(Math.min(limit, 500))
        .execute(),
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      has_email: r.contact_email_enc !== null,
      status: r.status,
      license_count: Number(r.license_count),
    }));
  }

  /**
   * 设置/清除联系邮箱. 传 null 清除; 邮箱明文不经日志/审计(审计只记是否设置).
   */
  async setContactEmail(
    tenantId: string,
    id: string,
    email: string | null,
    actor: ActorInfo,
  ): Promise<void> {
    const cfg = getConfig();
    await withTenantTx(this.db, tenantId, async (tx) => {
      const org = await tx
        .selectFrom('end_customers')
        .select(['id'])
        .where('id', '=', id)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!org) throw errLicNotFound();
      await tx
        .updateTable('end_customers')
        .set({
          contact_email_enc: email === null ? null : encryptAead(cfg.NOTIFY_ADDR_ENC_KEY, email),
        })
        .where('id', '=', id)
        .execute();
      await writeAudit(tx, {
        tenantId,
        actorType: actor.actorType as 'tenant_admin',
        actorId: actor.userId,
        action: 'end_customer.set_contact_email',
        resourceType: 'end_customer',
        resourceId: id,
        detail: { has_email: email !== null }, // 不落明文
      });
    });
  }
}

export function parseEmailOrThrow(value: unknown): string | null {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw new AppError('REQ_INVALID', '邮箱格式不合法');
  }
  return value;
}
