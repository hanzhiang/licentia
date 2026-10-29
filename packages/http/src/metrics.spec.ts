import { afterEach, describe, expect, it } from 'vitest';
import { metricsAccess } from './metrics';

const originalToken = process.env.METRICS_TOKEN;
const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  if (originalToken === undefined) delete process.env.METRICS_TOKEN;
  else process.env.METRICS_TOKEN = originalToken;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
});

function req(auth?: string): Parameters<typeof metricsAccess>[0] {
  return auth === undefined ? { method: 'GET' } : { method: 'GET', headers: { authorization: auth } };
}

describe('metrics access control', () => {
  it('is open in dev when no token is configured', () => {
    delete process.env.METRICS_TOKEN;
    process.env.NODE_ENV = 'dev';
    expect(metricsAccess(req())).toBe('ok');
  });

  it('is hidden in production when no token is configured', () => {
    delete process.env.METRICS_TOKEN;
    process.env.NODE_ENV = 'prod';
    expect(metricsAccess(req())).toBe('hidden');
  });

  it('requires the bearer token when one is configured', () => {
    process.env.METRICS_TOKEN = 's3cret';
    process.env.NODE_ENV = 'prod';
    expect(metricsAccess(req())).toBe('unauthorized');
    expect(metricsAccess(req('Bearer wrong'))).toBe('unauthorized');
    expect(metricsAccess(req('s3cret'))).toBe('unauthorized');
    expect(metricsAccess(req('Bearer s3cret'))).toBe('ok');
  });
});
