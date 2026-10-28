import crypto from 'node:crypto';
import { AppError, errLicMalformed } from '@lp/domain';
import { ALPHABET, charToValue, mapConfusables } from './alphabet';
import { computeCheckValue, dammVerify } from './damm32';

export const PREFIX_LEN = 4;
export const BODY_LEN = 16;
export const TOTAL_LEN = PREFIX_LEN + BODY_LEN + 1; // 21 字符(前缀4 + 随机体16 + 校验位1)

export type RandomBytes = (size: number) => Buffer;

export interface GeneratedCode {
  /** 展示格式 XXXX-XXXX-XXXX-XXXX-XXXX-C */
  code: string;
  /** 归一化无连字符 21 字符 */
  normalized: string;
}

/** 拒绝采样: b<248(=8*31) 时 b%31 均匀分布 */
export function randomSymbols(n: number, randomBytes: RandomBytes = crypto.randomBytes): number[] {
  const out: number[] = [];
  while (out.length < n) {
    const buf = randomBytes(Math.max(32, n * 2));
    for (const b of buf) {
      if (out.length >= n) break;
      if (b < 248) out.push(b % 31);
    }
  }
  return out;
}

export function codeValues(s: string): number[] {
  return s.split('').map((c) => {
    const v = charToValue(c);
    if (v === undefined) throw errLicMalformed(`非法字符: ${c}`);
    return v;
  });
}

function valuesToChars(values: number[]): string {
  return values.map((v) => ALPHABET[v]!).join('');
}

export function normalizePrefix(prefix: string): string {
  const p = mapConfusables(prefix.toUpperCase().replace(/[^0-9A-Z]/g, ''));
  if (p.length !== PREFIX_LEN) {
    throw errLicMalformed(`产品前缀必须为 ${PREFIX_LEN} 个字符`);
  }
  for (const c of p) {
    if (charToValue(c) === undefined) throw errLicMalformed(`前缀含非法字符: ${c}`);
  }
  return p;
}

export function groupCode(normalized: string): string {
  const bodyGroups: string[] = [];
  for (let i = 0; i < normalized.length - 1; i += 4) {
    bodyGroups.push(normalized.slice(i, i + 4));
  }
  return [...bodyGroups, normalized.slice(-1)].join('-');
}

/** 生成一个授权码: 前缀(产品标识) + 16 随机字符(79.3 bit 熵) + Damm 校验位 */
export function generateCode(prefix: string, randomBytes?: RandomBytes): GeneratedCode {
  const p = normalizePrefix(prefix);
  const values = [...codeValues(p), ...randomSymbols(BODY_LEN, randomBytes)];
  const check = computeCheckValue(values);
  const normalized = valuesToChars([...values, check]);
  return { code: groupCode(normalized), normalized };
}

/**
 * 归一化: 大写、去连字符/空白、混淆映射(O->0 I->1 L->1 U->V)、长度/字符集/校验位验证.
 * 校验不过直接抛 LIC_CODE_MALFORMED(400), 客户端无需请求服务端即可预判.
 */
export function normalizeCode(input: string): string {
  const cleaned = input.toUpperCase().replace(/[^0-9A-Z]/g, '');
  const mapped = mapConfusables(cleaned);
  if (mapped.length !== TOTAL_LEN) {
    throw errLicMalformed(`授权码长度错误: 期望 ${TOTAL_LEN} 字符, 实际 ${mapped.length}`);
  }
  for (const c of mapped) {
    if (charToValue(c) === undefined) throw errLicMalformed(`含非法字符: ${c}`);
  }
  if (!dammVerify(codeValues(mapped))) {
    throw errLicMalformed('校验位错误');
  }
  return mapped;
}

/** 对已归一化字符串做完整校验(测试与导入场景用, 不抛错) */
export function isValidNormalizedCode(normalized: string): boolean {
  if (normalized.length !== TOTAL_LEN) return false;
  for (const c of normalized) {
    if (charToValue(c) === undefined) return false;
  }
  return dammVerify(codeValues(normalized));
}

/** 查找索引: HMAC-SHA256(归一化码), 全局唯一约束落库 */
export function hmacCode(key: string | Buffer, normalized: string): Buffer {
  return crypto.createHmac('sha256', key).update(normalized, 'utf8').digest();
}

/** 展示掩码: 保留前缀与校验位 DORM-****-****-****-****-C */
export function maskCode(normalized: string): string {
  if (normalized.length !== TOTAL_LEN) return '****';
  const prefix = normalized.slice(0, PREFIX_LEN);
  const stars = Array.from({ length: BODY_LEN / 4 }, () => '****');
  return [prefix, ...stars, normalized.slice(-1)].join('-');
}

/**
 * legacy 码归一化(存量迁移, 设计文档 §7.3): 大写去符号, 不校验新码格式/Damm.
 * 仅用于迁移工具与 client-api 的 legacy 兜底查找, 新发码一律走 normalizeCode.
 */
export function legacyNormalizeCode(input: string): string {
  return input.toUpperCase().replace(/[^0-9A-Z]/g, '');
}
