import { describe, expect, it } from 'vitest';
import { LicenseSigner, LocalSignerProvider, makeSignerProvider } from './index';

const signer = new LicenseSigner(new LocalSignerProvider('dev-2026-01', 'test-seed'));

describe('offline license (JWS EdDSA)', () => {
  it('issues and verifies within window', async () => {
    const nowSec = 1760000000;
    const token = await signer.issueOfflineLicense({
      licenseId: '01HX',
      tenantId: 'tenant-a',
      productCode: 'dorm-check',
      features: ['dorm', 'leave'],
      offlineWindowDays: 7,
      deviceHash: Buffer.from('fp-hash'),
      nowSec,
    });
    const claims = await signer.verifyOfflineLicense(token, nowSec + 60);
    expect(claims.lic).toBe('01HX');
    expect(claims.feats).toEqual(['dorm', 'leave']);
    expect(claims.exp - claims.iat).toBe(7 * 86400);
    expect(claims.dev).toBe(Buffer.from('fp-hash').toString('base64url'));
  });

  it('rejects tampered payload', async () => {
    const token = await signer.issueOfflineLicense({
      licenseId: '01HX',
      tenantId: 't',
      productCode: 'p',
      features: [],
      offlineWindowDays: 7,
      nowSec: 1760000000,
    });
    const [h, p, s] = token.split('.');
    const payload = JSON.parse(Buffer.from(p!, 'base64url').toString('utf8'));
    payload.feats = ['root']; // 越权提权尝试
    const forgedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
    await expect(signer.verifyOfflineLicense(`${h}.${forgedPayload}.${s}`)).rejects.toThrow(
      'OFFLINE_LICENSE_BAD_SIGNATURE',
    );
  });

  it('rejects expired license', async () => {
    const nowSec = 1760000000;
    const token = await signer.issueOfflineLicense({
      licenseId: '01HX',
      tenantId: 't',
      productCode: 'p',
      features: [],
      offlineWindowDays: 7,
      nowSec,
    });
    // 过期 7 天 + 1 小时(超出 300s 容差)
    await expect(signer.verifyOfflineLicense(token, nowSec + 7 * 86400 + 3600)).rejects.toThrow(
      'OFFLINE_LICENSE_EXPIRED',
    );
  });

  it('rejects wrong-key signatures (key isolation between products)', async () => {
    const other = new LicenseSigner(new LocalSignerProvider('other-product-2026-01', 'other-seed'));
    const token = await signer.issueOfflineLicense({
      licenseId: '01HX',
      tenantId: 't',
      productCode: 'p',
      features: [],
      offlineWindowDays: 1,
      nowSec: 1760000000,
    });
    await expect(other.verifyOfflineLicense(token, 1760000000 + 60)).rejects.toThrow(
      'OFFLINE_LICENSE_BAD_SIGNATURE',
    );
  });

  it('rejects alg-confusion tokens', async () => {
    // kid 必须存在: 否则会在密钥查找阶段就被拒, 测不到算法白名单
    const forged = `${Buffer.from(JSON.stringify({ typ: 'license+jwt', alg: 'none', kid: signer.kid })).toString('base64url')}.${Buffer.from('{}').toString('base64url')}.`;
    await expect(signer.verifyOfflineLicense(forged)).rejects.toThrow('OFFLINE_LICENSE_BAD_ALG');
  });

  it('makeSignerProvider: vault requires connection config; returns provider when given', () => {
    expect(() => makeSignerProvider({ provider: 'vault', kid: 'k' })).toThrow(
      /VAULT_ADDR/,
    );
    const p = makeSignerProvider({
      provider: 'vault',
      kid: 'k',
      vault: { addr: 'http://localhost:8200', token: 't', keyName: 'k1' },
    });
    expect(p.kid).toBe('k');
  });

  it('dual-kid rotation: old-kid licenses verify during the parallel window', async () => {
    const oldSigner = new LicenseSigner(new LocalSignerProvider('prod-2026-01', 'seed-old'));
    const nowSec = Math.floor(Date.now() / 1000);
    // 轮换前签发的旧许可
    const oldToken = await oldSigner.issueOfflineLicense({
      licenseId: 'lic-old',
      tenantId: 't',
      productCode: 'p',
      features: [],
      offlineWindowDays: 7,
      nowSec,
    });

    // 轮换后: 新钥签发, 旧钥仅验签
    const rotated = new LicenseSigner([
      new LocalSignerProvider('prod-2026-02', 'seed-new'),
      new LocalSignerProvider('prod-2026-01', 'seed-old'),
    ]);
    const newToken = await rotated.issueOfflineLicense({
      licenseId: 'lic-new',
      tenantId: 't',
      productCode: 'p',
      features: [],
      offlineWindowDays: 7,
      nowSec,
    });

    expect(rotated.kid).toBe('prod-2026-02');
    await expect(rotated.verifyOfflineLicense(oldToken, nowSec + 60)).resolves.toMatchObject({
      lic: 'lic-old',
    }); // 并行验证窗: 旧许可可验
    await expect(rotated.verifyOfflineLicense(newToken, nowSec + 60)).resolves.toMatchObject({
      lic: 'lic-new',
    });

    const jwks = await rotated.publicJwks();
    expect(jwks.keys.map((k) => k.kid).sort()).toEqual(['prod-2026-01', 'prod-2026-02']);

    // 并行窗结束(旧钥移除)后旧许可拒绝
    const afterWindow = new LicenseSigner([new LocalSignerProvider('prod-2026-02', 'seed-new')]);
    await expect(afterWindow.verifyOfflineLicense(oldToken)).rejects.toThrow(
      'OFFLINE_LICENSE_BAD_SIGNATURE',
    );
  });
});
