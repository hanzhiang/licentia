/// <reference types="vitest" />
/**
 * 自助门户 e2e(设计文档 场景2/3): OTP 登录 → 组织许可激活 → 设备绑定 → 自助换机(月配额) → 解绑即踢.
 * 前置: docker compose up + pnpm db:migrate, TEST_DATABASE_URL 已设.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely } from 'kysely';
import { createDb, withSystemTx, type LpDb } from '@lp/db';
import { createRedis, type Redis } from '@lp/cache';
import { getConfig, resetConfigForTest } from '@lp/config';
import { verifyJwt } from '@lp/auth';
import { hmacCode } from '@lp/keygen';
import { LicenseSigner, LocalSignerProvider } from '@lp/signer';
import { OtpService } from '../../apps/portal-api/src/otp.service';
import { PortalLicenseService } from '../../apps/portal-api/src/license.service';
import { ActivateService } from '../../apps/client-api/src/modules/activate/activate.service';
import { HeartbeatService } from '../../apps/client-api/src/modules/heartbeat/heartbeat.service';
import { BatchService } from '../../apps/admin-api/src/modules/batch/batch.service';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

const TENANT = '11111111-1111-4111-8111-111111111111';
const PRODUCT = '22222222-2222-4222-8222-222222222222';
const POLICY = '33333333-3333-4333-8333-333333333333';
const CHANNEL = '44444444-4444-4444-8444-444444444444';

d.sequential('portal e2e (org license + self-service release)', () => {
  let db: Kysely<LpDb>;
  let redis: Redis;
  let otp: OtpService;
  let portal: PortalLicenseService;
  let activate: ActivateService;
  let heartbeat: HeartbeatService;
  let batch: BatchService;
  let phoneHash1: Buffer;
  let phoneHash2: Buffer;
  let phone1 = '';
  let portalToken: string;
  let code = '';
  let licenseId = '';

  const dev = (n: number) => ({
    fpType: 'machine_id' as const,
    fingerprint: `portal-e2e-fp-${n}`,
    platform: 'windows' as const,
  });

  beforeAll(() => {
    process.env.NODE_ENV = process.env.NODE_ENV ?? 'dev';
    resetConfigForTest();
    db = createDb(url!, { max: 15 });
    redis = createRedis(getConfig().REDIS_URL);
    otp = new OtpService(db, redis);
    portal = new PortalLicenseService(db);
    const signer = new LicenseSigner(new LocalSignerProvider('e2e-kid', 'e2e-seed'));
    activate = new ActivateService(db, signer);
    heartbeat = new HeartbeatService(db, signer);
    batch = new BatchService(db);
    // 动态手机号: 避免命中上一次运行的 OTP 冷却/日限频; beforeAll 与用例必须用同一个号
    const runId = Date.now() % 1_000_000_000;
    phone1 = `138${runId}1`;
    phoneHash1 = hmacCode(getConfig().FINGERPRINT_PEPPER, `phone:${phone1}`);
    phoneHash2 = hmacCode(getConfig().FINGERPRINT_PEPPER, `phone:138${runId}2`);
  });

  afterAll(async () => {
    void redis.quit();
    await db.destroy();
  });

  async function reset(): Promise<void> {
    await withSystemTx(db, async (tx) => {
      for (const t of [
        'idempotency_keys','events','renewals','client_tokens','license_activations',
        'devices','licenses','license_batches','end_customers','notifications_outbox',
      ]) {
        await tx.deleteFrom(t as 'licenses').execute();
      }
    });
  }

  it('otp dev flow issues a portal-scoped token', async () => {
    await reset();
    const req = await otp.requestOtp(phone1, TENANT);
    expect(req.dev_code).toMatch(/^\d{6}$/); // dev 环境 returns code
    const login = await otp.verifyOtp(phone1, req.dev_code!, TENANT);
    portalToken = login.portal_token;
    const claims = verifyJwt(portalToken, {
      keysDir: getConfig().AUTH_JWT_KEYS_DIR,
      kid: getConfig().AUTH_JWT_KID,
    }, ['portal']);
    expect(claims.sub).toBe(phoneHash1.toString('base64url'));
    expect(claims.tid).toBe(TENANT);
    // 验证码一次一用
    await expect(otp.verifyOtp(phone1, req.dev_code!, TENANT)).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
  });

  it('activates an org license; idempotent for same org; 409 for another org', async () => {
    const r = await batch.issue(
      TENANT,
      { product_id: PRODUCT, policy_id: POLICY, channel_id: CHANNEL, quantity: 1 },
      `portal-key-${Date.now()}`,
    );
    code = r.body.data.codes![0]!;

    const first = await portal.activateOrg(TENANT, phoneHash1, code, '第一中学');
    expect(first.status).toBe('activated');
    expect(first.org_name).toBe('第一中学');
    expect(first.replayed).toBe(false);

    const again = await portal.activateOrg(TENANT, phoneHash1, code, '第一中学');
    expect(again.replayed).toBe(true);

    await expect(
      portal.activateOrg(TENANT, phoneHash2, code, '第二中学'),
    ).rejects.toMatchObject({ code: 'LIC_STATUS_INVALID' });

    // 我的许可列表
    const mine = await portal.myLicenses(TENANT, phoneHash1);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.license_id).toBe(first.license_id);
    // 他人看不到(横向越权 → 空列表)
    const others = await portal.myLicenses(TENANT, phoneHash2);
    expect(others).toHaveLength(0);

    licenseId = first.license_id;
  });

  it('binds a device on the org license, portal sees it, release kills its token immediately', async () => {
    const act = await activate.activate({
      code,
      app: { productCode: 'dorm-check', version: '2.4.1' },
      device: dev(1),
    });
    expect(act.license.status).toBe('activated');

    const devices = await portal.licenseDevices(TENANT, phoneHash1, licenseId);
    expect(devices).toHaveLength(1);
    expect(devices[0]!.activation_id).toBeTruthy();

    // 解绑前心跳正常
    const hb = await heartbeat.heartbeat(`Bearer ${act.client_token}`);
    expect(hb.status).toBe('activated');

    // 自助解绑(月配额 1 次的第 1 次)
    const rel = await portal.releaseDevice(
      TENANT,
      phoneHash1,
      devices[0]!.activation_id,
      '换新手机',
    );
    expect(rel.released).toBe(true);

    // 解绑即时踢下线: 同 token 心跳 401
    await expect(heartbeat.heartbeat(`Bearer ${act.client_token}`)).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
  });

  it('self-release monthly quota is enforced (2nd release this month -> 429)', async () => {
    const act2 = await activate.activate({
      code,
      app: { productCode: 'dorm-check', version: '2.4.1' },
      device: dev(2),
    });
    const devices = await portal.licenseDevices(TENANT, phoneHash1, licenseId);
    expect(devices).toHaveLength(1);
    await expect(
      portal.releaseDevice(TENANT, phoneHash1, devices[0]!.activation_id, '再换一次'),
    ).rejects.toMatchObject({ code: 'RELEASE_QUOTA_EXCEEDED' });
    void act2;
  });
});
