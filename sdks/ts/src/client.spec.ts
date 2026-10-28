/// <reference types="vitest" />
/**
 * LicenseClient 行为测试: 进程内 stub 服务器模拟平台响应(激活/幂等重放/心跳轮换/时钟回拨).
 * 真实服务联调走 test/e2e(需 TEST_DATABASE_URL 与运行中的 client-api).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';
import { LicenseClient, memoryStorage, type KvStorage } from './client';
import { verifyWebhookSignature } from './webhook';
import { LicenseSigner, LocalSignerProvider } from '../../../packages/signer/src/index';

const signer = new LicenseSigner(new LocalSignerProvider('sdk-stub-kid', 'sdk-stub-seed'));

let server: http.Server;
let baseUrl = '';
let state: {
  activateCalls: number;
  heartbeatCalls: number;
  replay: boolean;
  serverTime: number;
  lastActivateBody: Record<string, unknown> | null;
  lastHeartbeatBody: Record<string, unknown> | null;
};

beforeAll(async () => {
  state = {
    activateCalls: 0,
    heartbeatCalls: 0,
    replay: false,
    serverTime: Math.floor(Date.now() / 1000),
    lastActivateBody: null,
    lastHeartbeatBody: null,
  };
  const offline = await signer.issueOfflineLicense({
    licenseId: 'lic-stub',
    tenantId: 't',
    productCode: 'dorm-check',
    features: ['dorm'],
    offlineWindowDays: 7,
    nowSec: state.serverTime,
  });
  const jwks = await signer.publicJwks();
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/client/v1/activate') {
        state.activateCalls += 1;
        state.lastActivateBody = JSON.parse(body || '{}') as Record<string, unknown>;
        res.writeHead(state.replay ? 200 : 201);
        res.end(JSON.stringify({
          data: {
            client_token: 'ct_first',
            expires_at: '2027-10-27T00:00:00Z',
            license: { id: 'lic-stub', kind: 'standard', status: 'activated', features: ['dorm'], device: { bound: 1, limit: 5 }, offline_window_days: 7, heartbeat_hours: 24 },
            offline_license: offline,
            server_time: state.serverTime,
            replayed: state.replay,
          },
        }));
        return;
      }
      if (req.url === '/client/v1/heartbeat') {
        state.lastHeartbeatBody = JSON.parse(body || '{}') as Record<string, unknown>;
        if ((req.headers.authorization ?? '') !== 'Bearer ct_rotated' && state.heartbeatCalls > 0) {
          res.writeHead(401);
          res.end(JSON.stringify({ error: { code: 'AUTH_REQUIRED', message: 'token 过期' } }));
          return;
        }
        state.heartbeatCalls += 1;
        res.writeHead(200);
        res.end(JSON.stringify({
          data: {
            status: 'activated',
            features: ['dorm'],
            expires_at: '2027-10-27T00:00:00Z',
            client_token: state.heartbeatCalls === 1 ? 'ct_rotated' : 'ct_first',
            offline_license: offline,
            server_time: state.serverTime,
          },
        }));
        return;
      }
      if (req.url === '/.well-known/jwks.json') {
        res.writeHead(200);
        res.end(JSON.stringify(jwks));
        return;
      }
      res.writeHead(404);
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

function makeClient(storage?: KvStorage): LicenseClient {
  return new LicenseClient({
    baseUrl,
    productCode: 'dorm-check',
    appVersion: '2.4.1',
    device: { fpType: 'machine_id', fingerprint: 'sdk-fp-1', platform: 'windows' },
    userId: 'student-1001',
    storage: storage ?? memoryStorage(),
    heartbeatIntervalMs: 0,
    offlineVerify: {}, // 从 JWKS 拉取
  });
}

describe('LicenseClient (stub server)', () => {
  it('activate stores token/offline license and computes entitlement from server', async () => {
    const client = makeClient();
    const ent = await client.activate('DORM-0000-0000-0000-0000-0');
    expect(ent.valid).toBe(true);
    expect(ent.features).toEqual(['dorm']);
    expect(ent.source).toBe('offline'); // 无最近服务端结果, 由离线许可判定
    expect(state.lastActivateBody).toMatchObject({
      device: {
        fp_type: 'machine_id',
        fingerprint: 'sdk-fp-1',
        platform: 'windows',
      },
      context: { user_id: 'student-1001' },
    });
  });

  it('heartbeat follows token rotation; entitlement stays valid', async () => {
    const storage = memoryStorage();
    const client = makeClient(storage);
    await client.activate('DORM-0000-0000-0000-0000-0');
    const ent = await client.heartbeat();
    expect(ent.valid).toBe(true);
    // 轮换后的 token 用于下一次心跳(stub 校验 Bearer ct_rotated)
    await client.heartbeat();
    expect(state.heartbeatCalls).toBeGreaterThanOrEqual(2);
    expect(state.lastHeartbeatBody).toMatchObject({
      context: { user_id: 'student-1001' },
    });
    void storage;
  });

  it('clock rollback beyond tolerance invalidates offline entitlement', async () => {
    const storage = memoryStorage();
    const client = makeClient(storage);
    await client.activate('DORM-0000-0000-0000-0000-0');
    // 模拟设备时钟被回拨 25h: 见过的最大服务端时间在"未来"
    storage.set('lp_max_server_time', String(Math.floor(Date.now() / 1000) + 25 * 3600));
    const ent = await client.entitlement();
    expect(ent.valid).toBe(false);
    expect(ent.reason).toBe('CLOCK_ROLLBACK');
  });

  it('webhook helper verifies platform-signed deliveries', async () => {
    // 平台 dispatcher 的签名算法与 SDK 验签互为镜像(端到端契约)
    const secret = 'whsec_shared';
    const body = JSON.stringify({ event_id: 'e9', type: 'license.revoked' });
    const t = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', secret).update(`${t}.${body}`, 'utf8').digest('hex');
    expect(verifyWebhookSignature(secret, body, `t=${t},v1=${sig}`)).toEqual({ valid: true });
  });
});
