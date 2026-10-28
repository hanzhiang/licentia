import { Inject, Injectable, Optional } from '@nestjs/common';
import crypto from 'node:crypto';
import { Kysely } from 'kysely';
import { AppError } from '@lp/domain';
import { uuidv7, withSystemTx, type LpDb } from '@lp/db';
import { signJwt, verifyPassword } from '@lp/auth';
import { writeAudit } from '@lp/audit';
import { getConfig } from '@lp/config';
import type { Redis } from '@lp/cache';
import { DB } from '../../db.module';
import { REDIS } from '../../redis.module';
import { RBAC, RbacService, primaryActorType } from '../../iam/iam.module';

export interface LoginResult {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user: {
    id: string;
    email: string;
    tenant_id: string | null;
    roles: string[];
    actor_type: string;
    permissions: string[];
  };
}

export interface ProfileResult {
  user: LoginResult['user'];
}

const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
/** 失败计数窗口: 超过该时长未再失败则清零 */
const FAIL_WINDOW_S = 15 * 60;

/**
 * 登录/会话(设计文档 §14): scrypt 口令 + RS256 15min access + 7d 可吊销 refresh(轮换).
 *
 * 失败限流(§15): 同邮箱 5 次失败锁 15 分钟.
 * 计数必须放 Redis —— 进程内 Map 在多副本/滚动发布下等于没有防护:
 * 攻击者只要把请求分散到 N 个实例, 每个实例都只见 1/N 的失败次数.
 * Redis 不可用时降级为进程内计数(单副本仍有效), 并打日志提示.
 */
@Injectable()
export class AuthService {
  /** Redis 不可用时的兜底(仅单副本有意义) */
  private readonly localLocks = new Map<string, { fails: number; until: number }>();

  constructor(
    @Inject(DB) private readonly db: Kysely<LpDb>,
    @Inject(RBAC) private readonly rbac: RbacService,
    @Optional() @Inject(REDIS) private readonly redis?: Redis | null,
  ) {}

  /** 邮箱不允许直接出现在 Redis key(日志/监控可见), 用 HMAC 后 base64url */
  private emailTag(email: string): string {
    return crypto
      .createHmac('sha256', getConfig().CODE_HMAC_KEY)
      .update(email.toLowerCase(), 'utf8')
      .digest('base64url');
  }

  /**
   * 两个独立 key:
   *  - cnt: 滑动窗口内的失败次数, 每 15 分钟自然过期
   *  - lock: 达到阈值才创建, 存在即锁定中
   * 合并成一个 key 会把「计数中」误判成「已锁定」.
   */
  private lockKey(email: string): string {
    return `lp:login:lock:${this.emailTag(email)}`;
  }

  private countKey(email: string): string {
    return `lp:login:cnt:${this.emailTag(email)}`;
  }

  /** 返回剩余锁定分钟数; 0 表示未锁定 */
  private async lockedMinutes(email: string): Promise<number> {
    const key = this.lockKey(email);
    if (this.redis) {
      try {
        const ttl = await this.redis.ttl(key);
        if (ttl > 0) return Math.ceil(ttl / 60);
        return 0;
      } catch {
        // 落到本地兜底
      }
    }
    const l = this.localLocks.get(email);
    if (!l || l.until <= Date.now()) return 0;
    return Math.ceil((l.until - Date.now()) / 60_000);
  }

  private async recordFailure(email: string): Promise<void> {
    if (this.redis) {
      try {
        const ck = this.countKey(email);
        const n = await this.redis.incr(ck);
        if (n === 1) await this.redis.expire(ck, FAIL_WINDOW_S);
        if (n >= MAX_FAILS) {
          // 锁定时长从达到阈值这一刻起算
          await this.redis.set(this.lockKey(email), '1', 'EX', Math.ceil(LOCK_MS / 1000));
          await this.redis.del(ck);
        }
        return;
      } catch (e) {
        console.warn('[auth] Redis 限流不可用, 降级为进程内计数:', (e as Error).message);
      }
    }
    const l = this.localLocks.get(email) ?? { fails: 0, until: 0 };
    l.fails += 1;
    if (l.fails >= MAX_FAILS) {
      l.until = Date.now() + LOCK_MS;
      l.fails = 0;
    }
    this.localLocks.set(email, l);
  }

  private async clearFailures(email: string): Promise<void> {
    this.localLocks.delete(email);
    if (this.redis) {
      try {
        await this.redis.del(this.countKey(email));
      } catch {
        /* 清失败计数失败不影响登录成功本身; 锁定 key 只在阈值时存在, 无需清除 */
      }
    }
  }

  private jwtCfg() {
    const cfg = getConfig();
    return { keysDir: cfg.AUTH_JWT_KEYS_DIR, kid: cfg.AUTH_JWT_KID };
  }

