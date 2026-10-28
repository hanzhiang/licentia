import { Controller, Get, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '@lp/domain';
import {
  JwtAuthGuard,
  PermGuard,
  RequirePerms,
  requireTenantId,
  currentUser,
} from '../../iam/guards';
import { actorFrom } from '../../iam/actor';
import { ApiKeysService } from './apikey.service';

const CreateSchema = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.enum(['validate', 'license:read', 'license:renew', 'report:read'])).min(1),
  rate_limit_qps: z.number().int().min(1).max(5000).optional(),
});

@Controller('admin/v1/api-keys')
@UseGuards(JwtAuthGuard, PermGuard)
export class ApiKeysController {
  constructor(private readonly service: ApiKeysService) {}

  @Post()
  @RequirePerms('apikey:write')
  async create(@Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const tenantId = requireTenantId(req);
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError('REQ_INVALID', '请求参数不合法', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    void currentUser(req);
    const result = await this.service.create(tenantId, parsed.data, actorFrom(req));
    void reply.code(201).send({ data: result }); // key 明文仅此一次
  }

  @Get()
  @RequirePerms('apikey:write', 'apikey:read')
  async list(@Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const tenantId = requireTenantId(req);
    const data = await this.service.list(tenantId);
    void reply.code(200).send({ data });
  }

  @Post(':id/rotate')
  @RequirePerms('apikey:write')
  async rotate(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const tenantId = requireTenantId(req);
    const result = await this.service.rotate(tenantId, id, actorFrom(req));
    void reply.code(200).send({ data: result });
  }

  @Post(':id/revoke')
  @RequirePerms('apikey:write')
  async revoke(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const tenantId = requireTenantId(req);
    const data = await this.service.revoke(tenantId, id, actorFrom(req));
    void reply.code(200).send({ data });
  }
}

void Reflector;
