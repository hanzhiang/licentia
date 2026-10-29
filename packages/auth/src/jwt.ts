import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * 管理 JWT(设计文档 §3): RS256, 15min 有效期.
 * 密钥: 首次启动自动生成 RSA-2048 并落盘(骨架); 生产由 KMS/Vault 托管并多实例共享.
 */
export interface JwtClaims {
  sub: string; // user id 或 portal 手机号哈希
  tid: string | null; // tenant id, 平台账号为 null
  typ: 'access' | 'portal' | 'mfa';
  iat: number;
  exp: number;
}

export interface JwtKeyConfig {
  keysDir: string;
  kid: string;
}

interface LoadedKeys {
  privateKeyPem: string;
  privateKey: crypto.KeyObject;
  publicKey: crypto.KeyObject;
  kid: string;
}

let loaded: LoadedKeys | undefined;

function loadOrGenerateKeys(cfg: JwtKeyConfig): LoadedKeys {
  if (loaded) return loaded;
  fs.mkdirSync(cfg.keysDir, { recursive: true });
  const privPath = path.join(cfg.keysDir, 'jwt-private.pem');
  if (!fs.existsSync(privPath)) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    fs.writeFileSync(privPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), {
      mode: 0o600,
    });
    fs.writeFileSync(
      path.join(cfg.keysDir, 'jwt-public.pem'),
      publicKey.export({ type: 'spki', format: 'pem' }),
    );
  }
  const privateKeyPem = fs.readFileSync(privPath, 'utf8');
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  loaded = {
    privateKeyPem,
    privateKey,
    publicKey: crypto.createPublicKey(privateKey),
    kid: cfg.kid,
  };
  return loaded;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

export function signJwt(claims: Omit<JwtClaims, 'iat' | 'exp'>, ttlSec: number, cfg: JwtKeyConfig): string {
  const keys = loadOrGenerateKeys(cfg);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT', kid: keys.kid };
  const payload: JwtClaims = { ...claims, iat: now, exp: now + ttlSec };
  const h = b64url(Buffer.from(JSON.stringify(header), 'utf8'));
  const p = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = crypto.sign('sha256', Buffer.from(`${h}.${p}`, 'ascii'), keys.privateKey);
  return `${h}.${p}.${b64url(sig)}`;
}

export function verifyJwt(
  token: string,
  cfg: JwtKeyConfig,
  allowedTyps: Array<JwtClaims['typ']> = ['access'],
): JwtClaims {
  const keys = loadOrGenerateKeys(cfg);
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('JWT_MALFORMED');
  const [h, p, s] = parts as [string, string, string];
  const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as { alg: string };
  if (header.alg !== 'RS256') throw new Error('JWT_BAD_ALG'); // 防 alg 混淆
  const ok = crypto.verify(
    'sha256',
    Buffer.from(`${h}.${p}`, 'ascii'),
    keys.publicKey,
    Buffer.from(s, 'base64url'),
  );
  if (!ok) throw new Error('JWT_BAD_SIGNATURE');
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as JwtClaims;
  if (!allowedTyps.includes(claims.typ)) throw new Error('JWT_BAD_TYP'); // access/portal 令牌不得混用
  if (claims.exp <= Math.floor(Date.now() / 1000)) throw new Error('JWT_EXPIRED');
  return claims;
}
