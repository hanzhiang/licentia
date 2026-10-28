import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  type KeyObject,
} from 'node:crypto';
import type { SignerProvider } from './types';

/** Ed25519 PKCS8 DER 前缀(RFC 8410), 后接 32B 私钥种子 */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export function ed25519KeyPairFromSeed(seed: string): {
  privateKey: KeyObject;
  publicKey: KeyObject;
} {
  const seed32 = createHash('sha256').update(seed, 'utf8').digest();
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed32]),
    format: 'der',
    type: 'pkcs8',
  });
  return { privateKey, publicKey: createPublicKey(privateKey) };
}

/** 开发/测试用: 种子确定性派生 Ed25519 密钥对, 纯本地签名 */
export class LocalSignerProvider implements SignerProvider {
  private readonly keys: { privateKey: KeyObject; publicKey: KeyObject };

  constructor(
    readonly kid: string,
    seed: string,
  ) {
    this.keys = ed25519KeyPairFromSeed(seed);
  }

  async sign(msg: Uint8Array): Promise<Uint8Array> {
    return cryptoSign(null, msg, this.keys.privateKey);
  }

  async publicKey(): Promise<KeyObject> {
    return this.keys.publicKey;
  }

  async publicJwk(): Promise<Record<string, string>> {
    const jwk = this.keys.publicKey.export({ format: 'jwk' }) as {
      kty: string;
      crv: string;
      x: string;
    };
    return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, kid: this.kid, use: 'sig', alg: 'EdDSA' };
  }
}
