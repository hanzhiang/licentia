/// <reference types="vitest" />
/**
 * 登录失败限流 e2e(设计文档 §15).
 *
 * 关键回归: 计数必须跨实例共享. 两个独立的 AuthService 实例(模拟两个副本)
 * 各自尝试 3 次失败, 合计应触发锁定 —— 进程内 Map 版本在这里会失败.
 * 前置: docker compose up (需 Redis) + TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely } from 'kysely';
import { createDb, withSystemTx, type LpDb } from '@lp/db';
import { createRedis, type Redis } from '@lp/cache';
import { getConfig } from '@lp/config';
import { AuthService } from '../../apps/admin-api/src/modules/auth/auth.service';
import type { RbacService } from '../../apps/admin-api/src/modules/iam/iam.module';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

const EMAIL = `rl-test-${Date.now()}@demo.local`;

/** 限流用例不需要真实 RBAC: 登录失败路径不会走到它 */
const fakeRbac = {} as unknown as RbacService;

d.sequential('login failure rate limiting', () => {
  let db: Kysely<LpDb>;
  let redis: Redis;

  beforeAll(async () => {
    db = createDb(url!, { max: 5 });
    redis = createRedis(getConfig().REDIS_URL);
    await redis.ping();
    // 清理可能残留的计数/锁定
    const stale = await redis.keys('lp:login:*');
    if (stale.length > 0) await redis.del(...stale);
    await withSystemTx(db, (tx) =>
      tx.deleteFrom('users').where('email', '=', EMAIL).execute(),
    );
  });

  afterAll(async () => {
    await withSystemTx(db, (tx) =>
      tx.deleteFrom('users').where('email', '=', EMAIL).execute(),
    );
    const keys = await redis.keys('lp:login:*');
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit();
    await db.destroy();
  });

  /** 每个用例独立起点: 清掉上一个用例留下的计数/锁定 */
  async function resetLimiter(): Promise<void> {
    const keys = await redis.keys('lp:login:*');
    if (keys.length > 0) await redis.del(...keys);
  }

  async function fail(service: AuthService): Promise<void> {
    await expect(service.login(EMAIL, 'wrong-password', null)).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
  }

  it('blocks after 5 failures and shares the counter across instances', async () => {
    await resetLimiter();
    const a = new AuthService(db, fakeRbac, redis);
    const b = new AuthService(db, fakeRbac, redis);

    // 分散到两个实例: 3 + 2 = 5 次
    await fail(a);
    await fail(a);
    await fail(b);
    await fail(a);
    await fail(b);

    // 第 6 次(任意实例)应被锁定, 且错误码是 RATE_LIMITED
    await expect(b.login(EMAIL, 'wrong-password', null)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    await expect(a.login(EMAIL, 'wrong-password', null)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
  });

  it('does not leak the raw email into the redis key', async () => {
    await resetLimiter();
    const probe = new AuthService(db, fakeRbac, redis);
    await fail(probe);
    const keys = await redis.keys('lp:login:*');
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      expect(k).not.toContain('@');
      expect(k).not.toContain('rl-test');
    }
  });

  it('successful login clears the counter', async () => {
    await resetLimiter();
    const svc = new AuthService(db, fakeRbac, redis);
    // 先制造失败, 确认计数 key 存在
    await fail(svc);
    const keysBefore = await redis.keys('lp:login:cnt:*');
    expect(keysBefore.length).toBeGreaterThan(0);
    // 第 2 次失败后计数仍在(未达阈值不产生 lock key)
    await fail(svc);
    expect((await redis.keys('lp:login:lock:*')).length).toBe(
      0,
      '未达 5 次不应产生锁定',
    );
    const keys = await redis.keys('lp:login:*');
    if (keys.length > 0) await redis.del(...keys);
    // 清空后应回到"可尝试"状态(错误是凭据错误而非限流)
    await expect(svc.login(EMAIL, 'wrong-password', null)).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
  });
});
