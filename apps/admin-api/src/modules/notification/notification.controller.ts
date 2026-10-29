import { Controller, Get, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '@lp/domain';
import { JwtAuthGuard, PermGuard, RequirePerms, requireTenantId } from '../../iam/guards';
import { actorFrom } from '../../iam/actor';
import { NotificationService } from './notification.service';

const QuerySchema = z.object({
  status: z.string().max(20).optional(),
  channel: z.string().max(20).optional(),
  template_code: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

@Controller('admin/v1/notifications')
@UseGuards(JwtAuthGuard, PermGuard)
export class NotificationController {
  constructor(private readonly service: NotificationService) {}

  @Get()
  @RequirePerms('notify:read')
  async list(@Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const parsed = QuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      throw new AppError('REQ_INVALID', '请求参数不合法', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const data = await this.service.list(requireTenantId(req), parsed.data);
    void reply.code(200).send({ data });
  }

  @Post(':id/retry')
  @RequirePerms('notify:write')
  async retry(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.service.retry(requireTenantId(req), id, actorFrom(req));
    void reply.code(204).send();
  }
}
