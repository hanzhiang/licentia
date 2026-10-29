import { Body, Controller, Get, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '@lp/domain';
import { JwtAuthGuard, PermGuard, RequirePerms, requireTenantId } from '../../iam/guards';
import { actorFrom } from '../../iam/actor';
import { MAX_CODES_PER_MAIL, DeliveryService } from './delivery.service';

const DeliverSchema = z.object({
  /** 不传则回落到授权绑定的组织联系人邮箱 */
  to: z.string().email().max(200).nullish(),
  /** 仅批次交付: 单封邮件里的码数上限 */
  limit: z.number().int().min(1).max(MAX_CODES_PER_MAIL).optional(),
});

@Controller('admin/v1')
@UseGuards(JwtAuthGuard, PermGuard)
export class DeliveryController {
  constructor(private readonly service: DeliveryService) {}

  @Post('licenses/:id/deliver')
  @RequirePerms('license:issue')
  async deliverLicense(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const tenantId = requireTenantId(req);
    const parsed = DeliverSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new AppError('REQ_INVALID', '请求参数不合法');
    const data = await this.service.deliverLicense(
      tenantId,
      id,
      parsed.data.to ?? null,
      actorFrom(req),
    );
    void reply.code(200).send({ data });
  }

  @Post('batches/:id/deliver')
  @RequirePerms('license:issue')
  async deliverBatch(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const tenantId = requireTenantId(req);
    const parsed = DeliverSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new AppError('REQ_INVALID', '请求参数不合法');
    const data = await this.service.deliverBatch(
      tenantId,
      id,
      parsed.data.to ?? null,
      parsed.data.limit ?? MAX_CODES_PER_MAIL,
      actorFrom(req),
    );
    void reply.code(200).send({ data });
  }

  @Get('licenses/:id/deliveries')
  @RequirePerms('license:read')
  async listDeliveries(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const tenantId = requireTenantId(req);
    const data = await this.service.listForLicense(tenantId, id);
    void reply.code(200).send({ data });
  }
}
