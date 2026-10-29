import { Kysely } from 'kysely';
import { LpDb, withSystemTx } from '@lp/db';
import {
  fillLocaleDefaults,
  type RenderedMessage,
  type TemplateContext,
  type TemplateLocale,
  normalizeLocale,
  renderOverride,
  renderTemplate,
  templateDef,
} from './templates';

/**
 * 模板解析: 租户覆盖 → 内置默认。
 *
 * 不做进程内缓存——通知发送本来就是低频操作(每天一次到期扫描 + 按需交付),
 * 缓存只会带来「后台改完邮件内容要等一会儿才生效」的困惑。
 */
export interface EffectiveTemplate {
  code: string;
  locale: TemplateLocale;
  subject: string;
  body: string;
  sms: string | null;
  /** tenant = 租户覆盖过; builtin = 使用内置默认 */
  source: 'tenant' | 'builtin';
}

export async function loadTenantLocale(
  db: Kysely<LpDb>,
  tenantId: string,
): Promise<TemplateLocale> {
  const row = await withSystemTx(db, (tx) =>
    tx
      .selectFrom('tenants')
      .select(['locale'])
      .where('id', '=', tenantId)
      .executeTakeFirst(),
  );
  return normalizeLocale(row?.locale);
}

export async function loadEffectiveTemplate(
  db: Kysely<LpDb>,
  tenantId: string,
  code: string,
  locale: TemplateLocale,
): Promise<EffectiveTemplate> {
  const def = templateDef(code);
  if (!def) throw new Error(`UNKNOWN_TEMPLATE: ${code}`);
  const override = await withSystemTx(db, (tx) =>
    tx
      .selectFrom('notification_templates')
      .select(['subject', 'body', 'sms_body'])
      .where('tenant_id', '=', tenantId)
      .where('code', '=', code)
      .where('locale', '=', locale)
      .executeTakeFirst(),
  );
  if (override) {
    return {
      code,
      locale,
      subject: override.subject,
      body: override.body,
      sms: override.sms_body,
      source: 'tenant',
    };
  }
  const builtin = def.defaults[locale] ?? def.defaults['zh-CN'];
  return {
    code,
    locale,
    subject: builtin.subject,
    body: builtin.body,
    sms: builtin.sms ?? null,
    source: 'builtin',
  };
}

/** 一步到位: 读租户语言 + 覆盖 → 渲染 */
export async function renderForTenant(
  db: Kysely<LpDb>,
  tenantId: string,
  code: string,
  ctx: TemplateContext,
  locale?: TemplateLocale,
): Promise<RenderedMessage> {
  const loc = locale ?? (await loadTenantLocale(db, tenantId));
  const tpl = await loadEffectiveTemplate(db, tenantId, code, loc);
  const filled = fillLocaleDefaults(ctx, loc);
  return renderOverride(tpl.subject, tpl.body, tpl.sms, filled);
}

export { renderTemplate };
