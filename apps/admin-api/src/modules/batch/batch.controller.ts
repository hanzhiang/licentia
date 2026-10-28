import { Controller, Get, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '@lp/domain';
import { JwtAuthGuard, PermGuard, RequirePerms, requireTenantId, currentUser } from '../../iam/guards';
import { actorFrom } from '../../iam/actor';
import { BatchService } from './batch.service';
import { IssueBatchSchema } from '../dto';

const IdempotencyHeader = 'idempotency-key';

@Controller('admin/v1/batches')
@UseGuards(JwtAuthGuard, PermGuard)
export class BatchController {
  constructor(private readonly service: BatchService) {}

  @Post()
  @RequirePerms('license:issue')
  async issue(@Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const tenantId = requireTenantId(req);
    const parsed = IssueBatchSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError('REQ_INVALID', '请求参数不合法', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const idemKey = req.headers[IdempotencyHeader];
    const result = await this.service.issue(
      tenantId,
      parsed.data,
      typeof idemKey === 'string' ? idemKey : undefined,
      actorFrom(req),
    );
    void reply.code(result.status).send(result.body);
  }

  @Get()
  @RequirePerms('batch:read')
  async list(
    @Req() req: FastifyRequest,
    @Query('limit') limit: string | undefined,
    @Query('mine') mine: string | undefined,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const tenantId = requireTenantId(req);
    const data = await this.service.list(
      tenantId,
      limit ? Number(limit) : undefined,
      mine === 'true' ? currentUser(req).id : undefined,
    );
    void reply.code(200).send({ data });
  }

  @Get(':id/export')
  @RequirePerms('license:issue')
  async exportCodes(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const tenantId = requireTenantId(req);
    const data = await this.service.exportCsv(tenantId, id, actorFrom(req));
    void reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${data.filename}"`)
      .code(200)
      .send(data.csv);
  }

  @Get(':id')
  @RequirePerms('batch:read')
  async getBatch(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const tenantId = requireTenantId(req);
    const data = await this.service.getBatch(tenantId, id);
    void reply.code(200).send({ data });
  }
}

