import { Body, Controller, Get, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '@lp/domain';
import { JwtAuthGuard, PermGuard, RequirePerms, requireTenantId } from '../../iam/guards';
import { actorFrom } from '../../iam/actor';
import { DeviceRequestAdminService } from './devicerequest.service';

const ApproveSchema = z.object({ policy_id: z.string().uuid() });
const RejectSchema = z.object({ note: z.string().max(200).nullish() });

@Controller('admin/v1/device-requests')
@UseGuards(JwtAuthGuard, PermGuard)
export class DeviceRequestAdminController {
  constructor(private readonly service: DeviceRequestAdminService) {}

  @Get()
  @RequirePerms('license:read')
  async list(
    @Req() req: FastifyRequest,
    @Query('status') status: string | undefined,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const tenantId = requireTenantId(req);
    const data = await this.service.list(tenantId, status ?? 'pending');
    void reply.code(200).send({ data });
  }

  @Post(':id/approve')
  @RequirePerms('license:issue')
  async approve(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const tenantId = requireTenantId(req);
    const parsed = ApproveSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError('REQ_INVALID', '需要 policy_id');
    const data = await this.service.approve(
      tenantId,
      id,
      { policyId: parsed.data.policy_id },
      actorFrom(req),
    );
    void reply.code(200).send({ data });
  }

  @Post(':id/reject')
  @RequirePerms('license:issue')
  async reject(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const tenantId = requireTenantId(req);
    const parsed = RejectSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new AppError('REQ_INVALID', '请求参数不合法');
    await this.service.reject(tenantId, id, parsed.data.note ?? null, actorFrom(req));
    void reply.code(204).send();
  }
}
