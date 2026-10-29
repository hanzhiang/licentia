import { Inject, Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { AppError, errLicNotFound, errReqInvalid } from '@lp/domain';
import { decryptAead, encryptAead, maskCode } from '@lp/keygen';
import { LpDb, uuidv7, withTenantTx } from '@lp/db';
import { writeAudit } from '@lp/audit';
import { buildChannels } from '@lp/notify';
import { getConfig } from '@lp/config';
import { DB } from '../../db.module';
import type { ActorInfo } from '../../iam/actor';

export interface DeliveryOutcome {
  sent: boolean;
  to: string | null;
  channel: string;
  count: number;
  error: string | null;
}

/** 单封邮件里最多塞多少个码: 再多就该用导出文件, 而不是灌满收件箱 */
export const MAX_CODES_PER_MAIL = 200;

/** 邮箱脱敏: 只留首字符与域名, 用于审计与列表展示 */
function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

/**
 * 授权码交付(发码 → 交到客户手里).
 *
 * 此前链路止于"生成 CSV 落盘": 运营还得自己把文件发出去, 系统不留任何交付痕迹。
 * 这里把最后一段补上——把码直接发给客户, 并写审计。
 *
 * 收件人不传时, 回落到授权绑定的组织联系人邮箱(end_customers.contact_email_enc);
 * 两者都没有则明确报错, 而不是静默算成功。
 */
@Injectable()
export class DeliveryService {
  constructor(@Inject(DB) private readonly db: Kysely<LpDb>) {}

  async deliverLicense(
    tenantId: string,
    licenseId: string,
    to: string | null,
    actor: ActorInfo,
  ): Promise<DeliveryOutcome> {
    const lic = await withTenantTx(this.db, tenantId, (tx) =>
      tx.selectFrom('licenses').selectAll().where('id', '=', licenseId).executeTakeFirst(),
    );
    // 渠道账号只能交付本渠道的码
    if (!lic || (actor.channelId && lic.channel_id !== actor.channelId)) throw errLicNotFound();

    const product = await withTenantTx(this.db, tenantId, (tx) =>
      tx
        .selectFrom('products')
        .select(['name'])
        .where('id', '=', lic.product_id)
        .executeTakeFirst(),
    );

    const recipient = to ?? (await this.contactEmailOf(tenantId, lic.end_customer_id));
    const outcome = await this.send(
      recipient,
      `【授权码】${product?.name ?? '您的产品'}`,
      [
        '你好，',
        '',
        `这是你的授权码：`,
        '',
        lic.code,
        '',
        lic.expires_at
          ? `有效期至 ${lic.expires_at.toISOString().slice(0, 10)}。`
          : '该授权为永久授权。',
        `可激活设备数：${lic.device_limit}。`,
        '',
        '请在客户端中输入该授权码完成激活。如有疑问请联系你的供应商。',
      ].join('\n'),
    );

    await withTenantTx(this.db, tenantId, async (tx) => {
      await this.recordDelivery(tx, tenantId, {
        licenseId,
        batchId: null,
        channel: outcome.channel,
        to: outcome.to,
        count: 1,
        status: outcome.sent ? 'sent' : 'failed',
        error: outcome.error,
        actorId: actor.userId,
      });
      await writeAudit(tx, {
        tenantId,
        actorType: actor.actorType as 'developer_operator',
        actorId: actor.userId,
        action: 'license.deliver',
        resourceType: 'license',
        resourceId: licenseId,
        detail: {
          // 审计里不写明文收件地址
          to_masked: outcome.to ? maskEmail(outcome.to) : null,
          sent: outcome.sent,
          channel: outcome.channel,
          code_masked: maskCode(lic.code.replace(/-/g, '')),
        },
        ip: actor.ip ?? null,
        requestId: actor.requestId ?? null,
      });
    });
    return outcome;
  }

  async deliverBatch(
    tenantId: string,
    batchId: string,
    to: string | null,
    limit: number,
    actor: ActorInfo,
  ): Promise<DeliveryOutcome> {
    const batch = await withTenantTx(this.db, tenantId, (tx) =>
      tx
        .selectFrom('license_batches')
        .select(['id', 'code', 'product_id', 'quantity', 'channel_id'])
        .where('id', '=', batchId)
        .executeTakeFirst(),
    );
    if (!batch) throw errReqInvalid('批次不存在');
    if (actor.channelId && batch.channel_id !== actor.channelId) {
      throw errReqInvalid('批次不存在');
    }

    const cap = Math.min(Math.max(limit, 1), MAX_CODES_PER_MAIL);
    const rows = await withTenantTx(this.db, tenantId, (tx) =>
      tx
        .selectFrom('licenses')
        .select(['code'])
        .where('batch_id', '=', batchId)
        .orderBy('issued_at', 'asc')
        .limit(cap + 1)
        .execute(),
    );
    if (rows.length === 0) throw errReqInvalid('该批次没有可交付的授权码');
    if (rows.length > cap) {
      throw errReqInvalid(
        `该批次超过 ${cap} 个码，请调大 limit 或改用 CSV 导出后由渠道分发`,
      );
    }

    const product = await withTenantTx(this.db, tenantId, (tx) =>
      tx.selectFrom('products').select(['name']).where('id', '=', batch.product_id).executeTakeFirst(),
    );

    const outcome = await this.send(
      to,
      `【授权码】${product?.name ?? '您的产品'} · 批次 ${batch.code}`,
      [
        '你好，',
        '',
        `以下是本批次共 ${rows.length} 个授权码：`,
        '',
        ...rows.map((r) => r.code),
        '',
        '每个码可在其设备数上限内激活。如有疑问请联系你的供应商。',
      ].join('\n'),
    );
    outcome.count = rows.length;

    await withTenantTx(this.db, tenantId, async (tx) => {
      await this.recordDelivery(tx, tenantId, {
        licenseId: null,
        batchId,
        channel: outcome.channel,
        to: outcome.to,
        count: rows.length,
        status: outcome.sent ? 'sent' : 'failed',
        error: outcome.error,
        actorId: actor.userId,
      });
      await writeAudit(tx, {
        tenantId,
        actorType: actor.actorType as 'developer_operator',
        actorId: actor.userId,
        action: 'batch.deliver',
        resourceType: 'license_batch',
        resourceId: batchId,
        detail: {
          to_masked: outcome.to ? maskEmail(outcome.to) : null,
          sent: outcome.sent,
          count: rows.length,
        },
        ip: actor.ip ?? null,
        requestId: actor.requestId ?? null,
      });
    });
    return outcome;
  }

  /** 组织联系人邮箱(授权绑定了组织时), 解密失败按没有处理 */
  private async contactEmailOf(
    tenantId: string,
    endCustomerId: string | null,
  ): Promise<string | null> {
    if (!endCustomerId) return null;
    const org = await withTenantTx(this.db, tenantId, (tx) =>
      tx
        .selectFrom('end_customers')
        .select(['contact_email_enc'])
        .where('id', '=', endCustomerId)
        .executeTakeFirst(),
    );
    if (!org?.contact_email_enc) return null;
    try {
      return decryptAead(getConfig().NOTIFY_ADDR_ENC_KEY, org.contact_email_enc);
    } catch {
      return null;
    }
  }

  private async send(
    to: string | null,
    subject: string,
    text: string,
  ): Promise<DeliveryOutcome & { to: string }> {
    if (!to) {
      throw new AppError(
        'REQ_INVALID',
        '未指定收件邮箱，且该授权没有绑定可用的组织联系人邮箱',
      );
    }
    const channel = buildChannels().email;
    if (!channel) {
      throw new AppError('DEPENDENCY_UNAVAILABLE', '未配置邮件通道，无法发送授权码');
    }
    const res = await channel.send({ to }, { subject, text });
    return {
      sent: res.ok,
      to,
      channel: channel.name,
      count: 1,
      error: res.error,
    };
  }

  /** 写一条交付记录(与审计同事务) */
  private async recordDelivery(
    tx: Parameters<Parameters<typeof withTenantTx>[2]>[0],
    tenantId: string,
    d: {
      licenseId: string | null;
      batchId: string | null;
      channel: string;
      to: string;
      count: number;
      status: 'sent' | 'failed';
      error: string | null;
      actorId: string;
    },
  ): Promise<void> {
    await tx
      .insertInto('license_deliveries')
      .values({
        id: uuidv7(),
        tenant_id: tenantId,
        license_id: d.licenseId,
        batch_id: d.batchId,
        channel: d.channel,
        to_addr_enc: encryptAead(getConfig().NOTIFY_ADDR_ENC_KEY, d.to),
        code_count: d.count,
        status: d.status,
        provider_message_id: null,
        error: d.error,
        delivered_by: d.actorId,
        created_at: new Date(),
      })
      .execute();
  }

  /** 某张授权的交付历史: 谁发的、发给谁、成没成功、重发过几次 */
  async listForLicense(
    tenantId: string,
    licenseId: string,
  ): Promise<{
    total: number;
    sent: number;
    failed: number;
    last_sent_at: string | null;
    records: Array<{
      id: string;
      channel: string;
      to_masked: string;
      code_count: number;
      status: string;
      error: string | null;
      delivered_by: string | null;
      created_at: string;
    }>;
  }> {
    const rows = await withTenantTx(this.db, tenantId, (tx) =>
      tx
        .selectFrom('license_deliveries')
        .selectAll()
        .where('license_id', '=', licenseId)
        .orderBy('created_at', 'desc')
        .limit(200)
        .execute(),
    );
    const records = rows.map((r) => {
      let masked = '***';
      try {
        masked = maskEmail(decryptAead(getConfig().NOTIFY_ADDR_ENC_KEY, r.to_addr_enc));
      } catch {
        /* 解密失败不阻断列表 */
      }
      return {
        id: r.id,
        channel: r.channel,
        to_masked: masked,
        code_count: r.code_count,
        status: r.status,
        error: r.error,
        delivered_by: r.delivered_by,
        created_at: r.created_at.toISOString(),
      };
    });
    return {
      total: records.length,
      sent: records.filter((r) => r.status === 'sent').length,
      failed: records.filter((r) => r.status === 'failed').length,
      last_sent_at: records.find((r) => r.status === 'sent')?.created_at ?? null,
      records,
    };
  }
}
