import { Body, Controller, Get, Param, Patch, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '@lp/domain';
import { JwtAuthGuard, PermGuard, RequirePerms, requireTenantId } from '../../iam/guards';
import { actorFrom } from '../../iam/actor';
import { passwordField, refinePassword } from '../password-field';
import { MEMBER_ROLES, MemberService, type MemberRole } from './member.service';

const CreateSchema = z
  .object({
    email: z.string().email().max(200),
    password: passwordField(),
    role: z.enum(MEMBER_ROLES),
    /** 仅渠道角色(developer_partner)需要, 且必须是本租户的渠道 */
    channel_id: z.string().uuid().nullish(),
  })
  .superRefine((v, ctx) => refinePassword(v.password, ctx, { email: v.email }));

const ResetPasswordSchema = z
  .object({ password: passwordField() })
  .superRefine((v, ctx) => refinePassword(v.password, ctx));

const UpdateSchema = z.object({
  role: z.enum(MEMBER_ROLES).optional(),
  status: z.enum(['active', 'disabled']).optional(),
});

@Controller('admin/v1/members')
@UseGuards(JwtAuthGuard, PermGuard)
export class MemberController {
  constructor(private readonly service: MemberService) {}

  @Get()
  @RequirePerms('member:read')
  async list(@Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const tenantId = requireTenantId(req);
    void reply.code(200).send({ data: await this.service.list(tenantId) });
  }

  @Post()
  @RequirePerms('member:write')
  async create(@Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const tenantId = requireTenantId(req);
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError('REQ_INVALID', '请求参数不合法', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const data = await this.service.create(
      tenantId,
      {
        email: parsed.data.email,
        password: parsed.data.password,
        role: parsed.data.role as MemberRole,
        channelId: parsed.data.channel_id ?? null,
      },
      actorFrom(req),
    );
    void reply.code(201).send({ data });
  }

  @Patch(':id')
  @RequirePerms('member:write')
  async update(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const tenantId = requireTenantId(req);
    const parsed = UpdateSchema.safeParse(req.body);
    if (!parsed.success || (!parsed.data.role && !parsed.data.status)) {
      throw new AppError('REQ_INVALID', '需要提供 role 或 status');
    }
    await this.service.update(
      tenantId,
      id,
      {
        role: parsed.data.role as MemberRole | undefined,
        status: parsed.data.status,
      },
      actorFrom(req),
    );
    void reply.code(204).send();
  }

  @Post(':id/reset-password')
  @RequirePerms('member:write')
  async resetPassword(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const tenantId = requireTenantId(req);
    const parsed = ResetPasswordSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError('REQ_INVALID', '密码至少 8 位');
    await this.service.resetPassword(tenantId, id, parsed.data.password, actorFrom(req));
    void reply.code(204).send();
  }
}
