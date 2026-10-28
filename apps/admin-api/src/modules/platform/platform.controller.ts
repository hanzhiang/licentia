import { Controller, Get, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { JwtAuthGuard, PermGuard, RequirePerms } from '../../iam/guards';
import { actorFrom } from '../../iam/actor';
import { PlatformService } from './platform.service';

/**
 * 平台后台的唯一入口: 开发者账号的列表/详情/停用/恢复。
 * 这里没有、也不应有任何租户业务路由(授权码、产品、终端客户…)。
 */
@Controller('platform/v1/developers')
@UseGuards(JwtAuthGuard, PermGuard)
export class PlatformController {
  constructor(private readonly service: PlatformService) {}

  @Get()
  @RequirePerms('platform:developer:read')
  async list(@Res() reply: FastifyReply): Promise<void> {
    void reply.code(200).send({ data: await this.service.listDevelopers() });
  }

  @Get(':id')
  @RequirePerms('platform:developer:read')
  async get(@Param('id') id: string, @Res() reply: FastifyReply): Promise<void> {
    void reply.code(200).send({ data: await this.service.getDeveloper(id) });
  }

  @Post(':id/suspend')
  @RequirePerms('platform:developer:suspend')
  async suspend(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.service.setStatus(id, 'suspended', actorFrom(req));
    void reply.code(204).send();
  }

  @Post(':id/resume')
  @RequirePerms('platform:developer:suspend')
  async resume(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.service.setStatus(id, 'active', actorFrom(req));
    void reply.code(204).send();
  }
}
