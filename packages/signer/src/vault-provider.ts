import { createPublicKey, type KeyObject } from 'node:crypto';
import type { SignerProvider } from './types';

/**
 * Vault Transit 签名适配器(设计文档 §10.1): Ed25519 私钥不出 HSM/Vault, 仅调 sign API.
 * 前置: vault 启用 transit, 密钥 type=ed25519 (首次调用自动创建).
 * VAULT_ADDR / VAULT_TOKEN / VAULT_TRANSIT_KEY 环境变量.
 */
export class VaultSignerProvider implements SignerProvider {
  private pubCache: { key: KeyObject; at: number } | null = null;
  private engineReady = false;

  constructor(
    readonly kid: string,
    private readonly addr: string,
    private readonly token: string,
    private readonly keyName: string,
  ) {}

  private url(path: string): string {
    return `${this.addr.replace(/\/$/, '')}/v1/transit/${path}`;
  }

  private headers(): Record<string, string> {
    return { 'X-Vault-Token': this.token, 'content-type': 'application/json' };
  }

  /** 引导: transit 引擎未挂载时自动挂载(dev vault 默认只有 kv) */
  private async ensureEngine(): Promise<void> {
    if (this.engineReady) return;
    const res = await fetch(this.url('mounts/transit'), {
      headers: this.headers(),
      signal: AbortSignal.timeout(3000),
    });
    if (res.status === 404) {
      const m = await fetch(`${this.addr.replace(/\/$/, '')}/v1/sys/mounts/transit`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ type: 'transit' }),
        signal: AbortSignal.timeout(3000),
      });
      if (!m.ok && m.status !== 204 && m.status !== 400) {
        throw new Error(`vault mount transit failed: http ${m.status}`);
      }
    } else if (!res.ok) {
      throw new Error(`vault mounts read failed: http ${res.status}`);
    }
    this.engineReady = true;
  }

  private async ensureKey(): Promise<void> {
    await this.ensureEngine();
    const res = await fetch(this.url(`keys/${this.keyName}`), {
      headers: this.headers(),
      signal: AbortSignal.timeout(3000),
    });
    if (res.status === 404) {
      const created = await fetch(this.url(`keys/${this.keyName}`), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ type: 'ed25519', derived: false }),
        signal: AbortSignal.timeout(3000),
      });
      if (!created.ok && created.status !== 204) {
        throw new Error(`vault key create failed: http ${created.status}`);
      }
      return;
    }
    if (!res.ok) throw new Error(`vault key read failed: http ${res.status}`);
  }

  async sign(msg: Uint8Array): Promise<Uint8Array> {
    await this.ensureKey();
    const res = await fetch(this.url(`sign/${this.keyName}`), {
      method: 'POST',
      headers: { 'X-Vault-Token': this.token, 'content-type': 'application/json' },
      body: JSON.stringify({
        input: Buffer.from(msg).toString('base64'),
        prehashed: false,
        marshaling_algorithm: 'jws',
        signature_algorithm: 'ed25519',
      }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`vault sign failed: http ${res.status}`);
    const json = (await res.json()) as { data?: { signature?: string } };
    const full = json.data?.signature ?? '';
    const raw = full.split(':').pop() ?? ''; // vault:vN:<base64>
    const sig = Buffer.from(raw, 'base64');
    if (sig.length !== 64) throw new Error('vault sign: unexpected signature length');
    return sig;
  }

  async publicKey(): Promise<KeyObject> {
    // 公钥缓存 5 分钟(轮换时由 kid 切换, 缓存安全)
    if (this.pubCache && Date.now() - this.pubCache.at < 300_000) return this.pubCache.key;
    await this.ensureKey();
    const res = await fetch(this.url(`keys/${this.keyName}`), {
      headers: { 'X-Vault-Token': this.token },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`vault public key failed: http ${res.status}`);
    const json = (await res.json()) as { data?: { keys?: Record<string, { public_key?: string }> } };
    const versions = json.data?.keys ?? {};
    const latest = Object.keys(versions).sort((a, b) => Number(b) - Number(a))[0];
    const pub = latest ? versions[latest]?.public_key : undefined;
    if (!pub) throw new Error('vault public key missing');
    // vault 对 ed25519 返回 32B 裸公钥(base64), 包装成 SPKI DER; 兼容 PEM 形式
    const raw = Buffer.from(pub, 'base64');
    const key =
      raw.length === 32
        ? createPublicKey({
            key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]),
            format: 'der',
            type: 'spki',
          })
        : createPublicKey(pub);
    this.pubCache = { key, at: Date.now() };
    return key;
  }

  async publicJwk(): Promise<Record<string, string>> {
    const jwk = (await this.publicKey()).export({ format: 'jwk' }) as {
      kty: string;
      crv: string;
      x: string;
    };
    return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, kid: this.kid, use: 'sig', alg: 'EdDSA' };
  }
}

export function makeVaultProvider(cfg: {
  kid: string;
  addr: string;
  token: string;
  keyName: string;
}): VaultSignerProvider {
  return new VaultSignerProvider(cfg.kid, cfg.addr, cfg.token, cfg.keyName);
}
