import { describe, expect, it } from 'vitest';
import {
  assertTransition,
  canTransition,
  computeEntitlement,
  statusError,
  validatePolicy,
  AppError,
} from './index';

describe('license state machine', () => {
  it('allows all legal transitions from the design table', () => {
    expect(canTransition('issued', 'activated')).toBe(true);
    expect(canTransition('issued', 'revoked')).toBe(true);
    expect(canTransition('issued', 'expired')).toBe(true);
    expect(canTransition('activated', 'activated')).toBe(true); // 续期
    expect(canTransition('activated', 'suspended')).toBe(true);
    expect(canTransition('activated', 'revoked')).toBe(true);
    expect(canTransition('activated', 'expired')).toBe(true);
    expect(canTransition('suspended', 'activated')).toBe(true);
    expect(canTransition('suspended', 'revoked')).toBe(true);
    expect(canTransition('expired', 'activated')).toBe(true); // 续期窗口复活
    expect(canTransition('expired', 'revoked')).toBe(true);
  });

  it('rejects illegal transitions (revoked is absolute terminal)', () => {
    const all: Array<'issued' | 'activated' | 'suspended' | 'revoked' | 'expired'> = [
      'issued',
      'activated',
      'suspended',
      'revoked',
      'expired',
    ];
    for (const to of all) {
      expect(canTransition('revoked', to)).toBe(false);
    }
    expect(canTransition('issued', 'suspended')).toBe(false);
    expect(canTransition('expired', 'suspended')).toBe(false);
    expect(canTransition('suspended', 'expired')).toBe(false);
  });

  it('assertTransition throws LIC_STATUS_INVALID with http 409', () => {
    try {
      assertTransition('revoked', 'activated');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      const err = e as AppError;
      expect(err.code).toBe('LIC_STATUS_INVALID');
      expect(err.http).toBe(409);
    }
  });

  it('maps statuses to client-facing semantic errors', () => {
    expect(statusError('revoked').code).toBe('LIC_REVOKED');
    expect(statusError('expired').code).toBe('LIC_EXPIRED');
    expect(statusError('suspended').code).toBe('LIC_SUSPENDED');
    expect(statusError('suspended').http).toBe(423);
  });
});

describe('computeEntitlement', () => {
  const now = new Date('2026-10-27T00:00:00Z');

  it('valid activated license before expiry', () => {
    expect(
      computeEntitlement({ status: 'activated', expiresAt: new Date('2027-01-01') }, now).valid,
    ).toBe(true);
  });

  it('permanent license (expiresAt null) never expires', () => {
    expect(computeEntitlement({ status: 'activated', expiresAt: null }, now).valid).toBe(true);
  });

  it('expired when expiresAt passed (lazy check even if scanner has not run)', () => {
    const r = computeEntitlement(
      { status: 'activated', expiresAt: new Date('2026-10-26T23:59:59Z') },
      now,
    );
    expect(r).toEqual({ valid: false, reason: 'LIC_EXPIRED' });
  });

  it('revoked/suspended/issued map to their reasons', () => {
    expect(computeEntitlement({ status: 'revoked', expiresAt: null }, now)).toEqual({
      valid: false,
      reason: 'LIC_REVOKED',
    });
    expect(computeEntitlement({ status: 'suspended', expiresAt: null }, now)).toEqual({
      valid: false,
      reason: 'LIC_SUSPENDED',
    });
    expect(computeEntitlement({ status: 'issued', expiresAt: null }, now)).toEqual({
      valid: false,
      reason: 'LIC_STATUS_INVALID',
    });
  });
});

describe('validatePolicy', () => {
  const base = {
    durationDays: 365 as number | null,
    deviceLimit: 5,
    seatLimit: null as number | null,
    concurrencyLimit: null as number | null,
    features: ['dorm'],
    offlineWindowDays: 7,
    allowRenewal: true,
  };

  it('accepts a standard policy', () => {
    expect(validatePolicy({ ...base, kind: 'standard' })).toEqual([]);
  });

  it('rejects trial with duration > 30 or renewal', () => {
    const errs = validatePolicy({ ...base, kind: 'trial', durationDays: 60, allowRenewal: true });
    expect(errs.length).toBeGreaterThanOrEqual(2);
  });

  it('requires concurrency_limit for floating', () => {
    expect(validatePolicy({ ...base, kind: 'floating' }).length).toBeGreaterThan(0);
    expect(
      validatePolicy({ ...base, kind: 'floating', concurrencyLimit: 10, seatLimit: 20 }),
    ).toEqual([]);
  });

  it('perpetual must have null duration', () => {
    expect(validatePolicy({ ...base, kind: 'perpetual', durationDays: null })).toEqual([]);
    expect(
      validatePolicy({ ...base, kind: 'perpetual', durationDays: 365 }).length).toBeGreaterThan(0);
  });

  it('concurrency_limit cannot exceed seat_limit', () => {
    expect(
      validatePolicy({ ...base, kind: 'floating', concurrencyLimit: 30, seatLimit: 20 }).length,
    ).toBeGreaterThan(0);
  });
});
