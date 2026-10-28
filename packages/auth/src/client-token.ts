import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 客户端令牌: 不透明 32B 随机, 服务端只存 SHA-256 */
export function generateClientToken(): string {
  return `ct_${randomBytes(32).toString('base64url')}`;
}

export function hashClientToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

export function safeEqualBuffer(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
