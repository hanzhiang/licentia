import { Inject, Injectable, Optional } from '@nestjs/common';
import crypto from 'node:crypto';
import { Kysely } from 'kysely';
import { AppError } from '@lp/domain';
import { uuidv7, withSystemTx, type LpDb } from '@lp/db';
import { hashPassword, signJwt, verifyPassword } from '@lp/auth';
import { writeAudit } from '@lp/audit';
import { getConfig } from '@lp/config';
import { buildChannels } from '@lp/notify';
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

// 注册限流: 同一 IP 每小时最多 5 次, 同一邮箱每小时最多 3 次
const REG_IP_LIMIT = 5;
const REG_EMAIL_LIMIT = 3;
const REG_WINDOW_S = 3600;
/** 验证码有效期 */
const VERIFY_TTL_S = 900;
/** 重发验证码冷却 */
const RESEND_COOLDOWN_S = 60;
/** 同一验证码最多试错次数, 防暴力猜码 */
const VERIFY_MAX_ATTEMPTS = 5;
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
export interface RegisterResult {
  email: string;
  requires_verification: true;
  /** 仅在非生产环境返回, 便于本地/演示环境自测 */
  dev_code?: string;
}

@Injectable()
export class AuthService {
  /** Redis 不可用时的兜底(仅单副本有意义) */
  private readonly localLocks = new Map<string, { fails: number; until: number }>();
  /** 注册限流的进程内兜底: key → 窗口起点与计数 */
  private readonly localReg = new Map<string, { start: number; count: number }>();

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

