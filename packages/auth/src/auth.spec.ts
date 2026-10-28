import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { signJwt, verifyJwt, hashPassword, verifyPassword, generateClientToken } from './index';

describe('password (scrypt)', () => {
  it('hashes and verifies', () => {
    const h = hashPassword('Passw0rd!demo');
    expect(h.startsWith('scrypt$16384$8$1$')).toBe(true);
    expect(verifyPassword('Passw0rd!demo', h)).toBe(true);
    expect(verifyPassword('wrong', h)).toBe(false);
  });

  it('salt is random (two hashes differ)', () => {
    expect(hashPassword('x')).not.toBe(hashPassword('x'));
  });

  it('rejects malformed stored hash', () => {
    expect(verifyPassword('x', 'garbage')).toBe(false);
  });
});

describe('jwt (RS256)', () => {
  const keysDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-jwt-'));
  const cfg = { keysDir, kid: 'test-jwt-1' };

  it('signs and verifies within ttl', () => {
    const token = signJwt({ sub: 'u1', tid: 't1', typ: 'access' }, 60, cfg);
    const claims = verifyJwt(token, cfg);
    expect(claims.sub).toBe('u1');
    expect(claims.tid).toBe('t1');
    expect(claims.exp - claims.iat).toBe(60);
  });

  it('rejects tampered payload', () => {
    const token = signJwt({ sub: 'u1', tid: 't1', typ: 'access' }, 60, cfg);
    const [h, p, s] = token.split('.');
    const payload = JSON.parse(Buffer.from(p!, 'base64url').toString('utf8'));
    payload.tid = 'evil-tenant';
    const forged = `${h}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${s}`;
    expect(() => verifyJwt(forged, cfg)).toThrow('JWT_BAD_SIGNATURE');
  });

  it('rejects alg confusion and expired tokens', () => {
    const noneAlg = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from('{}').toString('base64url')}.`;
    expect(() => verifyJwt(noneAlg, cfg)).toThrow('JWT_BAD_ALG');
    const expired = signJwt({ sub: 'u1', tid: null, typ: 'access' }, -10, cfg);
    expect(() => verifyJwt(expired, cfg)).toThrow('JWT_EXPIRED');
  });

  it('reuses persisted keys across calls (kid stable)', () => {
    const t1 = signJwt({ sub: 'u2', tid: null, typ: 'access' }, 60, cfg);
    expect(verifyJwt(t1, cfg).sub).toBe('u2');
    expect(fs.existsSync(path.join(keysDir, 'jwt-private.pem'))).toBe(true);
  });
});

describe('client token', () => {
  it('still exported and unique', () => {
    expect(generateClientToken()).not.toBe(generateClientToken());
  });
});
