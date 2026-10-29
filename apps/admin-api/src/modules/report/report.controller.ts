import { Inject, Controller, Get, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { JwtAuthGuard, PermGuard, RequirePerms, requireTenantId } from '../../iam/guards';
import { withTenantTx, type LpDb } from '@lp/db';
import { Kysely, sql } from 'kysely';
import { csvHeaders, toCsv } from '@lp/http';
import { AppError } from '@lp/domain';
import { DB } from '../../db.module';

interface ChannelStatRow {
  batch_id: string;
  channel_id: string | null;
  channel_name: string;
  quantity: number;
  /** pg 的 count 是 bigint, 驱动给字符串; 导出时原样写出即可 */
  activated_count: number | string;
  active_license_count: number | string;
  revoked_count: number | string;
  activation_rate_pct: number | string | null;
}

interface SummaryData {
  range_days: number;
  totals: {
    licenses: number;
    activated: number;
    revoked: number;
    expired: number;
    expiring_30d: number;
  };
  daily: { date: string; issued: number; activated: number }[];
  products: {
    id: string;
    code: string;
    name: string;
    licenses: number;
    activated: number;
    revoked: number;
  }[];
}

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
    const rows = await this.channelStatRows(requireTenantId(req), channelId, batchId);
    void reply.code(200).send({ data: rows });
  }

  /** 渠道统计导出: 与页面同一份数据, 财务拿去对账 */
  @Get('channel-stats.csv')
  @RequirePerms('report:read')
  async channelStatsCsv(
    @Req() req: FastifyRequest,
    @Query('channel_id') channelId: string | undefined,
    @Query('batch_id') batchId: string | undefined,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const rows = await this.channelStatRows(requireTenantId(req), channelId, batchId);
    const csv = toCsv(
      rows as unknown as Record<string, unknown>[],
      [
        { key: 'channel_name', label: '渠道' },
        { key: 'batch_id', label: '批次' },
        { key: 'quantity', label: '发码数' },
        { key: 'activated_count', label: '已激活' },
        { key: 'active_license_count', label: '当前活跃' },
        { key: 'revoked_count', label: '已吊销' },
        { key: 'activation_rate_pct', label: '激活率(%)' },
      ],
    );
    void reply.headers(csvHeaders(`channel-stats-${today()}.csv`)).code(200).send(csv);
  }

  /**
   * 总览: 按天的新增/激活曲线、按产品的分布、以及即将到期的存量。
   * 之前只有渠道维度, 财务角色打开报表只能看到一张渠道表。
   */
  @Get('summary')
  @RequirePerms('report:read')
  async summary(
    @Req() req: FastifyRequest,
    @Query('days') days: string | undefined,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const data = await this.summaryData(requireTenantId(req), days);
    void reply.code(200).send({ data });
  }

  /** 总览导出: part=daily(按天曲线) | products(按产品分布) */
  @Get('summary.csv')
  @RequirePerms('report:read')
  async summaryCsv(
    @Req() req: FastifyRequest,
    @Query('days') days: string | undefined,
    @Query('part') part: string | undefined,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const data = await this.summaryData(requireTenantId(req), days);
    const which = part ?? 'products';
    if (which === 'daily') {
      const csv = toCsv(data.daily as unknown as Record<string, unknown>[], [
        { key: 'date', label: '日期' },
        { key: 'issued', label: '新发' },
        { key: 'activated', label: '激活' },
      ]);
      void reply.headers(csvHeaders(`summary-daily-${today()}.csv`)).code(200).send(csv);
      return;
    }
    if (which !== 'products') {
      throw new AppError('REQ_INVALID', `不支持的分区: ${which}`);
    }
    const csv = toCsv(data.products as unknown as Record<string, unknown>[], [
      { key: 'code', label: '产品编码' },
      { key: 'name', label: '产品名称' },
      { key: 'licenses', label: '授权码总数' },
      { key: 'activated', label: '已激活' },
      { key: 'revoked', label: '已吊销' },
    ]);
    void reply.headers(csvHeaders(`summary-products-${today()}.csv`)).code(200).send(csv);
  }

  private async channelStatRows(
    tenantId: string,
    channelId?: string,
    batchId?: string,
  ): Promise<ChannelStatRow[]> {
    return withTenantTx(this.db, tenantId, (tx) => {
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
  }

  private async summaryData(tenantId: string, days?: string): Promise<SummaryData> {
    const span = Math.min(Math.max(Number(days ?? 30) || 30, 1), 365);
    return withTenantTx(this.db, tenantId, async (tx) => {
      const daily = await sql<{ d: string; issued: string; activated: string }>`
        with series as (
          select generate_series(
            current_date - (${span}::int - 1), current_date, interval '1 day'
          )::date as d
        )
        select to_char(series.d, 'YYYY-MM-DD') as d,
               (select count(*) from licenses l where l.issued_at::date = series.d) as issued,
               (select count(*) from licenses l where l.activated_at::date = series.d) as activated
          from series
         order by series.d
      `.execute(tx);

      const products = await tx
        .selectFrom('products')
        .leftJoin('licenses', 'licenses.product_id', 'products.id')
        .select([
          'products.id',
          'products.code',
          'products.name',
          sql<string>`count(licenses.id)`.as('licenses'),
          sql<string>`count(licenses.id) filter (where licenses.status = 'activated')`.as(
            'activated',
          ),
          sql<string>`count(licenses.id) filter (where licenses.status = 'revoked')`.as('revoked'),
        ])
        .where('products.deleted_at', 'is', null)
        .groupBy(['products.id', 'products.code', 'products.name'])
        .orderBy(sql`count(licenses.id) desc`)
        .execute();

      const totals = await tx
        .selectFrom('licenses')
        .select([
          sql<string>`count(*)`.as('licenses'),
          sql<string>`count(*) filter (where status = 'activated')`.as('activated'),
          sql<string>`count(*) filter (where status = 'revoked')`.as('revoked'),
          sql<string>`count(*) filter (where status = 'expired')`.as('expired'),
          sql<string>`count(*) filter (
            where status = 'activated'
              and expires_at is not null
              and expires_at <= now() + interval '30 days'
          )`.as('expiring_30d'),
        ])
        .executeTakeFirstOrThrow();

      return {
        range_days: span,
        totals: {
          licenses: Number(totals.licenses),
          activated: Number(totals.activated),
          revoked: Number(totals.revoked),
          expired: Number(totals.expired),
          expiring_30d: Number(totals.expiring_30d),
        },
        daily: daily.rows.map((r) => ({
          date: r.d,
          issued: Number(r.issued),
          activated: Number(r.activated),
        })),
        products: products.map((p) => ({
          id: p.id,
          code: p.code,
          name: p.name,
          licenses: Number(p.licenses),
          activated: Number(p.activated),
          revoked: Number(p.revoked),
        })),
      };
    });
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