  async login(email: string, password: string, ip: string | null): Promise<LoginResult> {
    const cfg = getConfig();
    const lockedFor = await this.lockedMinutes(email);
    if (lockedFor > 0) {
      throw new AppError('RATE_LIMITED', `登录失败次数过多, 请 ${lockedFor} 分钟后再试`);
    }

    const user = await withSystemTx(this.db, (tx) =>
      tx
        .selectFrom('users')
        .select(['id', 'tenant_id', 'email', 'status', 'password_hash'])
        .where('email', '=', email)
        .orderBy('created_at')
        .executeTakeFirst(),
    );
    const passwordOk =
      user !== undefined &&
      user.status === 'active' &&
      user.password_hash !== null &&
      verifyPassword(password, user.password_hash);
    if (user === undefined || !passwordOk) {
      await this.recordFailure(email);
      await this.auditLogin(user?.id ?? email, !!user, ip);
      throw new AppError('AUTH_REQUIRED', '邮箱或密码错误');
    }
    await this.clearFailures(email);

    const roles = await this.rbac.rolesOf(user.id);
    const permissions = await this.rbac.permsOf(user.id);
    const actorType = primaryActorType(roles);
    const accessToken = signJwt(
      { sub: user.id, tid: user.tenant_id, typ: 'access' },
      cfg.AUTH_JWT_TTL_S,
      this.jwtCfg(),
    );
    const refreshToken = crypto.randomBytes(48).toString('base64url');
    await withSystemTx(this.db, async (tx) => {
      await tx
        .insertInto('refresh_tokens')
        .values({
          id: uuidv7(),
          user_id: user.id,
          token_hash: crypto.createHash('sha256').update(refreshToken, 'utf8').digest(),
          expires_at: new Date(Date.now() + cfg.AUTH_REFRESH_TTL_D * 86_400_000),
          revoked_at: null,
          created_at: new Date(),
          ip,
          ua: null,
        })
        .execute();
      await writeAudit(tx, {
        tenantId: user.tenant_id,
        actorType: actorType as 'super_admin',
        actorId: user.id,
        action: 'auth.login',
        resourceType: 'user',
        resourceId: user.id,
        detail: { email: user.email, roles },
        ip,
      });
    });

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: cfg.AUTH_JWT_TTL_S,
      user: {
        id: user.id,
        email: user.email,
        tenant_id: user.tenant_id,
        roles,
        actor_type: actorType,
        permissions,
      },
    };
  }

  async refresh(refreshToken: string, ip: string | null): Promise<LoginResult> {
    const cfg = getConfig();
    const tokenHash = crypto.createHash('sha256').update(refreshToken, 'utf8').digest();
    const row = await withSystemTx(this.db, (tx) =>
      tx
        .selectFrom('refresh_tokens')
        .selectAll()
        .where('token_hash', '=', tokenHash)
        .where('revoked_at', 'is', null)
        .executeTakeFirst(),
    );
    if (!row || row.expires_at.getTime() <= Date.now()) {
      throw new AppError('AUTH_REQUIRED', 'refresh token 无效或已过期');
    }
    const user = await this.rbac.userById(row.user_id);
    if (!user || user.status !== 'active') {
      throw new AppError('AUTH_REQUIRED', '用户已停用');
    }
    const roles = await this.rbac.rolesOf(user.id);
    const permissions = await this.rbac.permsOf(user.id);
    const actorType = primaryActorType(roles);
    const accessToken = signJwt(
      { sub: user.id, tid: user.tenant_id, typ: 'access' },
      cfg.AUTH_JWT_TTL_S,
      this.jwtCfg(),
    );
    const newRefresh = crypto.randomBytes(48).toString('base64url');
    await withSystemTx(this.db, async (tx) => {
      // 轮换: 旧 refresh 立即吊销, 新 refresh 落库
      await tx
        .updateTable('refresh_tokens')
        .set({ revoked_at: new Date() })
        .where('id', '=', row.id)
        .execute();
      await tx
        .insertInto('refresh_tokens')
        .values({
          id: uuidv7(),
          user_id: user.id,
          token_hash: crypto.createHash('sha256').update(newRefresh, 'utf8').digest(),
          expires_at: new Date(Date.now() + cfg.AUTH_REFRESH_TTL_D * 86_400_000),
          revoked_at: null,
          created_at: new Date(),
          ip,
          ua: null,
        })
        .execute();
    });
    return {
      access_token: accessToken,
      refresh_token: newRefresh,
      expires_in: cfg.AUTH_JWT_TTL_S,
      user: {
        id: user.id,
        email: user.email,
        tenant_id: user.tenant_id,
        roles,
        actor_type: actorType,
        permissions,
      },
    };
  }

  async profile(userId: string): Promise<ProfileResult> {
    const user = await this.rbac.userById(userId);
    if (!user || user.status !== 'active') {
      throw new AppError('AUTH_REQUIRED', '用户不存在或已停用');
    }
    const roles = await this.rbac.rolesOf(user.id);
    return {
      user: {
        id: user.id,
        email: user.email,
        tenant_id: user.tenant_id,
        roles,
        actor_type: primaryActorType(roles),
        permissions: await this.rbac.permsOf(user.id),
      },
    };
  }

  async logout(refreshToken: string): Promise<void> {
    const tokenHash = crypto.createHash('sha256').update(refreshToken, 'utf8').digest();
    await withSystemTx(this.db, (tx) =>
      tx
        .updateTable('refresh_tokens')
        .set({ revoked_at: new Date() })
        .where('token_hash', '=', tokenHash)
        .where('revoked_at', 'is', null)
        .execute(),
    );
  }

  private async auditLogin(
    actorId: string,
    userExists: boolean,
    ip: string | null,
  ): Promise<void> {
    await withSystemTx(this.db, (tx) =>
      writeAudit(tx, {
        tenantId: null,
        actorType: 'system',
        actorId,
        action: userExists ? 'auth.login_failed' : 'auth.login_unknown_user',
        resourceType: 'user',
        resourceId: actorId,
        detail: {},
        ip,
      }),
    );
  }
}
