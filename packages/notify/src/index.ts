import { getConfig } from '@lp/config';
import { ConsoleChannel, HttpSmsChannel, SmtpEmailChannel } from './channels';
import type { NotificationChannel } from './channel';

export * from './channel';
export * from './templates';
export * from './template-store';
export * from './channels';
export { deliverPending, isRetryable } from './delivery';
export type { DeliverDeps, DeliveryStatus, NotifyRunSummary } from './delivery';

/**
 * 按配置构建通道. 未配置真实网关时回落到 ConsoleChannel:
 * 骨架/dev 环境仍能跑通 pending→sent 状态机, 但日志明确标出是控制台出口,
 * 生产必须显式配置 SMTP/SMS, 否则 NotifyDeliverer 会把通知置 blocked 而非静默丢弃.
 */
export function buildChannels(): Partial<Record<'email' | 'sms', NotificationChannel>> {
  const cfg = getConfig();
  const channels: Partial<Record<'email' | 'sms', NotificationChannel>> = {};

  if (cfg.SMTP_HOST) {
    channels.email = new SmtpEmailChannel({
      host: cfg.SMTP_HOST,
      port: cfg.SMTP_PORT,
      user: cfg.SMTP_USER ?? undefined,
      pass: cfg.SMTP_PASS ?? undefined,
      from: cfg.SMTP_FROM,
      implicitTls: cfg.SMTP_TLS_MODE === 'implicit',
    });
  } else if (cfg.NOTIFY_CONSOLE_FALLBACK) {
    channels.email = new ConsoleChannel('email');
  }

  if (cfg.SMS_GATEWAY_URL) {
    channels.sms = new HttpSmsChannel({
      endpoint: cfg.SMS_GATEWAY_URL,
      headers: cfg.SMS_GATEWAY_TOKEN ? { authorization: `Bearer ${cfg.SMS_GATEWAY_TOKEN}` } : {},
    });
  } else if (cfg.NOTIFY_CONSOLE_FALLBACK) {
    channels.sms = new ConsoleChannel('sms');
  }

  return channels;
}
