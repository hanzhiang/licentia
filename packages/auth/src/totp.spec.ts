import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  generateSecret,
  hashRecoveryCode,
  otpauthUrl,
  totpCode,
  verifyTotp,
} from './totp';

/**
 * RFC 6238 附录 B 的测试密钥是 ASCII "12345678901234567890";
 * 6 位验证码即 8 位向量结果的低 6 位(287082 / 081804 / 005924 …)。
 */
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

describe('totp', () => {
  it('matches the RFC 6238 test vectors', () => {
    expect(totpCode(RFC_SECRET, 59_000)).toBe('287082');
    expect(totpCode(RFC_SECRET, 1_111_111_109_000)).toBe('081804');
    expect(totpCode(RFC_SECRET, 1_111_111_111_000)).toBe('050471');
  });

  it('accepts the current step and tolerates one step of drift', () => {
    const secret = generateSecret();
    const now = 1_700_000_000_000;
    const code = totpCode(secret, now);
    expect(verifyTotp(secret, code, { atMs: now })).toBe(true);
    expect(verifyTotp(secret, code, { atMs: now + 30_000 })).toBe(true);
    expect(verifyTotp(secret, code, { atMs: now - 30_000 })).toBe(true);
    // 两步以上就不认了, 否则等于放宽容错窗口
    expect(verifyTotp(secret, code, { atMs: now + 90_000 })).toBe(false);
  });

  it('rejects malformed codes', () => {
    const secret = generateSecret();
    expect(verifyTotp(secret, '12345', {})).toBe(false);
    expect(verifyTotp(secret, 'abcdef', {})).toBe(false);
    expect(verifyTotp(secret, '', {})).toBe(false);
  });

  it('round-trips base32', () => {
    const buf = Buffer.from([0x00, 0xff, 0x10, 0x7f, 0x80]);
    expect(base32Decode(base32Encode(buf))).toEqual(buf);
    // 手输时常带空格和小写
    expect(base32Decode(base32Encode(buf).toLowerCase().split('').join(' '))).toEqual(buf);
  });

  it('builds a scannable otpauth url', () => {
    const url = otpauthUrl('ops@example.com', 'Licentia', 'JBSWY3DPEHPK3PXP');
    expect(url.startsWith('otpauth://totp/')).toBe(true);
    expect(url).toContain('secret=JBSWY3DPEHPK3PXP');
    expect(url).toContain('issuer=Licentia');
    expect(url).toContain('digits=6');
  });

  it('generates distinct recovery codes that hash stably', () => {
    const codes = generateRecoveryCodes(10);
    expect(new Set(codes).size).toBe(10);
    expect(codes[0]).toMatch(/^[0-9A-F]{5}-[0-9A-F]{5}$/);
    // 大小写与分隔符不影响哈希, 用户输入时可以带连字符
    expect(hashRecoveryCode(codes[0]!).equals(hashRecoveryCode(codes[0]!.toLowerCase()))).toBe(
      true,
    );
    expect(hashRecoveryCode(codes[0]!).equals(hashRecoveryCode(codes[1]!))).toBe(false);
  });
});
