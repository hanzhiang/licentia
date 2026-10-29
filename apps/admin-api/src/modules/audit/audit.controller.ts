import { Controller, Get, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { JwtAuthGuard, PermGuard, RequirePerms, requireTenantId } from '../../iam/guards';
import { verifyChain } from '@lp/audit';
import { withTenantTx, type LpDb, type LpTx } from '@lp/db';
import { Inject } from '@nestjs/common';
import { Kysely } from 'kysely';
import { DB } from '../../db.module';

@Controller('admin/v1/audit-events')
@UseGuards(JwtAuthGuard, PermGuard)
export class AuditController {
  constructor(@Inject(DB) private readonly db: Kysely<LpDb>) {}

  @Get()
  @RequirePerms('audit:read')
  async list(
    @Req() req: FastifyRequest,
    @Query('limit') limit: string | undefined,
    @Query('actor_id') actorId: string | undefined,
    @Query('action') action: string | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const tenantId = requireTenantId(req);
    const lim = Math.min(Math.max(Number(limit ?? 100) || 100, 1), 500);
    const fromDate = from ? new Date(from) : null;
    const toDate = to ? new Date(to) : null;
    if (from && fromDate !== null && Number.isNaN(fromDate.getTime())) {
      void reply.code(400).send({ error: { code: 'REQ_INVALID', message: 'from 时间格式错误' } });
      return;
    }
    const rows = await withTenantTx(this.db, tenantId, (tx) => {
      let q = tx
        .selectFrom('audit_events')
        .selectAll()
        .orderBy('id', 'desc')
        .limit(lim);
      if (actorId) q = q.where('actor_id', '=', actorId);
      if (action) q = q.where('action', '=', action);
      if (fromDate) q = q.where('occurred_at', '>=', fromDate);
      if (toDate) q = q.where('occurred_at', '<=', toDate);
      return q.execute();
    });
    void reply.code(200).send({
      data: rows.map((r) => ({
        id: r.id,
        occurred_at: r.occurred_at.toISOString(),
        actor_type: r.actor_type,
        actor_id: r.actor_id,
        action: r.action,
        resource_type: r.resource_type,
        resource_id: r.resource_id,
        detail: r.detail,
        ip: r.ip,
        request_id: r.request_id,
      })),
    });
  }

  /** 验链: 重算本租户全部审计条目的哈希序列, 任何篡改(改行/删行/插入)都会断裂 */
  @Get('verify')
  @RequirePerms('audit:read')
  async verify(@Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const tenantId = requireTenantId(req);
    const result = await withTenantTx(this.db, tenantId, (tx: LpTx) =>
      verifyChain(tx, tenantId),
    );
    void reply.code(200).send({ data: result });
  }

  /**
   * 审计导出(CSV): 合规/取证场景需要把审计记录带出系统。
   * 带 BOM 以便 Excel 正确识别 UTF-8; 单次上限 5000 条, 更大的范围请按时间分段。
   */
  @Get('export')
  @RequirePerms('audit:read')
  async export(
    @Req() req: FastifyRequest,
    @Query('actor_id') actorId: string | undefined,
    @Query('action') action: string | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const tenantId = requireTenantId(req);
    const fromDate = from ? new Date(from) : null;
    const toDate = to ? new Date(to) : null;
    const rows = await withTenantTx(this.db, tenantId, (tx) => {
      let q = tx
        .selectFrom('audit_events')
        .select(['occurred_at', 'actor_type', 'actor_id', 'action', 'resource_type', 'resource_id', 'detail', 'ip', 'request_id'])
        .orderBy('id', 'asc')
        .limit(5000);
      if (actorId) q = q.where('actor_id', '=', actorId);
      if (action) q = q.where('action', '=', action);
      if (fromDate) q = q.where('occurred_at', '>=', fromDate);
      if (toDate) q = q.where('occurred_at', '<=', toDate);
      return q.execute();
    });

    const esc = (v: unknown): string => {
      const s = v === null || v === undefined ? '' : String(v);
      const lf = String.fromCharCode(10);
      const cr = String.fromCharCode(13);
      const needsQuote = s.includes(',') || s.includes('"') || s.includes(lf) || s.includes(cr);
      return needsQuote ? '"' + s.split('"').join('""') + '"' : s;
    };
    const lines = ['occurred_at,actor_type,actor_id,action,resource_type,resource_id,ip,request_id,detail'];
    for (const r of rows) {
      lines.push(
        [
          r.occurred_at.toISOString(),
          r.actor_type,
          r.actor_id,
          r.action,
          r.resource_type,
          r.resource_id,
          r.ip ?? '',
          r.request_id ?? '',
          JSON.stringify(r.detail),
        ]
          .map(esc)
          .join(','),
      );
    }
    void reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="audit-${Date.now()}.csv"`)
      .code(200)
      .send(String.fromCharCode(0xfeff) + lines.join(String.fromCharCode(10)) + String.fromCharCode(10));
  }
}
