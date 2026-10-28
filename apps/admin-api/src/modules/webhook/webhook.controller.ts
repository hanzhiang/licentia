import { Controller, Get, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '@lp/domain';
import { JwtAuthGuard, PermGuard, RequirePerms, requireTenantId } from '../../iam/guards';
import { actorFrom } from '../../iam/actor';
import { WebhooksService, KNOWN_EVENTS } from './webhook.service';

const CreateSchema = z.object({
  url: z.string().url().max(500),
  events: z.array(z.string().max(64)).min(1).max(20),
});

@Controller('admin/v1/webhook-endpoints')
@UseGuards(JwtAuthGuard, PermGuard)
export class WebhooksController {
  constructor(private readonly service: WebhooksService) {}

  @Post()
  @RequirePerms('webhook:write')
  async create(@Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const tenantId = requireTenantId(req);
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError('REQ_INVALID', '请求参数不合法', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const result = await this.service.create(tenantId, parsed.data, actorFrom(req));
    void reply.code(201).send({ data: result }); // secret 仅此一次
  }

  @Get()
  @RequirePerms('webhook:write')
  async list(@Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const tenantId = requireTenantId(req);
    const data = await this.service.list(tenantId);
    void reply.code(200).send({ data });
  }

  @Post(':id/reset-breaker')
  @RequirePerms('webhook:write')
  async resetBreaker(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const tenantId = requireTenantId(req);
    await this.service.resetBreaker(tenantId, id, actorFrom(req));
    void reply.code(204).send();
  }

  @Post(':id/rotate-secret')
  @RequirePerms('webhook:write')
  async rotate(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const tenantId = requireTenantId(req);
    const result = await this.service.rotateSecret(tenantId, id, actorFrom(req));
    void reply.code(200).send({ data: result });
  }
}

void KNOWN_EVENTS;
