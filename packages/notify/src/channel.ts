import type { RenderedMessage } from './templates';

/**
 * 通知通道抽象(设计文档 §16). 每个通道实现 send(), 返回投递结果;
 * 失败以 DeliveryResult.ok=false + error 返回, 不抛异常(由调用方统一重试/退信).
 */
export interface DeliveryTarget {
  /** 明文收件地址; 由调用方从 to_addr_enc 解密后传入, 通道不接触加密存储 */
  to: string;
}

export interface DeliveryResult {
  ok: boolean;
  /** 通道侧消息 id(可追溯), 失败时为 null */
  providerMessageId: string | null;
  error: string | null;
}

export interface NotificationChannel {
  readonly name: 'email' | 'sms';
  send(target: DeliveryTarget, message: RenderedMessage): Promise<DeliveryResult>;
}

export function ok(providerMessageId: string | null): DeliveryResult {
  return { ok: true, providerMessageId, error: null };
}

export function fail(error: unknown): DeliveryResult {
  const msg = error instanceof Error ? error.message : String(error);
  return { ok: false, providerMessageId: null, error: msg.slice(0, 300) };
}
