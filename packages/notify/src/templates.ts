/**
 * 通知模板(设计文档 §16 notifier).
 *
 * 模板正文是纯文本, 变量写成 {{name}}; 渲染只做字符串替换,
 * 不允许出现用户可控的 HTML/链接拼接。
 *
 * 内置默认提供中文与英文两版; 租户可在后台覆盖任意一条(见 template-store.ts)。
 * 缺省值的处理(如没有组织名时的称呼)放在组装上下文的一侧, 模板本身保持纯粹。
 */
export type TemplateLocale = 'zh-CN' | 'en';

export const TEMPLATE_LOCALES: readonly TemplateLocale[] = ['zh-CN', 'en'];

/** 把 "en-US"/"zh"/"zh-TW" 之类的值归一到受支持的两个 locale */
export function normalizeLocale(raw: string | null | undefined): TemplateLocale {
  if (!raw) return 'zh-CN';
  return raw.toLowerCase().startsWith('en') ? 'en' : 'zh-CN';
}

export interface TemplateContext {
  product_name?: string;
  org_name?: string;
  license_id?: string;
  /** 授权码本体, 仅 license_delivery 使用 */
  code?: string;
  /** 批次号 / 本批码数 / 已换行拼接的码列表, 仅 license_batch_delivery 使用 */
  batch_code?: string;
  count?: number | string;
  codes?: string;
  /** 已本地化的有效期描述, 例如「有效期至 2026-12-31」/「Never expires」 */
  validity?: string;
  device_limit?: number | string;
  /** 模板里写作 {{days}}; 由 due_in_days 自动补齐 */
  days?: number | string;
  due_in_days?: number;
  /** 仅 email_verify 使用 */
  expires_minutes?: number;
  expires_at?: string | null;
}

export interface RenderedMessage {
  subject: string;
  text: string;
  /** 短信通道用: 纯文本且长度受限, 无标题 */
  sms?: string;
}

export interface TemplateVar {
  name: string;
  /** 管理后台预览时用的示例值 */
  sample: string;
}

interface LocaleTemplate {
  subject: string;
  body: string;
  sms?: string;
}

export interface TemplateDef {
  code: string;
  /** 后台列表里的中文名 */
  title: string;
  vars: TemplateVar[];
  defaults: Record<TemplateLocale, LocaleTemplate>;
}

const COMMON_VARS: TemplateVar[] = [
  { name: 'product_name', sample: 'CloudDisk Pro' },
  { name: 'org_name', sample: 'Riverside School' },
  { name: 'license_id', sample: '0192f0c4-3a1b-7d2e-9c88-5f0a1b2c3d4e' },
];

const expireWarning = (days: number, daysEn: string): TemplateDef => ({
  code: `expire_warning_${days}d`,
  title: `到期提醒(${days} 天前) / Expiry warning (${days}d)`,
  vars: [
    ...COMMON_VARS,
    { name: 'days', sample: String(days) },
    { name: 'expires_at', sample: '2026-12-31' },
  ],
  defaults: {
    'zh-CN': {
      subject: `【到期提醒】{{product_name}} 授权将在 {{days}} 天后到期`,
      body: [
        '您好 {{org_name}}：',
        '',
        '{{product_name}} 的授权将于 {{expires_at}} 到期(剩余 {{days}} 天)。',
        '请在到期前完成续费，逾期后客户端将停止提供授权服务。',
        '',
        '授权编号：{{license_id}}',
      ].join('\n'),
      sms: `【授权提醒】{{product_name}} 授权 {{days}} 天后({{expires_at}})到期，请及时续费。`,
    },
    en: {
      subject: `[Expiry notice] {{product_name}} license expires in ${daysEn}`,
      body: [
        'Hello {{org_name}},',
        '',
        `Your {{product_name}} license expires on {{expires_at}} (in ${daysEn}).`,
        'Please renew before that date; the client will stop serving the license once it lapses.',
        '',
        'License ID: {{license_id}}',
      ].join('\n'),
      sms: `[License notice] {{product_name}} expires in ${daysEn} ({{expires_at}}). Please renew.`,
    },
  },
});

