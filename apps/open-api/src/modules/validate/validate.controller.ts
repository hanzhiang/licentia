import { Controller, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '@lp/domain';
import { ApiKeyGuard } from '../../apikey.guard';
import { ValidateService } from './validate.service';

const ValidateSchema = z.object({
  code: z.string().min(8).max(64),
  context: z.record(z.unknown()).optional(),
});

@Controller('open/v1')
@UseGuards(ApiKeyGuard)
export class ValidateController {
  constructor(private readonly service: ValidateService) {}

  @Post('validate')
  async validate(@Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const tenantId = (req as unknown as { tenantId: string }).tenantId;
    const parsed = ValidateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError('REQ_INVALID', '请求参数不合法', {
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }
    const result = await this.service.validate(tenantId, parsed.data.code);
    void reply.code(200).send({ data: result });
  }
}
