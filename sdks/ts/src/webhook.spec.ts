/// <reference types="vitest" />
import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { verifyWebhookSignature } from './webhook';

const secret = 'whsec_test';
const body = JSON.stringify({ event_id: 'e1', type: 'license.revoked', data: {} });

function sign(t: number): string {
  const sig = crypto.createHmac('sha256', secret).update(`${t}.${body}`, 'utf8').digest('hex');
  return `t=${t},v1=${sig}`;
}

describe('sdk webhook signature verify', () => {
  const now = 1_800_000_000;

  it('accepts a fresh valid signature', () => {
    expect(verifyWebhookSignature(secret, body, sign(now), 300, now)).toEqual({ valid: true });
  });

  it('rejects tampered body / stale timestamp / malformed header', () => {
    expect(verifyWebhookSignature(secret, body + ' ', sign(now), 300, now).reason).toBe('BAD_SIGNATURE');
    expect(verifyWebhookSignature(secret, body, sign(now - 3600), 300, now).reason).toBe('STALE_TIMESTAMP');
    expect(verifyWebhookSignature(secret, body, 'v1=deadbeef', 300, now).reason).toBe('MALFORMED');
    expect(verifyWebhookSignature(secret, body, undefined, 300, now).reason).toBe('MALFORMED');
  });
});
