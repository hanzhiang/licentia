import { Inject, Controller, Get, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { JwtAuthGuard, PermGuard, RequirePerms, requireTenantId } from '../../iam/guards';
import { withTenantTx, type LpDb } from '@lp/db';
import { Kysely } from 'kysely';
import { DB } from '../../db.module';

@Controller('admin/v1/reports')
@UseGuards(JwtAuthGuard, PermGuard)
export class ReportsController {
  constructor(@Inject(DB) private readonly db: Kysely<LpDb>) {}

  /** 渠道/批次统计(设计文档 §4.8 场景8): 激活率/活跃许可/吊销回收 */
  @Get('channel-stats')
  @RequirePerms('report:read')
  async channelStats(
    @Req() req: FastifyRequest,
    @Query('channel_id') channelId: string | undefined,
    @Query('batch_id') batchId: string | undefined,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const tenantId = requireTenantId(req);
    const rows = await withTenantTx(this.db, tenantId, (tx) => {
      let q = tx
        .selectFrom('v_channel_batch_stats as s')
        .innerJoin('channels as c', 'c.id', 's.channel_id')
        .select([
          's.batch_id',
          's.channel_id',
          'c.name as channel_name',
          's.quantity',
          's.activated_count',
          's.active_license_count',
          's.revoked_count',
          's.activation_rate_pct',
        ])
        .orderBy('s.quantity', 'desc')
        .limit(200);
      if (channelId) q = q.where('s.channel_id', '=', channelId);
      if (batchId) q = q.where('s.batch_id', '=', batchId);
      return q.execute();
    });
    void reply.code(200).send({ data: rows });
  }
}
