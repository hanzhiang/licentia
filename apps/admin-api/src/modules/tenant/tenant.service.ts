import { Inject, Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { AppError } from '@lp/domain';
import { LpDb, withTenantTx } from '@lp/db';
import { writeAudit } from '@lp/audit';
import { TEMPLATE_LOCALES, normalizeLocale, type TemplateLocale } from '@lp/notify';
import { DB } from '../../db.module';
import type { ActorInfo } from '../../iam/actor';

export interface TenantProfile {
  id: string;
  code: string;
  name: string;
  locale: TemplateLocale;
}

/** 开发者租户自己的档案: 目前只有名称与出站邮件语言 */
@Injectable()
export class TenantService {
  constructor(@Inject(DB) private readonly db: Kysely<LpDb>) {}

  async get(tenantId: string): Promise<TenantProfile> {
    const row = await withTenantTx(this.db, tenantId, (tx) =>
      tx
        .selectFrom('tenants')
        .select(['id', 'code', 'name', 'locale'])
        .where('id', '=', tenantId)
        .executeTakeFirst(),
    );
    if (!row) throw new AppError('REQ_INVALID', '租户不存在');
    return { id: row.id, code: row.code, name: row.name, locale: normalizeLocale(row.locale) };
  }

  async updateLocale(
    tenantId: string,
    locale: string,
    actor: ActorInfo,
    name?: string,
  ): Promise<TenantProfile> {
    const loc = TEMPLATE_LOCALES.find((l) => l === locale);
    if (!loc) throw new AppError('REQ_INVALID', `不支持的语言: ${locale}`);

    await withTenantTx(this.db, tenantId, async (tx) => {
      await tx
        .updateTable('tenants')
        .set({ locale: loc, ...(name !== undefined ? { name } : {}), updated_at: new Date() })
        .where('id', '=', tenantId)
        .execute();
      await writeAudit(tx, {
        tenantId,
        actorType: actor.actorType as 'developer_owner',
        actorId: actor.userId,
        action: 'tenant.update',
        resourceType: 'tenant',
        resourceId: tenantId,
        detail: { locale: loc, ...(name !== undefined ? { name } : {}) },
        ip: actor.ip ?? null,
        requestId: actor.requestId ?? null,
      });
    });
    return this.get(tenantId);
  }
}
