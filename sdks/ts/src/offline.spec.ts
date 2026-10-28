/// <reference types="vitest" />
import { describe, expect, it } from 'vitest';
import { LicenseSigner, LocalSignerProvider } from '../../../packages/signer/src/index';
import { verifyOfflineLicense, clockRollbackOk } from './offline';

const signer = new LicenseSigner(new LocalSignerProvider('sdk-test-kid', 'sdk-test-seed'));
const jwks = await signer.publicJwks();

async function makeLicense(offlineWindowDays = 7): Promise<string> {
  return signer.issueOfflineLicense({
    licenseId: 'lic-sdk-1',
    tenantId: 't1',
    productCode: 'dorm-check',
    features: ['dorm', 'leave'],
    offlineWindowDays,
  });
}

describe('sdk offline verify', () => {
  it('verifies a valid offline license via JWKS (kid match)', async () => {
    const token = await makeLicense();
    const claims = await verifyOfflineLicense(token, { jwks });
    expect(claims.lic).toBe('lic-sdk-1');
    expect(claims.feats).toEqual(['dorm', 'leave']);
    expect(claims.exp - claims.iat).toBe(7 * 86400);
  });

  it('rejects tampered / wrong-key / unknown-kid licenses', async () => {
    const token = await makeLicense();
    const [h, p, s] = token.split('.');
    const payload = JSON.parse(Buffer.from(p!, 'base64url').toString('utf8'));
    payload.feats = ['admin'];
    const forged = `${h}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${s}`;
    await expect(verifyOfflineLicense(forged, { jwks })).rejects.toThrow('OFFLINE_LICENSE_BAD_SIGNATURE');

    const other = new LicenseSigner(new LocalSignerProvider('other-kid', 'other-seed'));
    await expect(
      verifyOfflineLicense(await other.issueOfflineLicense({
        licenseId: 'x', tenantId: 't', productCode: 'p', features: [], offlineWindowDays: 1,
      }), { jwks }),
    ).rejects.toThrow('OFFLINE_LICENSE_UNKNOWN_KID');
  });

  it('rejects expired licenses beyond clock tolerance', async () => {
    const nowSec = 1_800_000_000;
    const token = await makeLicense(1);
    await expect(
      verifyOfflineLicense(token, { jwks, nowSec: nowSec + 2 * 86400 }),
    ).rejects.toThrow('OFFLINE_LICENSE_EXPIRED');
  });

  it('clock rollback guard', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(clockRollbackOk(now + 3600, now)).toBe(true); // 1h 回拨: 容忍(默认 24h)
    expect(clockRollbackOk(now + 25 * 3600, now)).toBe(false); // 25h 回拨: 拒绝
  });
});
