import crypto from 'node:crypto';

/**
 * TOTP(RFC 6238)- 与 Google Authenticator / 1Password 等常见的身份验证器兼容。
 *
 * 不引第三方库: 算法就是 HMAC-SHA1 + 动态截断, 自己实现反而更可控,
 * 也避免为一个小功能给管理后台加一个运行时依赖。
 *
 * 参数取业界默认: 6 位、30 秒、SHA1、160 位密钥。
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SEC = 30;
const DIGITS = 6;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('BASE32_INVALID');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 160 位随机密钥, base32 编码(身份验证器手输用) */
export function generateSecret(bytes = 20): string {
  return base32Encode(crypto.randomBytes(bytes));
}

function hotp(key: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

/** 某一时刻的 6 位验证码(测试与调试用) */
export function totpCode(secret: string, atMs: number = Date.now()): string {
  return hotp(base32Decode(secret), Math.floor(atMs / 1000 / STEP_SEC));
}

/**
 * 校验验证码。window=1 表示容忍前后各一个时间步(时钟偏差/输入延迟),
 * 再大就等于放宽暴力破解空间, 不建议。
 */
export function verifyTotp(
  secret: string,
  code: string,
  opts: { atMs?: number; window?: number } = {},
): boolean {
  const normalized = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(normalized)) return false;
  const key = base32Decode(secret);
  const counter = Math.floor((opts.atMs ?? Date.now()) / 1000 / STEP_SEC);
  const window = opts.window ?? 1;
  for (let d = -window; d <= window; d++) {
    const expected = hotp(key, counter + d);
    // 定长比较, 避免按位提前返回泄露信息
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(normalized))) return true;
  }
  return false;
}

/** 身份验证器扫码用的 otpauth URL(没有二维码时用户也可以手动输入密钥) */
export function otpauthUrl(account: string, issuer: string, secret: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SEC),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** 恢复码: 10 组 8 位, 高熵随机, 存哈希不存明文 */
export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () =>
    crypto
      .randomBytes(5)
      .toString('hex')
      .toUpperCase()
      .match(/.{1,5}/g)!
      .join('-'),
  );
}

export function hashRecoveryCode(code: string): Buffer {
  return crypto
    .createHash('sha256')
    .update(code.replace(/[\s-]/g, '').toUpperCase(), 'utf8')
    .digest();
}