export const TEMPLATE_DEFS: TemplateDef[] = [
  {
    code: 'email_verify',
    title: '邮箱验证码 / Email verification',
    vars: [
      { name: 'code', sample: '483920' },
      { name: 'expires_minutes', sample: '15' },
    ],
    defaults: {
      'zh-CN': {
        subject: '【Licentia】开发者账号邮箱验证',
        body: [
          '你好，',
          '',
          '你的验证码是 {{code}}，{{expires_minutes}} 分钟内有效。',
          '若这不是你本人的操作，请忽略本邮件。',
        ].join('\n'),
      },
      en: {
        subject: '[Licentia] Verify your developer account',
        body: [
          'Hello,',
          '',
          'Your verification code is {{code}}. It expires in {{expires_minutes}} minutes.',
          'If you did not request this, you can ignore this email.',
        ].join('\n'),
      },
    },
  },
  expireWarning(30, '30 days'),
  expireWarning(7, '7 days'),
  expireWarning(1, '1 day'),
  {
    code: 'license_delivery',
    title: '授权码交付 / License code delivery',
    vars: [
      ...COMMON_VARS,
      { name: 'code', sample: 'A9WA-XDMY-7K2P-Q3RT' },
      { name: 'validity', sample: '2026-12-31' },
      { name: 'device_limit', sample: '5' },
    ],
    defaults: {
      'zh-CN': {
        subject: '【授权码】{{product_name}}',
        body: [
          '您好 {{org_name}}：',
          '',
          '这是您的授权码：',
          '',
          '{{code}}',
          '',
          '{{validity}}',
          '可激活设备数：{{device_limit}} 台。',
          '授权编号：{{license_id}}',
          '',
          '请在客户端中输入该授权码完成激活。如有疑问请联系您的供应商。',
        ].join('\n'),
      },
      en: {
        subject: 'Your {{product_name}} license code',
        body: [
          'Hello {{org_name}},',
          '',
          'Here is your license code:',
          '',
          '{{code}}',
          '',
          '{{validity}}',
          'Devices allowed: {{device_limit}}',
          'License ID: {{license_id}}',
          '',
          'Enter this code in the client to activate. Contact your supplier if you need help.',
        ].join('\n'),
      },
    },
  },
  {
    code: 'license_batch_delivery',
    title: '批次授权码交付 / Batch code delivery',
    vars: [
      ...COMMON_VARS,
      { name: 'batch_code', sample: 'BATCH-2026-10' },
      { name: 'count', sample: '3' },
      { name: 'codes', sample: 'A9WA-XDMY-7K2P-Q3RT\nB7QE-2HNZ-8M4L-R6SV' },
    ],
    defaults: {
      'zh-CN': {
        subject: '【授权码】{{product_name}} · 批次 {{batch_code}}',
        body: [
          '您好 {{org_name}}：',
          '',
          '以下是本批次共 {{count}} 个授权码：',
          '',
          '{{codes}}',
          '',
          '每个码可在其设备数上限内激活。如有疑问请联系您的供应商。',
        ].join('\n'),
      },
      en: {
        subject: 'Your {{product_name}} license codes (batch {{batch_code}})',
        body: [
          'Hello {{org_name}},',
          '',
          'Here are {{count}} license codes from this batch:',
          '',
          '{{codes}}',
          '',
          'Each code activates up to its own device limit. Contact your supplier if you need help.',
        ].join('\n'),
      },
    },
  },
];

const BY_CODE = new Map(TEMPLATE_DEFS.map((d) => [d.code, d]));

export function templateDef(code: string): TemplateDef | undefined {
  return BY_CODE.get(code);
}

export function knownTemplates(): string[] {
  return TEMPLATE_DEFS.map((d) => d.code);
}

/** 模板里出现的变量名(去重, 保持出现顺序) */
export function extractVars(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g)) {
    const name = m[1]!;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** 纯替换: 未提供的变量原样保留, 便于作者在预览里立刻看出漏填 */
export function renderText(text: string, ctx: TemplateContext): string {
  return text.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (whole, name: string) => {
    const value = (ctx as Record<string, unknown>)[name];
    return value === undefined || value === null || value === '' ? whole : String(value);
  });
}

/**
 * 补齐模板缺失的变量: 没有组织名时用称呼兜底, 有效期按语言拼好。
 * 这样模板作者不需要在正文里写条件逻辑, 也不会把 {{xxx}} 直接发给客户。
 */
export function fillLocaleDefaults(
  ctx: TemplateContext,
  locale: TemplateLocale,
): TemplateContext {
  const out: TemplateContext = { ...ctx };
  if (out.days === undefined && out.due_in_days !== undefined) out.days = out.due_in_days;
  if (!out.org_name) out.org_name = locale === 'en' ? 'there' : '客户';
  if (!out.product_name) out.product_name = locale === 'en' ? 'your product' : '您的产品';
  if (out.validity === undefined) {
    if (out.expires_at) {
      const date = out.expires_at.slice(0, 10);
      out.validity = locale === 'en' ? `Valid until ${date}` : `有效期至 ${date}`;
    } else {
      out.validity = locale === 'en' ? 'Never expires' : '永久有效';
    }
  }
  if (!out.expires_at) out.expires_at = locale === 'en' ? 'unknown' : '未知';
  return out;
}

/** 用内置默认渲染(不含租户覆盖); 找不到模板码时抛错 */
export function renderTemplate(
  code: string,
  ctx: TemplateContext,
  locale: TemplateLocale = 'zh-CN',
): RenderedMessage {
  const def = BY_CODE.get(code);
  if (!def) throw new Error(`UNKNOWN_TEMPLATE: ${code}`);
  const tpl = def.defaults[locale] ?? def.defaults['zh-CN'];
  const filled = fillLocaleDefaults(ctx, locale);
  return {
    subject: renderText(tpl.subject, filled),
    text: renderText(tpl.body, filled),
    ...(tpl.sms ? { sms: renderText(tpl.sms, filled) } : {}),
  };
}

/** 用一组具体模板文本渲染(租户覆盖时走这里) */
export function renderOverride(
  subject: string,
  body: string,
  smsBody: string | null,
  ctx: TemplateContext,
): RenderedMessage {
  return {
    subject: renderText(subject, ctx),
    text: renderText(body, ctx),
    ...(smsBody ? { sms: renderText(smsBody, ctx) } : {}),
  };
}
