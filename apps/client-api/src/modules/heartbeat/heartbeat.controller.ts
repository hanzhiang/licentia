import { Controller, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '@lp/domain';
import { HeartbeatService } from './heartbeat.service';

const HeartbeatSchema = z.object({
  // 组织许可的席位归属(设计文档 §12): user_id 仅用于席位 ZSET 成员(HMAC 后)
  context: z.object({ user_id: z.string().min(1).max(128) }).optional(),
  meta: z.record(z.unknown()).optional(),
});

@Controller()
export class HeartbeatController {
  constructor(private readonly service: HeartbeatService) {}

  @Post('client/v1/heartbeat')
  async heartbeat(@Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const parsed = HeartbeatSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new AppError('REQ_INVALID', '请求参数不合法');
    }
    const result = await this.service.heartbeat(
      req.headers.authorization,
      parsed.data.context ? { userId: parsed.data.context.user_id } : undefined,
    );
    void reply.code(200).send({ data: result });
  }
}
