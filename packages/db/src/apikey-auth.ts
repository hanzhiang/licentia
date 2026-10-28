import crypto from 'node:crypto';
import type { Kysely } from 'kysely';
import { AppError } from '@lp/domain';
import { withSystemTx } from './tenant-tx';
import type { LpDb } from './types';

/** 明文 key: lpk_live_ + 30B base64url; 前 20 字符作为定位前缀(控制台展示 + 索引) */
export const API_KEY_PREFIX_LEN = 20;

export function sha256ApiKey(key: string): Buffer {
  return crypto.createHash('sha256').update(key, 'utf8').digest();
}

export function generateApiKey(): { key: string; prefix: string; keyHash: Buffer } {
  const key = `lpk_live_${crypto.randomBytes(30).toString('base64url')}`;
  return { key, prefix: key.slice(0, API_KEY_PREFIX_LEN), keyHash: sha256ApiKey(key) };
}

export interface ApiKeyAuth {
  id: string;
  tenantId: string;
  scopes: string[];
  rateLimitQps: number;
}

/**
 * 开放 API 鉴权(设计文档 §14): 前缀定位 + SHA-256 常数时间比较.
 * 任何失败统一 API_KEY_INVALID, 不区分"不存在/已吊销"(防探测); RLS bypass 仅限本次查找.
 */
export async function authenticateApiKey(db: Kysely<LpDb>, key: string): Promise<ApiKeyAuth> {
  if (!key.startsWith('lpk_live_')) throw new AppError('API_KEY_INVALID');
  const prefix = key.slice(0, API_KEY_PREFIX_LEN);
  const row = await withSystemTx(db, (tx) =>
    tx.selectFrom('api_keys').selectAll().where('prefix', '=', prefix).executeTakeFirst(),
  );
  const hash = sha256ApiKey(key);
  const ok =
    row !== undefined &&
    (row.status === 'active' || row.status === 'rotated') &&
    (row.expires_at === null || row.expires_at.getTime() > Date.now()) &&
    row.key_hash.length === hash.length &&
    crypto.timingSafeEqual(row.key_hash, hash);
  if (!ok) throw new AppError('API_KEY_INVALID');
  return {
    id: row.id,
    tenantId: row.tenant_id,
    scopes: row.scopes,
    rateLimitQps: row.rate_limit_qps,
  };
}
