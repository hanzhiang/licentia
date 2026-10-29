import type { DeviceInfo, Entitlement, HeartbeatResult, ActivateResult, Jwk } from './types';
import { SdkError } from './errors';
import {
  clockRollbackOk,
  verifyOfflineLicense,
  type OfflineVerifyOptions,
} from './offline';

export interface KvStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export function memoryStorage(): KvStorage {
  const m = new Map<string, string>();
  return {
    get: (k) => m.get(k) ?? null,
    set: (k, v) => void m.set(k, v),
    remove: (k) => void m.delete(k),
  };
}

export interface LicenseClientOptions {
  baseUrl: string;
  productCode: string;
  /** 产品编码在多个开发者下重名时必填, 用于定位开发者 */
  tenantCode?: string;
  appVersion: string;
  device: DeviceInfo;
  /** 组织许可的席位归属; 激活和心跳都会携带, 服务端 HMAC 后作为席位成员 */
  userId?: string;
  /** 持久化适配器: 桌面端接 DPAPI/Keychain/Keystore 加密存储, 服务端接数据库 (默认内存) */
  storage?: KvStorage;
  fetchImpl?: typeof fetch;
  /** 自动心跳间隔; 0 = 仅手动 heartbeat() (默认 24h) */
  heartbeatIntervalMs?: number;
  /** 心跳失败退避序列 ms (默认 60s/300s/1800s, 设计文档 §4.3) */
  heartbeatRetryBackoffMs?: number[];
  /** 离线验签公钥来源(设计文档 §10.2: 内置快照 + JWKS 在线刷新) */
  offlineVerify?: OfflineVerifyOptions;
  /** 时钟回拨容忍(秒, 默认 24h) */
  clockRollbackToleranceSec?: number;
}

const TOKEN_KEY = 'lp_client_token';
const CODE_KEY = 'lp_license_code';
const OFFLINE_KEY = 'lp_offline_license';
const MAX_TIME_KEY = 'lp_max_server_time';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * 客户端 SDK(设计文档 §4.2/§4.3/§10.3):
 *  - activate: 同设备重复激活服务端幂等(200), 本地持久化 token/code/离线许可
 *  - heartbeat: token 轮换跟随服务端; 401 且本地有码 → 自动重激活一次
 *  - entitlement(): 服务端结果优先; 断网时用离线许可 + 时钟回拨守卫本地判定
 *  - 网络错误/5xx: activate/heartbeat 各自退避重试 3 次
 */
export class LicenseClient {
  private readonly storage: KvStorage;
  private readonly fetchImpl: FetchLike;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private jwksCache: { keys: Jwk[]; at: number } | null = null;

  constructor(private readonly opts: LicenseClientOptions) {
    this.storage = opts.storage ?? memoryStorage();
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
  }

  // ---- 对外 API ----

  async activate(code: string): Promise<Entitlement> {
    this.storage.set(CODE_KEY, code);
    const body = {
      code,
      app: { product_code: this.opts.productCode, version: this.opts.appVersion },
      device: {
        fp_type: this.opts.device.fpType,
        fingerprint: this.opts.device.fingerprint,
        platform: this.opts.device.platform,
        ...(this.opts.device.meta ? { meta: this.opts.device.meta } : {}),
      },
      ...(this.opts.userId ? { context: { user_id: this.opts.userId } } : {}),
    };
    const res = await this.request<ActivateResult>('POST', '/client/v1/activate', body, 3);
    this.adoptServerResult(res);
    return this.entitlement();
  }

  private deviceBody(): Record<string, unknown> {
    return {
      fp_type: this.opts.device.fpType,
      fingerprint: this.opts.device.fingerprint,
      platform: this.opts.device.platform,
    };
  }

