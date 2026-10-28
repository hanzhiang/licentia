/// <reference types="vitest" />
/**
 * 开发者注册安全 e2e: 邮箱验证门禁 + 验证码防护 + 注册限流。
 * 前置: TEST_DATABASE_URL + Redis(未启动时限流用例自动跳过)。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely } from 'kysely';
import { createDb, withSystemTx, type LpDb } from '@lp/db';
import { createRedis, type Redis } from '@lp/cache';
import { getConfig } from '@lp/config';
import { AuthService } from '../../apps/admin-api/src/modules/auth/auth.service';
import { RbacService } from '../../apps/admin-api/src/iam/iam.module';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

const PASSWORD = 'RegisterPassw0rd!';

d.sequential('developer registration security', () => {
  let db: Kysely<LpDb>;
  let redis: Redis | null = null;
  let svc: AuthService;
  const created: string[] = [];

  beforeAll(async () => {
    db = createDb(url!, { max: 5 });
    try {
      redis = createRedis(getConfig().REDIS_URL);
      await redis.ping();
    } catch {
      redis = null;
    }
    const rbac = new RbacService(db, redis);
    svc = new AuthService(db, rbac, redis);
  });

  afterAll(async () => {
    for (const email of created) {
      const ids = await withSystemTx(db, (tx) =>
        tx.selectFrom('users').select(['id', 'tenant_id']).where('email', '=', email).execute(),
      );
      for (const u of ids) {
        await withSystemTx(db, async (tx) => {
          await tx.deleteFrom('refresh_tokens').where('user_id', '=', u.id).execute();
          await tx.deleteFrom('user_roles').where('user_id', '=', u.id).execute();
          await tx.deleteFrom('users').where('id', '=', u.id).execute();
          if (u.tenant_id) await tx.deleteFrom('tenants').where('id', '=', u.tenant_id).execute();
        });
      }
      if (redis) {
        const keys = await redis.keys('lp:reg:*');
        if (keys.length > 0) await redis.del(...keys);
      }
    }
    if (redis) await redis.quit();
    await db.destroy();
  });

  function freshEmail(tag: string): string {
    const email = `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    created.push(email);
    return email;
  }

  it('creates an unverified account and refuses login until verified', async () => {
    const email = freshEmail('verify');
    const reg = await svc.register(
      { email, password: PASSWORD, developerName: '验证测试' },
      '10.0.0.1',
    );
    expect(reg.requires_verification).toBe(true);
    expect(reg.dev_code).toMatch(/^\d{6}$/);

    await expect(svc.login(email, PASSWORD, '10.0.0.1')).rejects.toMatchObject({
      code: 'EMAIL_NOT_VERIFIED',
    });

    const session = await svc.verifyEmail(email, reg.dev_code!, '10.0.0.1');
    expect(session.user.actor_type).toBe('developer_owner');
    expect(session.user.permissions).toContain('license:issue');

    // 验证后可以正常登录
    const after = await svc.login(email, PASSWORD, '10.0.0.1');
    expect(after.user.tenant_id).toBe(session.user.tenant_id);
  }, 60000);

  it('rejects a reused verification code', async () => {
    const email = freshEmail('reuse');
    const reg = await svc.register(
      { email, password: PASSWORD, developerName: '复用测试' },
      '10.0.0.2',
    );
    await svc.verifyEmail(email, reg.dev_code!, '10.0.0.2');
    await expect(svc.verifyEmail(email, reg.dev_code!, '10.0.0.2')).rejects.toMatchObject({
      code: 'VERIFY_CODE_INVALID',
    });
  }, 60000);

  it('burns the code after 5 wrong attempts', async () => {
    const email = freshEmail('brute');
    const reg = await svc.register(
      { email, password: PASSWORD, developerName: '爆破测试' },
      '10.0.0.3',
    );
    const good = reg.dev_code!;
    for (let i = 1; i <= 5; i++) {
      const wrong = String((Number(good) + i) % 1_000_000).padStart(6, '0');
      await expect(svc.verifyEmail(email, wrong, '10.0.0.3')).rejects.toMatchObject({
        code: 'VERIFY_CODE_INVALID',
      });
    }
    // 码已作废: 正确码也不再通过
    await expect(svc.verifyEmail(email, good, '10.0.0.3')).rejects.toMatchObject({
      code: 'VERIFY_CODE_INVALID',
    });
  }, 60000);

  it('limits registrations per IP', async () => {
    if (!redis) return; // 无 Redis 时用例跳过
    const ip = `10.9.9.${Math.floor(Math.random() * 200) + 1}`;
    for (let i = 0; i < 5; i++) {
      const email = freshEmail(`rl${i}`);
      await svc.register({ email, password: PASSWORD, developerName: `限流${i}` }, ip);
    }
    const email = freshEmail('rl-over');
    await expect(
      svc.register({ email, password: PASSWORD, developerName: '超限' }, ip),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  }, 120000);

  it('does not leak whether an email exists via resend', async () => {
    const unknown = 'definitely-not-registered@example.com';
    await expect(svc.resendVerification(unknown)).resolves.toMatchObject({ sent: true });
  });
});
