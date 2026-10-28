import { Inject, Injectable } from '@nestjs/common';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Kysely } from 'kysely';
import { errBatchNotFound, errPolicyNotFound, errReqInvalid } from '@lp/domain';
import {
  encryptAead,
  generateCode,
  hmacCode,
  normalizePrefix,
} from '@lp/keygen';
import { LpDb, uuidv7, withSystemTx, withTenantTx, type LicensesRow } from '@lp/db';
import { emitOutbox } from '@lp/events';
import { withIdempotency } from '@lp/idempotency';
import { writeAudit } from '@lp/audit';
import { getConfig } from '@lp/config';
import { DB } from '../../db.module';
import type { ActorInfo } from '../../iam/actor';
import type { IssueBatchDto } from '../dto';

const SYSTEM_USER = '00000000-0000-0000-0000-000000000000';

export interface IssueResultBody {
  data: {
    batch_id: string;
    status: string;
    issued_count: number;
    failed_count: number;
    csv_path: string | null;
    codes?: string[];
  };
}

/**
 * 批量发码(设计文档 §4.1 / §16.2):
 *  - 幂等: Idempotency-Key + 请求体哈希, 重放返回首次结果
 *  - 分块: BATCH_CHUNK_SIZE(2000)/INSERT, code_hmac 冲突整块跳过(doNothing)计入缺口
 *  - 对账: batch.issued_count 与 count(licenses where batch_id) 恒等由同流程写入
 */
@Injectable()
export class BatchService {
  constructor(@Inject(DB) private readonly db: Kysely<LpDb>) {}

  async issue(
    tenantId: string,
    cmd: IssueBatchDto,
    idemKey: string | undefined,
    actor?: ActorInfo,
  ): Promise<{ status: number; body: IssueResultBody }> {
    if (!idemKey) {
      // withIdempotency 之外的显式校验: 缺 key 直接 400
      throw errReqInvalid('缺少 Idempotency-Key 头');
    }
    const cfg = getConfig();
    if (cmd.quantity > cfg.BATCH_MAX_QUANTITY) {
      throw errReqInvalid(`quantity 超出单批上限 ${cfg.BATCH_MAX_QUANTITY}`);
    }

    return withIdempotency<IssueResultBody>(
      this.db,
      { tenantId, key: idemKey, endpoint: 'POST /admin/v1/batches', requestBody: cmd },
      async () => {
        const policy = await withTenantTx(this.db, tenantId, (tx) =>
          tx
            .selectFrom('policies')
            .selectAll()
            .where('id', '=', cmd.policy_id)
            .where('deleted_at', 'is', null)
            .executeTakeFirst(),
        );
        if (!policy) throw errPolicyNotFound();
        if (policy.status !== 'active') {
          throw errReqInvalid('策略已停用, 不能发码');
        }
        const product = await withTenantTx(this.db, tenantId, (tx) =>
          tx.selectFrom('products').selectAll().where('id', '=', cmd.product_id).executeTakeFirst(),
        );
        if (!product) throw errReqInvalid('产品不存在');

        const prefix = normalizePrefix(product.code.slice(0, 4));
        const batchId = uuidv7();

        await withTenantTx(this.db, tenantId, (tx) =>
          tx
            .insertInto('license_batches')
            .values({
              id: batchId,
              tenant_id: tenantId,
              product_id: cmd.product_id,
              policy_id: cmd.policy_id,
              channel_id: cmd.channel_id ?? null,
              code: `B${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`,
              quantity: cmd.quantity,
              status: 'issuing',
              issued_count: 0,
              failed_count: 0,
              note: cmd.note ?? null,
              csv_object_key: null,
              created_by: actor?.userId ?? SYSTEM_USER,
              created_at: new Date(),
              completed_at: null,
            })
            .execute(),
        );

        let issued = 0;
        for (let offset = 0; offset < cmd.quantity; offset += cfg.BATCH_CHUNK_SIZE) {
          const n = Math.min(cfg.BATCH_CHUNK_SIZE, cmd.quantity - offset);
          const rows: LicensesRow[] = [];
          for (let i = 0; i < n; i++) {
            const { code, normalized } = generateCode(prefix);
            rows.push({
              id: uuidv7(),
              tenant_id: tenantId,
              product_id: cmd.product_id,
              policy_id: cmd.policy_id,
              batch_id: batchId,
              channel_id: cmd.channel_id ?? null,
              end_customer_id: null,
              code,
              code_hmac: hmacCode(cfg.CODE_HMAC_KEY, normalized),
              code_cipher: encryptAead(cfg.CODE_ENC_KEY, code),
              kind: policy.kind,
              status: 'issued' as const,
              device_limit: policy.device_limit,
              seat_limit: policy.seat_limit,
              concurrency_limit: policy.concurrency_limit,
              // jsonb 列: node-pg 会把 JS 数组序列化为 PG 数组字面量, 必须显式 stringify
              features: JSON.stringify(policy.features) as unknown as string[],
              offline_window_days: policy.offline_window_days,
              heartbeat_hours: policy.heartbeat_hours,
              grace_hours: policy.grace_hours,
              activate_within_days: policy.activate_within_days,
              renew_window_days: policy.renew_window_days,
              allow_renewal: policy.allow_renewal,
              min_version: policy.min_version,
              duration_days: policy.duration_days,
              issued_at: new Date(),
              activated_at: null,
              expires_at: null,
              suspended_at: null,
              revoked_at: null,
              revoked_reason: null,
              version: 1,
              created_by: SYSTEM_USER,
              created_at: new Date(),
              updated_at: new Date(),
            });
          }
          const inserted = await withTenantTx(this.db, tenantId, (tx) =>
            tx
              .insertInto('licenses')
              .values(rows)
              .onConflict((oc) => oc.column('code_hmac').doNothing())
              .returningAll()
              .execute(),
          );
          issued += inserted.length;
        }

        const status = issued === cmd.quantity ? 'completed' : 'partially_failed';
        const csvPath = status === 'completed' ? await this.writeCsv(tenantId, batchId) : null;

        await withTenantTx(this.db, tenantId, (tx) =>
          tx
            .updateTable('license_batches')
            .set({
              status,
              issued_count: issued,
              failed_count: cmd.quantity - issued,
              completed_at: new Date(),
              csv_object_key: csvPath,
            })
            .where('id', '=', batchId)
            .execute(),
        );

        await withSystemTx(this.db, async (tx) => {
          await emitOutbox(tx, 'batch.completed', tenantId, 'batch', batchId, {
            batch_id: batchId,
            issued,
          });
          await writeAudit(tx, {
            tenantId,
            actorType: (actor?.actorType ?? 'system') as 'operator',
            actorId: actor?.userId ?? SYSTEM_USER,
            action: 'license.issue',
            resourceType: 'license_batch',
            resourceId: batchId,
            detail: { quantity: cmd.quantity, issued, policy_id: cmd.policy_id },
            ip: actor?.ip ?? null,
            requestId: actor?.requestId ?? null,
          });
        });

        const data: IssueResultBody['data'] = {
          batch_id: batchId,
          status,
          issued_count: issued,
          failed_count: cmd.quantity - issued,
          csv_path: csvPath,
        };
        // 骨架便利: 小批量直接随响应返回明文码; 生产路径走 CSV 导出(§4.1 步骤5)
        if (cmd.quantity <= 100) {
          const codeRows = await withTenantTx(this.db, tenantId, (tx) =>
            tx.selectFrom('licenses').select('code').where('batch_id', '=', batchId).execute(),
          );
          data.codes = codeRows.map((c) => c.code);
        }
        return { status: 201, body: { data } };
      },
    );
  }