  /**
   * 远程授权第一步: 上报设备, 拿到一个展示给用户的短码。
   * 用户把短码报给客服/开发者, 对方在后台批准后调用 awaitDeviceApproval。
   */
  async requestDeviceApproval(): Promise<{ requestCode: string; expiresAt: string }> {
    const res = await this.fetchImpl(`${this.opts.baseUrl.replace(/\/$/, '')}/client/v1/device-requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        product_code: this.opts.productCode,
        ...(this.opts.tenantCode ? { tenant_code: this.opts.tenantCode } : {}),
        app_version: this.opts.appVersion,
        ...(this.opts.userId ? { user_id: this.opts.userId } : {}),
        device: this.deviceBody(),
      }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
      throw new SdkError(err.error?.code ?? 'DEVICE_REQUEST_FAILED', err.error?.message ?? '设备码申请失败', res.status);
    }
    const json = (await res.json()) as { data: { request_code: string; expires_at: string } };
    return { requestCode: json.data.request_code, expiresAt: json.data.expires_at };
  }

  /**
   * 远程授权第二步: 轮询直到被批准, 拿到授权码后自动完成激活。
   * 超时或拒绝会抛 SdkError, 调用方应提示用户重新申请。
   */
  async awaitDeviceApproval(
    requestCode: string,
    opts: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<Entitlement> {
    const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
    const intervalMs = opts.intervalMs ?? 3000;
    const deadline = Date.now() + timeoutMs;
    const url = `${this.opts.baseUrl.replace(/\/$/, '')}/client/v1/device-requests/${encodeURIComponent(requestCode)}/poll`;

    while (Date.now() < deadline) {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ device: this.deviceBody() }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
        throw new SdkError(err.error?.code ?? 'DEVICE_REQUEST_FAILED', err.error?.message ?? '轮询失败', res.status);
      }
      const json = (await res.json()) as {
        data: { status: string; code?: string; note?: string | null };
      };
      const d = json.data;
      if (d.status === 'approved' && d.code) return this.activate(d.code);
      if (d.status === 'rejected') {
        throw new SdkError('DEVICE_REQUEST_REJECTED', d.note ?? '申请已被拒绝');
      }
      if (d.status === 'expired') {
        throw new SdkError('DEVICE_REQUEST_EXPIRED', '设备码已过期, 请重新申请');
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new SdkError('DEVICE_REQUEST_TIMEOUT', '等待授权超时');
  }

  async heartbeat(): Promise<Entitlement> {
    const token = this.storage.get(TOKEN_KEY);
    if (!token) throw new SdkError('AUTH_REQUIRED', '尚未激活');
    try {
      const res = await this.request<HeartbeatResult>(
        'POST',
        '/client/v1/heartbeat',
        this.opts.userId ? { context: { user_id: this.opts.userId } } : {},
        3,
        token,
      );
      this.adoptServerResult(res);
    } catch (e) {
      // token 失效且本地有码 → 静默重激活一次(设计文档 §4.3 E1)
      if (e instanceof SdkError && e.code === 'AUTH_REQUIRED' && this.storage.get(CODE_KEY)) {
        return this.activate(this.storage.get(CODE_KEY)!);
      }
      throw e;
    }
    return this.entitlement();
  }

  /**
   * 当前权益判定: 优先离线许可(Ed25519 验签 + exp) + 时钟回拨守卫;
   * 无离线许可时提示联网. 验签公钥: 显式配置 > 懒加载平台 JWKS(缓存 24h).
   */
  async entitlement(): Promise<Entitlement> {
    const serverTime = Number(this.storage.get(MAX_TIME_KEY) ?? 0);
    const offlineToken = this.storage.get(OFFLINE_KEY);
    const nowSec = Math.floor(Date.now() / 1000);
    if (!offlineToken) {
      return { valid: false, reason: 'NEED_ONLINE', features: [], expiresAt: null, source: 'server', serverTime };
    }
    if (!clockRollbackOk(serverTime, nowSec, this.opts.clockRollbackToleranceSec)) {
      return { valid: false, reason: 'CLOCK_ROLLBACK', features: [], expiresAt: null, source: 'offline', serverTime };
    }
    try {
      const opts = await this.resolveOfflineVerifyOpts(nowSec);
      const claims = await verifyOfflineLicense(offlineToken, opts);
      return {
        valid: true,
        features: claims.feats,
        expiresAt: new Date(claims.exp * 1000).toISOString(),
        source: 'offline',
        serverTime,
      };
    } catch (e) {
      return {
        valid: false,
        reason: (e as Error).message,
        features: [],
        expiresAt: null,
        source: 'offline',
        serverTime,
      };
    }
  }

  startAutoHeartbeat(): void {
    const interval = this.opts.heartbeatIntervalMs ?? 24 * 3600 * 1000;
    if (interval <= 0 || this.timer) return;
    this.timer = setInterval(() => {
      void this.heartbeat().catch(() => undefined);
    }, interval);
    void this.timer.unref?.();
  }

  stopAutoHeartbeat(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ---- 内部 ----

  private async resolveOfflineVerifyOpts(nowSec: number): Promise<OfflineVerifyOptions> {
    const base: OfflineVerifyOptions = { ...(this.opts.offlineVerify ?? {}), nowSec };
    if (base.publicKeyPem || base.jwks) return base;
    // 缺省: 懒加载平台 JWKS 并缓存 24h(生产建议同时内置首发快照, §10.2)
    if (!this.jwksCache || Date.now() - this.jwksCache.at > 24 * 3600 * 1000) {
      const res = await this.fetchImpl(`${this.opts.baseUrl.replace(/\/$/, '')}/.well-known/jwks.json`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`OFFLINE_LICENSE_NO_KEY: jwks http ${res.status}`);
      const json = (await res.json()) as { keys: Jwk[] };
      this.jwksCache = { keys: json.keys, at: Date.now() };
    }
    return { ...base, jwks: this.jwksCache };
  }

  private adoptServerResult(res: ActivateResult | HeartbeatResult): void {
    this.storage.set(TOKEN_KEY, res.client_token);
    if ('offline_license' in res && res.offline_license) {
      this.storage.set(OFFLINE_KEY, res.offline_license);
    }
    if (typeof res.server_time === 'number') {
      const prev = Number(this.storage.get(MAX_TIME_KEY) ?? 0);
      if (res.server_time > prev) this.storage.set(MAX_TIME_KEY, String(res.server_time));
    }
  }

  private async request<T>(
    method: string,
    path: string,
    body: unknown,
    retries: number,
    bearer?: string,
  ): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (bearer) headers.authorization = `Bearer ${bearer}`;
        const res = await this.fetchImpl(`${this.opts.baseUrl.replace(/\/$/, '')}${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
        const json = (await res.json().catch(() => ({}))) as {
          data?: T;
          error?: { code: string; message: string; details?: Record<string, unknown> };
        };
        if (res.ok && json.data !== undefined) return json.data;
        throw new SdkError(
          json.error?.code ?? 'INTERNAL_ERROR',
          json.error?.message ?? `http ${res.status}`,
          res.status,
          json.error?.details,
        );
      } catch (e) {
        lastErr = e;
        const retryable =
          !(e instanceof SdkError) || (e.status !== undefined && e.status >= 500) || e.status === 429;
        if (!retryable || attempt === retries) break;
        await sleep(this.retryBackoffMs(attempt));
      }
    }
    throw lastErr;
  }

  private retryBackoffMs(attempt: number): number {
    return this.opts.heartbeatRetryBackoffMs?.[attempt] ?? [1000, 2000, 4000][attempt] ?? 4000;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
