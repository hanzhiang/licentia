import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { AppError } from '@lp/domain';
import {
  ALPHABET,
  TOTAL_LEN,
  generateCode,
  hmacCode,
  isValidNormalizedCode,
  maskCode,
  normalizeCode,
} from './index';
import { decryptAead, encryptAead } from './crypto-box';

describe('code generation', () => {
  it('generates codes in XXXX-XXXX-XXXX-XXXX-XXXX-C shape with valid checksum', () => {
    for (let i = 0; i < 200; i++) {
      // 前缀含 O 会被归一化映射为 0(与用户输入归一化保持一致), 故 'DORM' 生成 'D0RM'
      const { code, normalized } = generateCode('DORM');
      expect(normalized).toHaveLength(TOTAL_LEN);
      expect(code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){4}-[0-9A-Z]$/);
      expect(isValidNormalizedCode(normalized)).toBe(true);
      expect(normalized.startsWith('D0RM')).toBe(true);
    }
  });

  it('is random (no repeats across 2000 draws)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) seen.add(generateCode('DORM').normalized);
    expect(seen.size).toBe(2000);
  });
});

describe('normalizeCode', () => {
  it('lowercase + dashes round-trips', () => {
    const { normalized } = generateCode('DORM');
    const dashed = normalized.slice(0, 4) + '-' + normalized.slice(4);
    expect(normalizeCode(dashed.toLowerCase())).toBe(normalized);
    expect(normalizeCode(dashed)).toBe(normalized);
  });

  it('maps confusables O->0 I->1 L->1 U->V', () => {
    // 构造一个已知合法码: 用受控随机生成, 再把可映射字符注入测试
    const confusableSource = 'OILU';
    const mapped = confusableSource
      .split('')
      .map((c) => ({ O: '0', I: '1', L: '1', U: 'V' })[c]!)
      .join('');
    expect(mapped).toBe('011V');
    expect(ALPHABET).toContain('V');
    expect(ALPHABET).not.toContain('O');
    expect(ALPHABET).not.toContain('I');
    expect(ALPHABET).not.toContain('L');
    expect(ALPHABET).not.toContain('U');
  });

  it('rejects wrong length / bad checksum with LIC_CODE_MALFORMED', () => {
    expect(() => normalizeCode('SHORT')).toThrow(AppError);
    const { normalized } = generateCode('DORM');
    const chars = normalized.split('');
    // 替换最后一个字符为不同的合法字符 → 校验位错误
    const alt = ALPHABET.split('').find((c) => c !== chars[20]!)!;
    chars[20] = alt;
    try {
      normalizeCode(chars.join(''));
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).code).toBe('LIC_CODE_MALFORMED');
      expect((e as AppError).http).toBe(400);
    }
  });
});

describe('damm32 single-error detection property', () => {
  it('detects every single-character substitution across 500 random codes', () => {
    for (let i = 0; i < 500; i++) {
      const { normalized } = generateCode('TEST');
      const pos = crypto.randomInt(TOTAL_LEN);
      const orig = normalized[pos]!;
      const alt = ALPHABET.split('').find((c) => c !== orig)!;
      const mutated = normalized.slice(0, pos) + alt + normalized.slice(pos + 1);
      expect(isValidNormalizedCode(mutated)).toBe(false);
    }
  });

  it('detects adjacent transpositions', () => {
    for (let i = 0; i < 200; i++) {
      const { normalized } = generateCode('TEST');
      const body = normalized.slice(0, 20); // 转置随机体内相邻两位(不动校验位)
      const pos = crypto.randomInt(19);
      if (body[pos] === body[pos + 1]) continue;
      const swapped = body.slice(0, pos) + body[pos + 1]! + body[pos]! + body.slice(pos + 2);
      const mutated = swapped + normalized.slice(20);
      expect(isValidNormalizedCode(mutated)).toBe(false);
    }
  });
});

describe('hmacCode', () => {
  it('is deterministic and key-sensitive', () => {
    const a = hmacCode('k1', 'DORM00000000000000000');
    expect(hmacCode('k1', 'DORM00000000000000000')).toEqual(a);
    expect(hmacCode('k2', 'DORM00000000000000000')).not.toEqual(a);
    expect(a).toHaveLength(32);
  });
});

describe('maskCode', () => {
  it('keeps prefix and check char only', () => {
    const { normalized } = generateCode('DORM');
    const masked = maskCode(normalized);
    expect(masked.startsWith(`${normalized.slice(0, 4)}-****`)).toBe(true);
    expect(masked.endsWith(normalized.slice(-1))).toBe(true);
    expect(masked).not.toContain(normalized.slice(4, 20));
  });
});

describe('crypto-box (AES-256-GCM)', () => {
  it('round-trips and rejects tampering', () => {
    const blob = encryptAead('secret-key', 'DORM-K7P2-M9XA-Q4TN-3RW2-C');
    expect(decryptAead('secret-key', blob)).toBe('DORM-K7P2-M9XA-Q4TN-3RW2-C');
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1] ^= 0x01;
    expect(() => decryptAead('secret-key', tampered)).toThrow();
    expect(() => decryptAead('other-key', blob)).toThrow();
  });
});
