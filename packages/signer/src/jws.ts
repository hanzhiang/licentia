import { verify as cryptoVerify, type KeyObject } from 'node:crypto';
import type { SignerProvider } from './types';

export function b64url(buf: Uint8Array): string {
  return Buffer.from(buf).toString('base64url');
}

export function fromB64url(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

export interface JwsHeader {
  typ: string;
  alg: string;
  kid: string;
}

/** JWS Compact 签名(EdDSA: Ed25519 纯签名, 无预哈希) */
export async function signCompactJws(
  provider: SignerProvider,
  header: JwsHeader,
  payload: unknown,
): Promise<string> {
  const h = b64url(Buffer.from(JSON.stringify(header), 'utf8'));
  const p = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const signingInput = Buffer.from(`${h}.${p}`, 'ascii');
  const sig = await provider.sign(signingInput);
  return `${h}.${p}.${b64url(sig)}`;
}

/**
 * JWS Compact 验签(Ed25519).
 * 安全规则: 算法白名单(防 alg 混淆攻击), kid 由调用方决定信任哪些密钥.
 */
export async function verifyCompactJwsEd25519<T>(
  token: string,
  publicKey: KeyObject,
): Promise<{ header: JwsHeader; payload: T }> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('OFFLINE_LICENSE_MALFORMED');
  const [h, p, s] = parts as [string, string, string];
  let header: JwsHeader;
  try {
    header = JSON.parse(fromB64url(h).toString('utf8')) as JwsHeader;
  } catch {
    throw new Error('OFFLINE_LICENSE_MALFORMED');
  }
  if (header.alg !== 'EdDSA') {
    throw new Error(`OFFLINE_LICENSE_BAD_ALG: ${header.alg}`);
  }
  const ok = cryptoVerify(null, Buffer.from(`${h}.${p}`, 'ascii'), publicKey, fromB64url(s));
  if (!ok) throw new Error('OFFLINE_LICENSE_BAD_SIGNATURE');
  let payload: T;
  try {
    payload = JSON.parse(fromB64url(p).toString('utf8')) as T;
  } catch {
    throw new Error('OFFLINE_LICENSE_MALFORMED');
  }
  return { header, payload };
}
