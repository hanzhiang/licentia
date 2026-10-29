import { Inject, Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { AppError } from '@lp/domain';
import { LpDb, uuidv7, withTenantTx } from '@lp/db';
import { writeAudit } from '@lp/audit';
import {
  TEMPLATE_DEFS,
  TEMPLATE_LOCALES,
  extractVars,
  fillLocaleDefaults,
  renderOverride,
  templateDef,
  type RenderedMessage,
  type TemplateContext,
  type TemplateLocale,
} from '@lp/notify';
import type { ActorInfo } from '../../iam/actor';
import { DB } from '../../db.module';

export interface TemplateView {
  code: string;
  title: string;
  locale: TemplateLocale;
  vars: { name: string; sample: string }[];
  subject: string;
  body: string;
  sms_body: string | null;
  /** tenant = 已覆盖; builtin = 使用内置默认 */
  source: 'tenant' | 'builtin';
  updated_at: Date | null;
}

export interface TemplateInput {
  subject: string;
  body: string;
  sms_body?: string | null;
}

/**
 * 通知模板管理: 每个租户可覆盖内置模板的中英文版本。
 *
 * 为什么放在租户侧而不是平台侧: 邮件是发给**该开发者的客户**的,
 * 措辞、品牌名与语言只有开发者自己清楚; 平台后台不干预业务文案。
 */
@Injectable()
export class NotifyTemplateService {
  constructor(@Inject(DB) private readonly db: Kysely<LpDb>) {}

  async list(tenantId: string): Promise<TemplateView[]> {
    const rows = await withTenantTx(this.db, tenantId, (tx) =>
      tx
        .selectFrom('notification_templates')
        .select(['code', 'locale', 'subject', 'body', 'sms_body', 'updated_at'])
        .execute(),
    );
    const overrides = new Map(rows.map((r) => [`${r.code}:${r.locale}`, r]));

    const out: TemplateView[] = [];
    for (const def of TEMPLATE_DEFS) {
      for (const locale of TEMPLATE_LOCALES) {
        const o = overrides.get(`${def.code}:${locale}`);
        const builtin = def.defaults[locale];
        out.push({
          code: def.code,
          title: def.title,
          locale,
          vars: def.vars,
          subject: o?.subject ?? builtin.subject,
          body: o?.body ?? builtin.body,
          sms_body: o ? o.sms_body : (builtin.sms ?? null),
          source: o ? 'tenant' : 'builtin',
          updated_at: o?.updated_at ?? null,
        });
      }
    }
    return out;
  }

  async upsert(
    tenantId: string,
    code: string,
    locale: string,
    input: TemplateInput,
    actor: ActorInfo,
  ): Promise<TemplateView> {
    const { def, loc } = this.assertTarget(code, locale);
    this.assertVars(def.vars.map((v) => v.name), input);

    await withTenantTx(this.db, tenantId, async (tx) => {
      await tx
        .insertInto('notification_templates')
        .values({
          id: uuidv7(),
          tenant_id: tenantId,
          code,
          locale: loc,
          subject: input.subject,
          body: input.body,
          sms_body: input.sms_body ?? null,
          created_at: new Date(),
          updated_at: new Date(),
          updated_by: actor.userId,
        })
        .onConflict((oc) =>
          oc.columns(['tenant_id', 'code', 'locale']).doUpdateSet({
            subject: input.subject,
            body: input.body,
            sms_body: input.sms_body ?? null,
            updated_at: new Date(),
            updated_by: actor.userId,
          }),
        )
        .execute();

      await writeAudit(tx, {
        tenantId,
        actorType: actor.actorType as 'developer_operator',
        actorId: actor.userId,
        action: 'notify.template.update',
        resourceType: 'notification_template',
        resourceId: `${code}:${loc}`,
        detail: { code, locale: loc },
        ip: actor.ip ?? null,
        requestId: actor.requestId ?? null,
      });
    });

    const view = (await this.list(tenantId)).find((v) => v.code === code && v.locale === loc);
    return view!;
  }

  async reset(tenantId: string, code: string, locale: string, actor: ActorInfo): Promise<void> {
    const { loc } = this.assertTarget(code, locale);
    await withTenantTx(this.db, tenantId, async (tx) => {
      const res = await tx
        .deleteFrom('notification_templates')
        .where('tenant_id', '=', tenantId)
        .where('code', '=', code)
        .where('locale', '=', loc)
        .executeTakeFirst();
      // 本来就没覆盖过: 幂等返回, 不写审计噪音
      if (Number(res.numDeletedRows ?? 0) === 0) return;
      await writeAudit(tx, {
        tenantId,
        actorType: actor.actorType as 'developer_operator',
        actorId: actor.userId,
        action: 'notify.template.reset',
        resourceType: 'notification_template',
        resourceId: `${code}:${loc}`,
        detail: { code, locale: loc },
        ip: actor.ip ?? null,
        requestId: actor.requestId ?? null,
      });
    });
  }

  /** 用当前生效模板 + 示例变量渲染一封预览(不发送、不落库) */
  async preview(
    tenantId: string,
    code: string,
    locale: string,
    vars: Record<string, string> | undefined,
  ): Promise<RenderedMessage> {
    const { def, loc } = this.assertTarget(code, locale);
    const view = (await this.list(tenantId)).find((v) => v.code === code && v.locale === loc)!;

    const ctx: TemplateContext = {};
    for (const v of def.vars) (ctx as Record<string, unknown>)[v.name] = v.sample;
    for (const [k, v] of Object.entries(vars ?? {})) (ctx as Record<string, unknown>)[k] = v;

    return renderOverride(view.subject, view.body, view.sms_body, fillLocaleDefaults(ctx, loc));
  }

  private assertTarget(
    code: string,
    locale: string,
  ): { def: NonNullable<ReturnType<typeof templateDef>>; loc: TemplateLocale } {
    const def = templateDef(code);
    if (!def) throw new AppError('REQ_INVALID', `未知的模板码: ${code}`);
    const loc = TEMPLATE_LOCALES.find((l) => l === locale);
    if (!loc) throw new AppError('REQ_INVALID', `不支持的语言: ${locale}`);
    return { def, loc };
  }

  /** 模板里只允许出现该模板声明过的变量, 防止把 {{customer_name}} 这种不存在的占位符存进去 */
  private assertVars(allowed: string[], input: TemplateInput): void {
    const used = new Set([
      ...extractVars(input.subject),
      ...extractVars(input.body),
      ...(input.sms_body ? extractVars(input.sms_body) : []),
    ]);
    const unknown = [...used].filter((v) => !allowed.includes(v));
    if (unknown.length > 0) {
      throw new AppError('REQ_INVALID', `模板包含未知变量: ${unknown.join(', ')}`, {
        allowed,
      });
    }
  }
}
