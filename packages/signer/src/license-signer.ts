import type { SignerProvider } from './types';
import { LocalSignerProvider } from './local-provider';
import { makeVaultProvider } from './vault-provider';
import { signCompactJws, verifyCompactJwsEd25519 } from './jws';

/**
 * 离线许可证(设计文档 §10.3): JWS Compact + EdDSA.
 * exp = iat + olw(离线窗口秒数); 联网刷新即续签.
 * 绑定维度: dev(设备指纹 HMAC) / seat(席位) / conc(浮动并发).
 */
export interface OfflineLicenseClaims {
  jti: string;
  lic: string;
  tnt: string;
  prd: string;
  feats: string[];
  dev?: string;
  seat?: number;
  conc?: number;
  olw: number;
  iat: number;
  exp: number;
}

export interface IssueOfflineLicenseInput {
  licenseId: string;
  tenantId: string;
  productCode: string;
  features: string[];
  offlineWindowDays: number;
  deviceHash?: Buffer;
  seatLimit?: number | null;
  concurrencyLimit?: number | null;
  nowSec?: number;
}

export class LicenseSigner {
  /** [0] 为当前签名钥, 其余为轮换并行验证期内的旧钥(设计文档 §10.2 双密钥窗口) */
  private readonly providers: SignerProvider[];

  constructor(providerOrProviders: SignerProvider | SignerProvider[]) {
    this.providers = Array.isArray(providerOrProviders)
      ? providerOrProviders
      : [providerOrProviders];
    if (this.providers.length === 0) throw new Error('LicenseSigner: 至少需要一个签名提供者');
  }

  get kid(): string {
    return this.providers[0]!.kid;
  }

  get kids(): string[] {
    return this.providers.map((p) => p.kid);
  }

  async publicJwk(): Promise<Record<string, string>> {
    return this.providers[0]!.publicJwk();
  }

  /** JWKS 全量: 当前 + 并行验证期旧钥(客户端按 kid 匹配) */
  async publicJwks(): Promise<{ keys: Record<string, string>[] }> {
    const keys: Record<string, string>[] = [];
    const seen = new Set<string>();
    for (const p of this.providers) {
      if (seen.has(p.kid)) continue;
      seen.add(p.kid);
      keys.push(await p.publicJwk());
    }
    return { keys };
  }

  async issueOfflineLicense(input: IssueOfflineLicenseInput): Promise<string> {
    const iat = input.nowSec ?? Math.floor(Date.now() / 1000);
    const olw = input.offlineWindowDays * 86400;
    const claims: OfflineLicenseClaims = {
      jti: `${input.licenseId}:${iat}`,
      lic: input.licenseId,
      tnt: input.tenantId,
      prd: input.productCode,
      feats: input.features,
      olw,
      iat,
      exp: iat + olw,
      ...(input.deviceHash ? { dev: Buffer.from(input.deviceHash).toString('base64url') } : {}),
      ...(input.seatLimit != null ? { seat: input.seatLimit } : {}),
      ...(input.concurrencyLimit != null ? { conc: input.concurrencyLimit } : {}),
    };
    return signCompactJws(
      this.providers[0]!,
      { typ: 'license+jwt', alg: 'EdDSA', kid: this.providers[0]!.kid },
      claims,
    );
  }

  /** 用本产品公钥验签(接受当前钥与并行验证期旧钥) + 过期检查(时钟容差 300s) */
  async verifyOfflineLicense(
    token: string,
    nowSec: number = Math.floor(Date.now() / 1000),
    maxClockSkewSec = 300,
  ): Promise<OfflineLicenseClaims> {
    const headerKid = parseKid(token);
    const provider = this.providers.find((p) => p.kid === headerKid);
    // 旧钥已移出并行窗时, 头里残留的旧 kid 无法区分"密钥轮换"与"伪造签名", 统一按签名失败处理
    if (!provider) {
      throw new Error(
        headerKid
          ? 'OFFLINE_LICENSE_BAD_SIGNATURE'
          : `OFFLINE_LICENSE_UNKNOWN_KID: ${headerKid}`,
      );
    }
    const { header, payload } = await verifyCompactJwsEd25519<OfflineLicenseClaims>(
      token,
      await provider.publicKey(),
    );
    if (header.typ !== 'license+jwt') throw new Error('OFFLINE_LICENSE_BAD_HEADER');
    if (!payload || typeof payload.exp !== 'number' || typeof payload.iat !== 'number') {
      throw new Error('OFFLINE_LICENSE_MALFORMED');
    }
    if (payload.iat > nowSec + maxClockSkewSec) {
      throw new Error('OFFLINE_LICENSE_NOT_YET_VALID'); // 服务端时钟回拨防护
    }
    if (nowSec >= payload.exp + maxClockSkewSec) {
      throw new Error('OFFLINE_LICENSE_EXPIRED');
    }
    return payload;
  }
}

export function parseKid(token: string): string {
  const h = token.split('.')[0] ?? '';
  try {
    return (JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as { kid?: string }).kid ?? '';
  } catch {
    return '';
  }
}

export interface SignerProviderConfig {
  provider: 'local' | 'vault';
  kid: string;
  localSeed?: string;
  vault?: { addr: string; token: string; keyName: string };
}

export function makeSignerProvider(cfg: SignerProviderConfig): SignerProvider {
  switch (cfg.provider) {
    case 'local':
      return new LocalSignerProvider(cfg.kid, cfg.localSeed ?? 'dev-seed');
    case 'vault': {
      if (!cfg.vault) {
        throw new Error('SIGNER_PROVIDER=vault 需要 VAULT_ADDR/VAULT_TOKEN/VAULT_TRANSIT_KEY');
      }
      return makeVaultProvider({ kid: cfg.kid, ...cfg.vault });
    }
  }
}

/**
 * 多钥构建(设计文档 §10.2): 当前钥 + 可选上一代钥(60 天并行验证窗).
 * 轮换流程: 新钥入 SIGNER_ACTIVE_*, 旧钥降级 SIGNER_PREVIOUS_*, 60 天后移除.
 */
export function makeSignerProviders(cfg: {
  provider: 'local' | 'vault';
  kid: string;
  localSeed?: string;
  vault?: { addr: string; token: string; keyName: string };
  previousKid?: string | null;
  previousLocalSeed?: string | null;
  previousVaultKeyName?: string | null;
}): SignerProvider[] {
  const active = makeSignerProvider(cfg);
  const providers: SignerProvider[] = [active];
  if (cfg.previousKid && cfg.previousKid !== cfg.kid) {
    providers.push(
      makeSignerProvider({
        provider: cfg.provider,
        kid: cfg.previousKid,
        localSeed: cfg.previousLocalSeed ?? undefined,
        vault:
          cfg.provider === 'vault' && cfg.vault
            ? { ...cfg.vault, keyName: cfg.previousVaultKeyName ?? `${cfg.vault.keyName}-prev` }
            : undefined,
      }),
    );
  }
  return providers;
}
