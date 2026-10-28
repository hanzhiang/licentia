import { Controller, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '@lp/domain';
import { ActivateSchema } from './activate.dto';
import { ActivateService } from './activate.service';

@Controller()
export class ActivateController {
  constructor(private readonly service: ActivateService) {}

  @Post('client/v1/activate')
  async activate(@Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const parsed = ActivateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError('REQ_INVALID', '请求参数不合法', {
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }
    const d = parsed.data;
    const result = await this.service.activate({
      code: d.code,
      app: { productCode: d.app.product_code, version: d.app.version },
      device: {
        fpType: d.device.fp_type,
        fingerprint: d.device.fingerprint,
        platform: d.device.platform,
        meta: d.device.meta,
      },
      context: d.context ? { userId: d.context.user_id } : undefined,
    });
    void reply.code(result.replayed ? 200 : 201).send({ data: result });
  }
}
