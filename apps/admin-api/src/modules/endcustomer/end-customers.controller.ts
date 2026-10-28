import { Controller, Get, Param, Put, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '@lp/domain';
import { JwtAuthGuard, PermGuard, RequirePerms, requireTenantId } from '../../iam/guards';
import { actorFrom } from '../../iam/actor';
import { EndCustomersService, parseEmailOrThrow } from './end-customers.service';

const ContactSchema = z.object({
  email: z.string().max(200).nullable(),
});

@Controller('admin/v1/end-customers')
@UseGuards(JwtAuthGuard, PermGuard)
export class EndCustomersController {
  constructor(private readonly service: EndCustomersService) {}

  @Get()
  @RequirePerms('license:read')
  async list(@Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const tenantId = requireTenantId(req);
    void reply.code(200).send({ data: await this.service.list(tenantId) });
  }

  @Put(':id/contact-email')
  @RequirePerms('end_customer:write')
  async setContact(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const tenantId = requireTenantId(req);
    const parsed = ContactSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError('REQ_INVALID', '请求参数不合法');
    }
    await this.service.setContactEmail(tenantId, id, parseEmailOrThrow(parsed.data.email), actorFrom(req));
    void reply.code(204).send();
  }
}
