import type { KeyObject } from 'node:crypto';

/**
 * 签名提供者抽象: 骨架实现 local(开发期, 种子派生 Ed25519).
 * 生产按设计文档 §10.1 换 Vault Transit / 云 KMS 适配器, 私钥不出库.
 */
export interface SignerProvider {
  readonly kid: string;
  sign(msg: Uint8Array): Promise<Uint8Array>;
  publicKey(): Promise<KeyObject>;
  publicJwk(): Promise<Record<string, string>>;
}
