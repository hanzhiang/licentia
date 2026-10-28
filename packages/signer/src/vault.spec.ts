/// <reference types="vitest" />
/**
 * Vault Transit 签名集成测试(设计文档 §10.1 P4).
 * 前置: docker compose up -d vault (VAULT_ADDR/VAULT_TOKEN 环境变量可覆盖默认).
 * Vault 不可达时整组跳过, 不影响 CI.
 */
import { describe, expect, it } from 'vitest';
import { LicenseSigner, LocalSignerProvider, VaultSignerProvider, makeVaultProvider } from './index';

const addr = process.env.VAULT_ADDR ?? 'http://localhost:8200';
const token = process.env.VAULT_TOKEN ?? 'lp-root';
const keyName = process.env.VAULT_TRANSIT_KEY ?? 'license-dev-test';

async function vaultUp(): Promise<boolean> {
  try {
    const res = await fetch(`${addr}/v1/sys/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok || res.status === 429; // 429 = standby/sealed 比例, 仍可判活
  } catch {
    return false;
  }
}

const d = (await vaultUp()) ? describe : describe.skip;

d('vault transit signer (requires local vault)', () => {
  const provider: VaultSignerProvider = makeVaultProvider({
    kid: 'vault-test-2026-01',
    addr,
    token,
    keyName,
  });
  const signer = new LicenseSigner(provider);

  it('signs and self-verifies via vault public key', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const lic = await signer.issueOfflineLicense({
      licenseId: 'lic-vault-1',
      tenantId: 'tenant-vault',
      productCode: 'dorm-check',
      features: ['dorm'],
      offlineWindowDays: 1,
      nowSec,
    });
    const claims = await signer.verifyOfflineLicense(lic, nowSec + 30);
    expect(claims.lic).toBe('lic-vault-1');
  }, 30_000);

  it('vault-signed license fails local-key verification (key isolation)', async () => {
    const local = new LicenseSigner(new LocalSignerProvider('local-kid', 'local-seed'));
    const lic = await signer.issueOfflineLicense({
      licenseId: 'lic-vault-2',
      tenantId: 't',
      productCode: 'p',
      features: [],
      offlineWindowDays: 1,
    });
    await expect(local.verifyOfflineLicense(lic)).rejects.toThrow('OFFLINE_LICENSE_BAD_SIGNATURE');
  }, 30_000);
});