  /**
   * 平台停用某个开发者账号后，该租户下所有成员都不能再登录/刷新。
   * 平台账号(tenant_id 为空)不受影响。
   */
  private async assertTenantActive(tenantId: string | null): Promise<void> {
    if (!tenantId) return;
    const tenant = await withSystemTx(this.db, (tx) =>
      tx.selectFrom('tenants').select(['status']).where('id', '=', tenantId).executeTakeFirst(),
    );
    if (tenant && tenant.status !== 'active') {
      throw new AppError('TENANT_SUSPENDED', '该开发者账号已被平台停用');
    }
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
        .select(['id', 'tenant_id', 'email', 'status', 'password_hash', 'email_verified_at'])
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
    if (!user.email_verified_at) {
      throw new AppError('EMAIL_NOT_VERIFIED', '邮箱尚未验证, 请先完成验证或重发验证码');
    }
    await this.clearFailures(email);
    await this.assertTenantActive(user.tenant_id);

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

  /**
   * 开发者自助注册: 创建 租户 + 账号 + developer_owner，并发一封验证码邮件。
   *
   * 账号在邮箱验证前不能登录 —— 否则脚本可以批量刷出大量「能用的空租户」。
   * 限流落在 Redis(跨副本共享)，Redis 不可用时退化为进程内计数。
   */
  async register(
    input: { email: string; password: string; developerName: string },
    ip: string | null,
  ): Promise<RegisterResult> {
    const email = input.email.trim().toLowerCase();
    const name = input.developerName.trim();

    await this.enforceRegisterLimit(email, ip);

    const existing = await withSystemTx(this.db, (tx) =>
      tx.selectFrom('users').select('id').where('email', '=', email).executeTakeFirst(),
    );
    if (existing) throw new AppError('EMAIL_TAKEN', '该邮箱已注册');

    const tenantId = uuidv7();
    const userId = uuidv7();
    const tenantCode = buildTenantCode(name);
    const passwordHash = hashPassword(input.password);

    await withSystemTx(this.db, async (tx) => {
      await tx
        .insertInto('tenants')
        .values({
          id: tenantId,
          code: tenantCode,
          name,
          status: 'active',
          plan: 'standard',
          settings: {},
          created_at: new Date(),
          updated_at: new Date(),
          deleted_at: null,
        })
        .execute();
      await tx
        .insertInto('users')
        .values({
          id: userId,
          tenant_id: tenantId,
          email,
          phone_hash: null,
          password_hash: passwordHash,
          status: 'active',
          last_login_at: null,
          email_verified_at: null,
          created_at: new Date(),
          updated_at: new Date(),
          deleted_at: null,
        })
        .execute();
      await tx
        .insertInto('user_roles')
        .values({ user_id: userId, role_code: 'developer_owner' })
        .execute();
      await writeAudit(tx, {
        tenantId,
        actorType: 'developer_owner',
        actorId: userId,
        action: 'auth.register',
        resourceType: 'tenant',
        resourceId: tenantId,
        detail: { email, developer_name: name, tenant_code: tenantCode, verified: false },
        ip,
      });
    });

    const code = await this.issueVerifyCode(email);
    const dev = getConfig().NODE_ENV !== 'prod';
    return { email, requires_verification: true, ...(dev ? { dev_code: code } : {}) };
  }

  /** 校验验证码并激活账号; 成功后直接返回会话, 用户无需再登一次 */
  async verifyEmail(emailInput: string, code: string, ip: string | null): Promise<LoginResult> {
    const email = emailInput.trim().toLowerCase();
    const tag = this.emailTag(email);
    const key = `lp:reg:code:${tag}`;

    const stored = this.redis ? await this.redis.get(key).catch(() => null) : null;
    if (stored === null) throw new AppError('VERIFY_CODE_INVALID', '验证码错误或已过期');

    if (stored !== code) {
      // 记录试错次数, 超过上限直接作废验证码, 避免 6 位码被穷举
      const tryKey = `lp:reg:try:${tag}`;
      const attempts = this.redis ? await this.redis.incr(tryKey).catch(() => 99) : 99;
      if (attempts === 1 && this.redis) await this.redis.expire(tryKey, VERIFY_TTL_S);
      if (attempts >= VERIFY_MAX_ATTEMPTS && this.redis) {
        await this.redis.del(key).catch(() => undefined);
        await this.redis.del(tryKey).catch(() => undefined);
      }
      throw new AppError('VERIFY_CODE_INVALID', '验证码错误或已过期');
    }

    const user = await withSystemTx(this.db, (tx) =>
      tx
        .selectFrom('users')
        .select(['id', 'tenant_id', 'email', 'status', 'email_verified_at'])
        .where('email', '=', email)
        .orderBy('created_at')
        .executeTakeFirst(),
    );
    if (!user) throw new AppError('VERIFY_CODE_INVALID', '验证码错误或已过期');
    if (user.status !== 'active') throw new AppError('AUTH_REQUIRED', '账号已停用');

    await withSystemTx(this.db, async (tx) => {
      await tx
        .updateTable('users')
        .set({ email_verified_at: new Date(), updated_at: new Date() })
        .where('id', '=', user.id)
        .execute();
      await writeAudit(tx, {
        tenantId: user.tenant_id,
        actorType: 'developer_owner',
        actorId: user.id,
        action: 'auth.email_verified',
        resourceType: 'user',
        resourceId: user.id,
        detail: { email },
        ip,
      });
    });

    if (this.redis) {
      await this.redis.del(key).catch(() => undefined);
      await this.redis.del(`lp:reg:try:${tag}`).catch(() => undefined);
    }

    const roles = await this.rbac.rolesOf(user.id);
    const permissions = await this.rbac.permsOf(user.id);
    return this.issueSession(
      { id: user.id, email: user.email, tenant_id: user.tenant_id },
      roles,
      permissions,
      primaryActorType(roles),
      ip,
      'auth.login',
    );
  }

  /** 重发验证码: 60 秒冷却, 避免把注册接口当成邮件轰炸机 */
  async resendVerification(emailInput: string): Promise<{ sent: true; dev_code?: string }> {
    const email = emailInput.trim().toLowerCase();
    const tag = this.emailTag(email);
    if (this.redis) {
      const ok = await this.redis
        .set(`lp:reg:cd:${tag}`, '1', 'EX', RESEND_COOLDOWN_S, 'NX')
        .catch(() => 'OK');
      if (!ok) throw new AppError('RATE_LIMITED', '请求过于频繁, 请稍后再试');
    }
    const user = await withSystemTx(this.db, (tx) =>
      tx
        .selectFrom('users')
        .select(['id', 'email_verified_at', 'status'])
        .where('email', '=', email)
        .executeTakeFirst(),
    );
    // 不区分「账号不存在」与「已激活」, 避免用这个接口枚举邮箱
    if (!user || user.status !== 'active' || user.email_verified_at) {
      return { sent: true };
    }
    const code = await this.issueVerifyCode(email);
    const dev = getConfig().NODE_ENV !== 'prod';
    return { sent: true, ...(dev ? { dev_code: code } : {}) };
  }

  /** 注册限流: IP 与邮箱两条独立计数, 任一超限即拒绝 */
  private async enforceRegisterLimit(email: string, ip: string | null): Promise<void> {
    const pairs: Array<[string, number]> = [
      [`lp:reg:ip:${this.emailTag(ip ?? 'unknown')}`, REG_IP_LIMIT],
      [`lp:reg:email:${this.emailTag(email)}`, REG_EMAIL_LIMIT],
    ];
    if (this.redis) {
      try {
        for (const [key, limit] of pairs) {
          const n = await this.redis.incr(key);
          if (n === 1) await this.redis.expire(key, REG_WINDOW_S);
          if (n > limit) throw new AppError('RATE_LIMITED', '注册过于频繁, 请稍后再试');
        }
        return;
      } catch (e) {
        if (e instanceof AppError) throw e;
        console.warn('[auth] Redis 注册限流不可用, 降级为进程内计数:', (e as Error).message);
      }
    }
    const now = Date.now();
    for (const [key, limit] of pairs) {
      const rec = this.localReg.get(key);
      if (!rec || now - rec.start > REG_WINDOW_S * 1000) {
        this.localReg.set(key, { start: now, count: 1 });
        continue;
      }
      rec.count += 1;
      if (rec.count > limit) throw new AppError('RATE_LIMITED', '注册过于频繁, 请稍后再试');
    }
  }

  /** 生成并发送验证码(无邮件通道时只写日志, 非生产环境随响应下发) */
  private async issueVerifyCode(email: string): Promise<string> {
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    const tag = this.emailTag(email);
    if (this.redis) {
      await this.redis.set(`lp:reg:code:${tag}`, code, 'EX', VERIFY_TTL_S).catch(() => undefined);
      await this.redis.del(`lp:reg:try:${tag}`).catch(() => undefined);
    }
    const channel = buildChannels().email;
    if (channel) {
      await channel
        .send(
          { to: email },
          {
            subject: '【Licentia】开发者账号邮箱验证',
            text: [
              '你好，',
              '',
              `你的验证码是 ${code}，15 分钟内有效。`,
              '若这不是你本人的操作，请忽略本邮件。',
            ].join('\n'),
          },
        )
        .catch(() => undefined);
    } else {
      console.warn(`[auth] 未配置邮件通道, 验证码未发送: ${email}`);
    }
    return code;
  }

  /** 签发会话(access + refresh), verifyEmail 验证通过后复用 */
  private async issueSession(
    user: { id: string; email: string; tenant_id: string | null },
    roles: string[],
    permissions: string[],
    actorType: string,
    ip: string | null,
    action: string,
  ): Promise<LoginResult> {
    const cfg = getConfig();
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
        actorType: actorType as 'developer_owner',
        actorId: user.id,
        action,
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
    if (!user.email_verified_at) {
      throw new AppError('EMAIL_NOT_VERIFIED', '邮箱尚未验证');
    }
    await this.assertTenantActive(user.tenant_id);
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

/**
 * 租户码: 从开发者名提取 ASCII 字母数字作为可读前缀，再拼随机后缀保证唯一。
 * 中文名会被提取为空，此时回落 'dev'。
 */
function buildTenantCode(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 20);
  const suffix = crypto.randomBytes(4).toString('hex');
  return `${slug || 'dev'}-${suffix}`;
}