  async getBatch(tenantId: string, batchId: string) {
    const batch = await withTenantTx(this.db, tenantId, (tx) =>
      tx.selectFrom('license_batches').selectAll().where('id', '=', batchId).executeTakeFirst(),
    );
    if (!batch) throw errReqInvalid('批次不存在');
    return batch;
  }

  async list(tenantId: string, limit?: number, createdBy?: string): Promise<unknown[]> {
    const lim = Math.min(Math.max(limit ?? 50, 1), 200);
    return withTenantTx(this.db, tenantId, (tx) => {
      let q = tx
        .selectFrom('license_batches')
        .select([
          'id',
          'code',
          'product_id',
          'policy_id',
          'channel_id',
          'quantity',
          'status',
          'issued_count',
          'failed_count',
          'note',
          'csv_object_key',
          'created_by',
          'created_at',
          'completed_at',
        ])
        .orderBy('created_at', 'desc')
        .limit(lim);
      if (createdBy) q = q.where('created_by', '=', createdBy);
      return q.execute();
    });
  }

  /**
   * 导出本批次授权码.
   * 普通运营/渠道账号只能导出自己创建的批次; 租户管理员/平台超管可导出本租户任意批次.
   */
  async exportCsv(
    tenantId: string,
    batchId: string,
    actor: ActorInfo,
  ): Promise<{ filename: string; csv: string }> {
    return withTenantTx(this.db, tenantId, async (tx) => {
      const batch = await tx
        .selectFrom('license_batches')
        .select(['id', 'code', 'created_by'])
        .where('id', '=', batchId)
        .executeTakeFirst();
      if (!batch) throw errBatchNotFound();
      // 开发者所有者可导出本租户全部批次; 运营/渠道只能导出自己创建的
      const canSeeAll = actor.actorType === 'developer_owner';
      if (!canSeeAll && batch.created_by !== actor.userId) {
        throw errBatchNotFound();
      }
      const rows = await tx
        .selectFrom('licenses')
        .select(['code', 'issued_at'])
        .where('batch_id', '=', batchId)
        .orderBy('issued_at')
        .execute();
      await writeAudit(tx, {
        tenantId,
        actorType: actor.actorType as 'operator',
        actorId: actor.userId,
        action: 'batch.codes_export',
        resourceType: 'license_batch',
        resourceId: batchId,
        detail: { count: rows.length },
        ip: actor.ip ?? null,
        requestId: actor.requestId ?? null,
      });
      const csv = [
        'code,batch_id,issued_at',
        ...rows.map((r) => `${r.code},${batchId},${r.issued_at.toISOString()}`),
      ].join('\n');
      return { filename: `${batch.code}.csv`, csv: `${csv}\n` };
    });
  }

  /** CSV 导出(骨架: 本地文件; 生产: 流式写对象存储, 见设计 §4.1 步骤5) */
  private async writeCsv(tenantId: string, batchId: string): Promise<string> {
    const cfg = getConfig();
    const dir = path.resolve(cfg.EXPORT_DIR);
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${batchId}.csv`);
    const rows = await withTenantTx(this.db, tenantId, (tx) =>
      tx
        .selectFrom('licenses')
        .select(['code', 'issued_at'])
        .where('batch_id', '=', batchId)
        .execute(),
    );
    const lines = ['code,batch_id,issued_at'];
    for (const r of rows) {
      lines.push(`${r.code},${batchId},${r.issued_at.toISOString()}`);
    }
    await fsp.writeFile(file, lines.join('\n') + '\n', 'utf8');
    void fs;
    return file;
  }
}
