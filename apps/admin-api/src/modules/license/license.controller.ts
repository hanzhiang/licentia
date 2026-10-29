import { Controller, Get, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '@lp/domain';
import {
  JwtAuthGuard,
  PermGuard,
  RequirePerms,
  channelScope,
  requireTenantId,
} from '../../iam/guards';
import { actorFrom } from '../../iam/actor';
import { LicenseService } from './license.service';
import { RenewSchema, RevokeSchema } from '../dto';

function idemKey(req: FastifyRequest): string | undefined {
  const v = req.headers['idempotency-key'];
  return typeof v === 'string' ? v : undefined;
}

function parseOrThrow<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('REQ_INVALID', '请求参数不合法', {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return parsed.data;
}

@Controller('admin/v1/licenses')
@UseGuards(JwtAuthGuard, PermGuard)
export class LicenseController {
  constructor(private readonly service: LicenseService) {}

  @Get()
  @RequirePerms('license:read')
  async list(
    @Req() req: FastifyRequest,
    @Query('status') status: string | undefined,
    @Query('limit') limit: string | undefined,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const tenantId = requireTenantId(req);
    const data = await this.service.list(tenantId, {
      status,
      limit: limit ? Number(limit) : undefined,
      channelId: channelScope(req),
    });
    void reply.code(200).send({ data });
  }

  @Get(':id')
  @RequirePerms('license:read')
  async get(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const tenantId = requireTenantId(req);
    const data = await this.service.get(tenantId, id, channelScope(req));
    void reply.code(200).send({ data });
  }

  @Post(':id/renew')
  @RequirePerms('license:renew')
  async renew(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const tenantId = requireTenantId(req);
    const cmd = parseOrThrow(RenewSchema, req.body);
    const result = await this.service.renew(tenantId, id, cmd, idemKey(req), actorFrom(req));
    void reply.code(result.status).send(result.body);
  }

  @Post(':id/revoke')
  @RequirePerms('license:revoke:approve')
  async revoke(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const tenantId = requireTenantId(req);
    const cmd = parseOrThrow(RevokeSchema, req.body);
    const result = await this.service.revoke(tenantId, id, cmd, idemKey(req), actorFrom(req));
    void reply.code(result.status).send(result.body);
  }

  @Get(':id/timeline')
  @RequirePerms('license:read')
  async timeline(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const tenantId = requireTenantId(req);
    const data = await this.service.timeline(tenantId, id, channelScope(req));
    void reply.code(200).send({ data });
  }
}
