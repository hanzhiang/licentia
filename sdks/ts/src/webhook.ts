import crypto from 'node:crypto';

export interface WebhookVerifyResult {
  valid: boolean;
  reason?: 'MALFORMED' | 'STALE_TIMESTAMP' | 'BAD_SIGNATURE';
}

/**
 * Webhook 签名校验(设计文档 §4.8):
 *   X-LP-Signature: t=<unix>,v1=HMAC_SHA256(secret, t + "." + rawBody)
 * 消费方要求: 以 X-LP-Delivery-Id 幂等; body 必须用原始字节(不要重新序列化).
 */
export function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  signatureHeader: string | undefined,
  toleranceSec = 300,
  nowSec: number = Math.floor(Date.now() / 1000),
): WebhookVerifyResult {
  if (!signatureHeader) return { valid: false, reason: 'MALFORMED' };
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(signatureHeader);
  if (!m) return { valid: false, reason: 'MALFORMED' };
  const t = Number(m[1]);
  if (!Number.isFinite(t) || Math.abs(nowSec - t) > toleranceSec) {
    return { valid: false, reason: 'STALE_TIMESTAMP' };
  }
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${m[1]}.${rawBody}`, 'utf8')
    .digest('hex');
  const got = Buffer.from(m[2]!, 'hex');
  const want = Buffer.from(expected, 'hex');
  const valid = got.length === want.length && crypto.timingSafeEqual(got, want);
  return valid ? { valid: true } : { valid: false, reason: 'BAD_SIGNATURE' };
}
