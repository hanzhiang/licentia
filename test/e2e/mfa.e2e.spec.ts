/// <reference types="vitest" />
/**
 * 两步验证 e2e: 绑定 → 登录分两步 → 验证码/恢复码 → 关闭。
 * 前置: TEST_DATABASE_URL(Redis 可选, 限流相关用例会退化到进程内计数)。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely } from 'kysely';
import { createDb, uuidv7, withSystemTx, type LpDb } from '@lp/db';
import { createRedis, type Redis } from '@lp/cache';
import { getConfig } from '@lp/config';
import { hashPassword, totpCode } from '@lp/auth';
import { AuthService } from '../../apps/admin-api/src/modules/auth/auth.service';
import { RbacService } from '../../apps/admin-api/src/iam/iam.module';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

const TENANT = '11111111-1111-4111-8111-111111111111';
const PASSWORD = 'MfaTesting-2026!x';
const suffix = Date.now().toString(36);
const EMAIL = `mfa-${suffix}@example.com`;

d.sequential('two-factor authentication', () => {
  let db: Kysely<LpDb>;
  let redis: Redis | null = null;
  let svc: AuthService;
  let userId = '';

  beforeAll(async () => {
    db = createDb(url!, { max: 5 });
    try {
      redis = createRedis(getConfig().REDIS_URL);
      await redis.ping();
    } catch {
      redis = null;
    }
    svc = new AuthService(db, new RbacService(db, redis), redis);

    userId = uuidv7();
    await withSystemTx(db, async (tx) => {
      await tx
        .insertInto('users')
        .values({
          id: userId,
          tenant_id: TENANT,
          email: EMAIL,
          phone_hash: null,
          password_hash: hashPassword(PASSWORD),
          status: 'active',
          last_login_at: null,
          email_verified_at: new Date(),
          channel_id: null,
          mfa_secret_enc: null,
          mfa_enabled: false,
          created_at: new Date(),
          updated_at: new Date(),
          deleted_at: null,
        })
        .execute();
      await tx
        .insertInto('user_roles')
        .values({ user_id: userId, role_code: 'developer_owner' })
        .execute();
    });
  });

  afterAll(async () => {
    await withSystemTx(db, async (tx) => {
      await tx.deleteFrom('mfa_recovery_codes').where('user_id', '=', userId).execute();
      await tx.deleteFrom('refresh_tokens').where('user_id', '=', userId).execute();
      await tx.deleteFrom('user_roles').where('user_id', '=', userId).execute();
      await tx.deleteFrom('audit_events').where('actor_id', '=', userId).execute();
      await tx.deleteFrom('users').where('id', '=', userId).execute();
    });
    await db.destroy();
  });

  let secret = '';
  let recoveryCodes: string[] = [];

  it('issues a normal session before MFA is enabled', async () => {
    const res = await svc.login(EMAIL, PASSWORD, null);
    expect('access_token' in res).toBe(true);
  });

  it('generates a secret that is not active until confirmed', async () => {
    const setup = await svc.mfaSetup(userId);
    secret = setup.secret;
    expect(setup.secret).toMatch(/^[A-Z2-7]{16,}$/);
    expect(setup.otpauth_url).toContain(`secret=${setup.secret}`);

    const row = await withSystemTx(db, (tx) =>
      tx.selectFrom('users').select(['mfa_enabled']).where('id', '=', userId).executeTakeFirstOrThrow(),
    );
    expect(row.mfa_enabled).toBe(false);
    // 密钥落库必须是密文, 不能是明文
    const enc = await withSystemTx(db, (tx) =>
      tx.selectFrom('users').select(['mfa_secret_enc']).where('id', '=', userId).executeTakeFirstOrThrow(),
    );
    expect(enc.mfa_secret_enc!.toString('utf8')).not.toContain(setup.secret);
  });

  it('rejects a wrong confirmation code', async () => {
    await expect(svc.mfaActivate(userId, '000000', null)).rejects.toThrow(/验证码不正确/);
  });

  it('enables MFA and hands out recovery codes exactly once', async () => {
    const res = await svc.mfaActivate(userId, totpCode(secret), null);
    recoveryCodes = res.recovery_codes;
    expect(res.recovery_codes).toHaveLength(10);
    expect(res.recovery_codes[0]).toMatch(/^[0-9A-F]{5}-[0-9A-F]{5}$/);

    const stored = await withSystemTx(db, (tx) =>
      tx
        .selectFrom('mfa_recovery_codes')
        .select(['code_hash'])
        .where('user_id', '=', userId)
        .execute(),
    );
    expect(stored).toHaveLength(10);
    // 库里只有哈希, 且存不进明文
    expect(stored.some((s) => s.code_hash.toString('utf8').includes(res.recovery_codes[0]!))).toBe(
      false,
    );
  });

  it('requires a second step at login once enabled', async () => {
    const res = await svc.login(EMAIL, PASSWORD, null);
    expect('access_token' in res).toBe(false);
    expect('mfa_required' in res && res.mfa_required).toBe(true);
  });

  it('rejects a wrong code and accepts the right one', async () => {
    const login = await svc.login(EMAIL, PASSWORD, null);
    if (!('mfa_required' in login)) throw new Error('expected challenge');
    const challenge = login.challenge_token;

    await expect(svc.mfaVerify(challenge, '123456', null)).rejects.toThrow(/验证码不正确/);
    const session = await svc.mfaVerify(challenge, totpCode(secret), null);
    expect(session.access_token).toBeTruthy();
    expect(session.user.id).toBe(userId);
  });

  it('refuses to trade an access token for a second-step session', async () => {
    const first = await svc.login(EMAIL, PASSWORD, null);
    if (!('mfa_required' in first)) throw new Error('expected challenge');
    const session = await svc.mfaVerify(first.challenge_token, totpCode(secret), null);

    await expect(svc.mfaVerify(session.access_token, totpCode(secret), null)).rejects.toThrow(
      /验证已过期/,
    );
  });

  it('accepts a recovery code once, then refuses to reuse it', async () => {
    const login = await svc.login(EMAIL, PASSWORD, null);
    if (!('mfa_required' in login)) throw new Error('expected challenge');

    const code = recoveryCodes[0]!;
    const session = await svc.mfaVerify(login.challenge_token, code, null);
    expect(session.access_token).toBeTruthy();

    // 同一枚恢复码第二次使用必须失败(而且会被计入失败次数)
    const second = await svc.login(EMAIL, PASSWORD, null);
    if (!('mfa_required' in second)) throw new Error('expected challenge');
    await expect(svc.mfaVerify(second.challenge_token, code, null)).rejects.toThrow(/验证码不正确/);
  });

  it('can be disabled with a valid code', async () => {
    await svc.mfaDisable(userId, totpCode(secret), null);
    const row = await withSystemTx(db, (tx) =>
      tx
        .selectFrom('users')
        .select(['mfa_enabled', 'mfa_secret_enc'])
        .where('id', '=', userId)
        .executeTakeFirstOrThrow(),
    );
    expect(row.mfa_enabled).toBe(false);
    expect(row.mfa_secret_enc).toBeNull();

    const res = await svc.login(EMAIL, PASSWORD, null);
    expect('access_token' in res).toBe(true);
  });
});
