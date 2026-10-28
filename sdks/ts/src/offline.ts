import crypto from 'node:crypto';
import type { Jwk, OfflineLicenseClaims } from './types';

/** Ed25519 JWS Compact(EdDSA) 独立验签 — SDK 不依赖平台内部包 */
function b64urlToBuf(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

function jwkToKey(jwk: Jwk): crypto.KeyObject {
  return crypto.createPublicKey({ key: jwk as crypto.JsonWebKey, format: 'jwk' });
}

function selectKey(opts: { publicKeyPem?: string; jwks?: { keys: Jwk[] } }, kid: string): crypto.KeyObject {
  if (opts.publicKeyPem) return crypto.createPublicKey(opts.publicKeyPem);
  const jwk = opts.jwks?.keys.find((k) => k.kid === kid);
  if (!jwk) throw new Error(`OFFLINE_LICENSE_UNKNOWN_KID: ${kid}`);
  return jwkToKey(jwk);
}

export interface OfflineVerifyOptions {
  /** 内置公钥(PEM); 与 jwks 二选一, jwks 支持多 kid(轮换窗口) */
  publicKeyPem?: string;
  jwks?: { keys: Jwk[] };
  nowSec?: number;
  /** 时钟容差秒数(默认 300) */
  maxClockSkewSec?: number;
}

/**
 * 离线许可验签(设计文档 §10.3): Ed25519 + typ/alg 白名单 + exp 检查.
 * 抛错码: OFFLINE_LICENSE_MALFORMED / BAD_ALG / BAD_SIGNATURE / UNKNOWN_KID / EXPIRED / NOT_YET_VALID
 */
export async function verifyOfflineLicense(
  token: string,
  opts: OfflineVerifyOptions,
): Promise<OfflineLicenseClaims> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('OFFLINE_LICENSE_MALFORMED');
  const [h, p, s] = parts as [string, string, string];
  let header: { typ?: string; alg?: string; kid?: string };
  try {
    header = JSON.parse(b64urlToBuf(h).toString('utf8'));
  } catch {
    throw new Error('OFFLINE_LICENSE_MALFORMED');
  }
  if (header.alg !== 'EdDSA') throw new Error(`OFFLINE_LICENSE_BAD_ALG: ${header.alg}`);
  if (header.typ !== 'license+jwt') throw new Error('OFFLINE_LICENSE_BAD_HEADER');

  const key = selectKey(opts, header.kid ?? '');
  const ok = crypto.verify(
    null,
    Buffer.from(`${h}.${p}`, 'ascii'),
    key,
    b64urlToBuf(s!),
  );
  if (!ok) throw new Error('OFFLINE_LICENSE_BAD_SIGNATURE');

  const claims = JSON.parse(b64urlToBuf(p).toString('utf8')) as OfflineLicenseClaims;
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const skew = opts.maxClockSkewSec ?? 300;
  if (!claims.exp || typeof claims.exp !== 'number') throw new Error('OFFLINE_LICENSE_MALFORMED');
  if (claims.iat > nowSec + skew) throw new Error('OFFLINE_LICENSE_NOT_YET_VALID');
  if (nowSec >= claims.exp + skew) throw new Error('OFFLINE_LICENSE_EXPIRED');
  return claims;
}

/**
 * 时钟回拨守卫(设计文档 §10.3): 客户端保存见过的最大服务端时间;
 * 本地时间 < max_server_time - tolerance 时拒绝离线运行, 要求联网重验.
 */
export function clockRollbackOk(
  maxServerTimeSec: number,
  nowSec: number = Math.floor(Date.now() / 1000),
  toleranceSec = 24 * 3600,
): boolean {
  return nowSec >= maxServerTimeSec - toleranceSec;
}
