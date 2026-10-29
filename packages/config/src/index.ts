export { log, setServiceName, type LogLevel } from './logger';
import { z } from 'zod';
import fs from 'node:fs';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['dev', 'test', 'prod']).default('dev'),

  // 数据库(宿主机端口 55432, 避开本机常见 5432 占用; 容器内仍是 5432)
  DATABASE_URL: z.string().default('postgresql://lp_app:lp@localhost:55432/lp'),
  MIGRATE_DATABASE_URL: z.string().default('postgresql://postgres:lp@localhost:55432/lp'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  MIGRATIONS_DIR: z.string().default('db/migrations'),
  STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),

  // 码与加密
  CODE_HMAC_KEY: z.string().min(8).default('dev-code-hmac-key-change-me'),
  FINGERPRINT_PEPPER: z.string().min(8).default('dev-fp-pepper'),
  CODE_ENC_KEY: z.string().min(8).default('dev-code-enc-key-change-me'),

  // 签名(双 kid 轮换窗口, 设计文档 §10.2: active 签发, previous 仅验签 60 天)
  SIGNER_PROVIDER: z.enum(['local', 'vault']).default('local'),
  SIGNER_LOCAL_SEED: z.string().min(8).default('dev-signer-seed-change-me'),
  SIGNER_ACTIVE_KID: z.string().min(1).default('dev-2026-01'),
  SIGNER_PREVIOUS_KID: z.string().min(1).nullish(),
  SIGNER_LOCAL_SEED_PREVIOUS: z.string().min(8).nullish(),
  VAULT_TRANSIT_KEY_PREVIOUS: z.string().min(1).nullish(),

  // 管理 JWT(RS256 密钥目录, 首次启动自动生成; 生产换 KMS/Vault)
  AUTH_JWT_KEYS_DIR: z.string().default('./data/keys'),
  AUTH_JWT_KID: z.string().default('jwt-1'),
  AUTH_JWT_TTL_S: z.coerce.number().int().positive().default(900),
  AUTH_REFRESH_TTL_D: z.coerce.number().int().positive().default(7),

  // Webhook 签名密钥的加密密钥
  WEBHOOK_ENC_KEY: z.string().min(8).default('dev-webhook-enc-key-change-me'),

  // 通知通道(邮件/短信). 未配置真实网关默认置 blocked, 绝不假装已发.
  // 仅 dev/test 未显式设置时回落到控制台出口, 便于本地跑通状态机; prod 必须显式开启.
  NOTIFY_ADDR_ENC_KEY: z.string().min(8).default('dev-notify-addr-enc-key-change-me'),
  NOTIFY_CONSOLE_FALLBACK: z
    .string()
    .nullish()
    .transform((v) => {
      if (v === undefined || v === null || v === '') return process.env.NODE_ENV === 'prod' ? false : true;
      return v === 'true' || v === '1';
    }),
  SMTP_HOST: z.string().nullish(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().nullish(),
  SMTP_PASS: z.string().nullish(),
  SMTP_FROM: z.string().default('no-reply@license-platform.local'),
  /** 'starttls'(587, 默认) | 'implicit'(465) */
  SMTP_TLS_MODE: z.enum(['starttls', 'implicit']).default('starttls'),
  SMS_GATEWAY_URL: z.string().url().nullish(),
  SMS_GATEWAY_TOKEN: z.string().nullish(),
  /**
   * /metrics 抓取令牌. 配置后必须带 Authorization: Bearer <token>;
   * 生产环境不配则端点直接 404, 不对外泄露请求量.
   */
  METRICS_TOKEN: z.string().default(''),
  /** TOTP 密钥的加密密钥(与其它字段分开, 便于单独轮换) */
  MFA_SECRET_ENC_KEY: z.string().min(8).default('dev-mfa-secret-enc-key-change-me'),

  // Vault(签名适配器 + 生产密钥托管, 设计文档 §10.1)
  VAULT_ADDR: z.string().default('http://localhost:8200'),
  VAULT_TOKEN: z.string().default('lp-root'),
  VAULT_TRANSIT_KEY: z.string().default('license-dev'),

  // 自助门户
  PORTAL_DEV_TENANT_ID: z.string().uuid().default('11111111-1111-4111-8111-111111111111'),
  PORTAL_TOKEN_TTL_H: z.coerce.number().int().min(1).max(72).default(12),
  PORTAL_SELF_RELEASE_MONTHLY: z.coerce.number().int().min(0).max(10).default(1),

  // 授权默认值
  OFFLINE_DEFAULT_WINDOW_DAYS: z.coerce.number().int().min(0).max(90).default(7),
  HEARTBEAT_DEFAULT_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  CLIENT_TOKEN_TTL_HOURS: z.coerce.number().int().min(1).default(24),
  CLIENT_TOKEN_OVERLAP_MIN: z.coerce.number().int().min(0).default(5),

  // 发码
  BATCH_SYNC_THRESHOLD: z.coerce.number().int().positive().default(10000),
  BATCH_CHUNK_SIZE: z.coerce.number().int().positive().default(2000),
  BATCH_MAX_QUANTITY: z.coerce.number().int().positive().default(100000),
  EXPORT_DIR: z.string().default('./data/exports'),

  // 骨架期认证(P2 换真实 JWT/RBAC/API Key)
  ADMIN_DEV_TOKEN: z.string().default('dev-admin-token'),
  ADMIN_DEV_TENANT_ID: z.string().uuid().default('11111111-1111-4111-8111-111111111111'),
  OPEN_DEV_API_KEY: z.string().default('lpk_dev_demo'),
  OPEN_DEV_TENANT_ID: z.string().uuid().default('11111111-1111-4111-8111-111111111111'),

  // 校验缓存(进程内, P3 换 Redis)
  VALIDATE_CACHE_TTL_S: z.coerce.number().int().positive().default(60),

  // 端口/日志
  PORT_ADMIN: z.coerce.number().int().default(3001),
  PORT_CLIENT: z.coerce.number().int().default(3002),
  PORT_OPEN: z.coerce.number().int().default(3003),
  PORT_PORTAL: z.coerce.number().int().default(3004),
  PORT_WORKER: z.coerce.number().int().default(3005),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type AppConfig = z.infer<typeof EnvSchema>;

let cached: AppConfig | undefined;

/** 读取并校验环境变量; 进程内单例. 启动即失败(fail-fast). */
export function getConfig(): AppConfig {
  if (cached) return cached;
  loadDotEnvIfPresent();
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`invalid environment config: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** 供测试重置单例 */
export function resetConfigForTest(): void {
  cached = undefined;
}

function loadDotEnvIfPresent(): void {
  try {
    if (!fs.existsSync('.env')) return;
    const lines = fs.readFileSync('.env', 'utf8').split(/\r?\n/);
    for (const line of lines) {
      if (line.trim().startsWith('#')) continue;
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      if (process.env[m[1]] !== undefined) continue;
      let v = m[2];
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      process.env[m[1]] = v;
    }
  } catch {
    // .env 读取失败不阻断(环境变量优先)
  }
}
