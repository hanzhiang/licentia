import { Controller, Get, Patch, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '@lp/domain';
import { JwtAuthGuard, PermGuard, RequirePerms, requireTenantId } from '../../iam/guards';
import { actorFrom } from '../../iam/actor';
import { TenantService } from './tenant.service';

const PatchSchema = z.object({
  locale: z.enum(['zh-CN', 'en']),
  name: z.string().min(1).max(120).optional(),
});

@Controller('admin/v1/tenant')
@UseGuards(JwtAuthGuard, PermGuard)
export class TenantController {
  constructor(private readonly service: TenantService) {}

  @Get()
  @RequirePerms('tenant:read')
  async get(@Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const data = await this.service.get(requireTenantId(req));
    void reply.code(200).send({ data });
  }

  @Patch()
  @RequirePerms('tenant:write')
  async patch(@Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const parsed = PatchSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError('REQ_INVALID', '请求参数不合法', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const data = await this.service.updateLocale(
      requireTenantId(req),
      parsed.data.locale,
      actorFrom(req),
      parsed.data.name,
    );
    void reply.code(200).send({ data });
  }
}
