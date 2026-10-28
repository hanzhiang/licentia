import Redis from 'ioredis';

export type { Redis } from 'ioredis';

export const INVALIDATE_CHANNEL = 'lp:cache:invalidate';

export function createRedis(url: string): Redis {
  const client = new Redis(url, {
    maxRetriesPerRequest: 2,
    lazyConnect: false,
    retryStrategy: (times) => Math.min(times * 500, 5000),
  });
  return client;
}

export interface InvalidateMessage {
  tenantId: string;
  code_hmac: string; // base64url
}

/**
 * 吊销/状态变更 → 广播各 api 实例删除本地 validate 缓存(设计文档 §4.5 步骤4).
 * 失效丢失时由缓存 TTL(默认 60s)兜底.
 */
export async function publishLicenseInvalidated(
  redis: Redis,
  msg: InvalidateMessage,
): Promise<void> {
  await redis.publish(INVALIDATE_CHANNEL, JSON.stringify(msg));
}

export function subscribeInvalidation(
  redis: Redis,
  onMessage: (msg: InvalidateMessage) => void,
): void {
  const sub = redis.duplicate();
  void sub.subscribe(INVALIDATE_CHANNEL).catch((e) => {
    console.error('[cache] subscribe failed (TTL 兜底生效):', (e as Error).message);
  });
  sub.on('message', (_channel: string, message: string) => {
    try {
      onMessage(JSON.parse(message) as InvalidateMessage);
    } catch {
      // 忽略畸形消息
    }
  });
}
