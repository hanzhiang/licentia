import { Body, Controller, Get, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '@lp/domain';
import { JwtAuthGuard, PermGuard, RequirePerms, requireTenantId } from '../../iam/guards';
import { actorFrom } from '../../iam/actor';
import { ActivationsService } from './activation.service';

const ReleaseSchema = z.object({
  reason: z.string().min(1).max(200),
});

@Controller('admin/v1')
@UseGuards(JwtAuthGuard, PermGuard)
export class ActivationsController {
  constructor(private readonly service: ActivationsService) {}

  @Get('licenses/:id/activations')
  @RequirePerms('license:read')
  async list(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const tenantId = requireTenantId(req);
    const data = await this.service.listByLicense(tenantId, id);
    void reply.code(200).send({ data });
  }

  @Post('activations/:id/release')
  @RequirePerms('device:release')
  async release(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const tenantId = requireTenantId(req);
    const parsed = ReleaseSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError('REQ_INVALID', '请填写解绑原因(必填, 进入审计)');
    }
    const data = await this.service.release(tenantId, id, parsed.data, actorFrom(req));
    void reply.code(200).send({ data });
  }
}
