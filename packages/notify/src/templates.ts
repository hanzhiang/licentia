/**
 * 通知模板(设计文档 §16 notifier): 模板码 → 渲染函数.
 * 渲染结果只做变量替换, 不允许模板里出现用户可控的 HTML/链接拼接.
 */
export interface TemplateContext {
  license_id: string;
  due_in_days?: number;
  expires_at?: string | null;
  product_name?: string;
  org_name?: string;
}

export interface RenderedMessage {
  subject: string;
  text: string;
  /** 短信通道用: 纯文本且长度受限, 无标题 */
  sms?: string;
}

type Renderer = (ctx: TemplateContext) => RenderedMessage;

const expireWarning: Renderer = (ctx) => {
  const days = ctx.due_in_days ?? 0;
  const when = ctx.expires_at ? new Date(ctx.expires_at).toISOString().slice(0, 10) : '未知';
  const product = ctx.product_name ?? '您的产品';
  const subject = `【到期提醒】${product} 授权将在 ${days} 天后到期`;
  const text = [
    `您好${ctx.org_name ? ` ${ctx.org_name}` : ''}:`,
    '',
    `${product} 的授权码将于 ${when} 到期(剩余 ${days} 天).`,
    '请在到期前完成续费, 逾期后客户端将停止提供授权服务.',
    '',
    `授权编号: ${ctx.license_id}`,
  ].join('\n');
  const sms = `【授权提醒】${product} 授权 ${days} 天后(${when})到期, 请及时续费. 编号 ${ctx.license_id.slice(0, 8)}`;
  return { subject, text, sms };
};

const TEMPLATES: Record<string, Renderer> = {
  expire_warning_30d: expireWarning,
  expire_warning_7d: expireWarning,
  expire_warning_1d: expireWarning,
};

export function renderTemplate(code: string, ctx: TemplateContext): RenderedMessage {
  const renderer = TEMPLATES[code];
  if (!renderer) throw new Error(`UNKNOWN_TEMPLATE: ${code}`);
  return renderer(ctx);
}

export function knownTemplates(): string[] {
  return Object.keys(TEMPLATES);
}
