import crypto from 'node:crypto';
import { sql } from 'kysely';
import type { LpTx } from '@lp/db';

export interface AuditEntryInput {
  tenantId: string | null;
  actorType:
    | 'platform_admin'
    | 'developer_owner'
    | 'developer_operator'
    | 'developer_support'
    | 'developer_finance'
    | 'developer_partner'
    // 旧取值保留: 历史数据仍可能读到
    | 'super_admin'
    | 'tenant_admin'
    | 'operator'
    | 'support'
    | 'finance'
    | 'end_customer'
    | 'api_key'
    | 'system';
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  detail?: Record<string, unknown>;
  ip?: string | null;
  requestId?: string | null;
  occurredAt?: Date;
}

export const GENESIS_HASH = Buffer.alloc(32);

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = canonicalize((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

function entryHash(prevHash: Buffer, e: AuditEntryInput, occurredAt: Date): Buffer {
  const canonical = JSON.stringify(
    canonicalize({
      tenant_id: e.tenantId,
      actor_type: e.actorType,
      actor_id: e.actorId,
      action: e.action,
      resource_type: e.resourceType,
      resource_id: e.resourceId,
      detail: e.detail ?? {},
      ip: e.ip ?? null,
      request_id: e.requestId ?? null,
      occurred_at: occurredAt.toISOString(),
    }),
  );
  return crypto.createHash('sha256').update(prevHash).update(canonical, 'utf8').digest();
}

/**
 * 同事务写审计(设计文档 §14 防篡改):
 *  - 每租户(或平台)一条链: entry_hash = sha256(prev_hash || canonical(entry))
 *  - pg_advisory_xact_lock 串行化同链并发写, 防链分叉
 *  - 调用方须在 withTenantTx(或 withSystemTx)事务内调用
 */
export async function writeAudit(tx: LpTx, e: AuditEntryInput): Promise<void> {
  const chainKey = e.tenantId ?? 'platform';
  await sql`select pg_advisory_xact_lock(hashtext(${chainKey})::bigint)`.execute(tx);
  const prevRow = await tx
    .selectFrom('audit_events')
    .select(['entry_hash'])
    .where('tenant_id', e.tenantId === null ? 'is' : '=', e.tenantId as string | null)
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  const prevHash = prevRow?.entry_hash ?? GENESIS_HASH;
  const occurredAt = e.occurredAt ?? new Date();
  const hash = entryHash(prevHash, e, occurredAt);
  await tx
    .insertInto('audit_events')
    .values({
      tenant_id: e.tenantId,
      occurred_at: occurredAt,
      actor_type: e.actorType,
      actor_id: e.actorId,
      action: e.action,
      resource_type: e.resourceType,
      resource_id: e.resourceId,
      detail: e.detail ?? {},
      ip: e.ip ?? null,
      ua: null,
      request_id: e.requestId ?? null,
      prev_hash: prevHash,
      entry_hash: hash,
    })
    .execute();
}

export interface ChainVerifyResult {
  valid: boolean;
  checked: number;
  brokenAtId?: string;
}

/** 验链: 按租户(或平台链 tenant_id is null)重算哈希序列 */
export async function verifyChain(
  tx: LpTx,
  tenantId: string | null,
): Promise<ChainVerifyResult> {
  const rows = await tx
    .selectFrom('audit_events')
    .selectAll()
    .where('tenant_id', tenantId === null ? 'is' : '=', tenantId as string | null)
    .orderBy('id', 'asc')
    .execute();
  let prev = GENESIS_HASH;
  for (const r of rows) {
    const expected = entryHash(
      prev,
      {
        tenantId: r.tenant_id,
        actorType: r.actor_type as AuditEntryInput['actorType'],
        actorId: r.actor_id,
        action: r.action,
        resourceType: r.resource_type,
        resourceId: r.resource_id,
        detail: r.detail,
        ip: r.ip,
        requestId: r.request_id,
      },
      r.occurred_at,
    );
    if (!r.entry_hash.equals(expected) || !r.prev_hash.equals(prev)) {
      return { valid: false, checked: rows.length, brokenAtId: String(r.id) };
    }
    prev = r.entry_hash;
  }
  return { valid: true, checked: rows.length };
}
