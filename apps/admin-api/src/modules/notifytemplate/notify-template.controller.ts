import { Controller, Delete, Get, Param, Post, Put, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '@lp/domain';
import { JwtAuthGuard, PermGuard, RequirePerms, requireTenantId } from '../../iam/guards';
import { actorFrom } from '../../iam/actor';
import { NotifyTemplateService } from './notify-template.service';

const SaveSchema = z.object({
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(8000),
  sms_body: z.string().max(500).nullish(),
});

const PreviewSchema = z.object({
  vars: z.record(z.string().max(500)).optional(),
});

@Controller('admin/v1/notify-templates')
@UseGuards(JwtAuthGuard, PermGuard)
export class NotifyTemplateController {
  constructor(private readonly service: NotifyTemplateService) {}

  @Get()
  @RequirePerms('notify:read')
  async list(@Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const data = await this.service.list(requireTenantId(req));
    void reply.code(200).send({ data });
  }

  @Put(':code/:locale')
  @RequirePerms('notify:write')
  async save(
    @Req() req: FastifyRequest,
    @Param('code') code: string,
    @Param('locale') locale: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = SaveSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError('REQ_INVALID', '请求参数不合法', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const data = await this.service.upsert(
      requireTenantId(req),
      code,
      locale,
      parsed.data,
      actorFrom(req),
    );
    void reply.code(200).send({ data });
  }

  @Delete(':code/:locale')
  @RequirePerms('notify:write')
  async reset(
    @Req() req: FastifyRequest,
    @Param('code') code: string,
    @Param('locale') locale: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.service.reset(requireTenantId(req), code, locale, actorFrom(req));
    void reply.code(204).send();
  }

  @Post(':code/:locale/preview')
  @RequirePerms('notify:read')
  async preview(
    @Req() req: FastifyRequest,
    @Param('code') code: string,
    @Param('locale') locale: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = PreviewSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new AppError('REQ_INVALID', '请求参数不合法');
    const data = await this.service.preview(
      requireTenantId(req),
      code,
      locale,
      parsed.data.vars,
    );
    void reply.code(200).send({ data });
  }
}
