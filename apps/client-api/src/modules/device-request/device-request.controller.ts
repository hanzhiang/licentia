import { Body, Controller, Get, Param, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '@lp/domain';
import { DeviceRequestService } from './device-request.service';

const DeviceSchema = z.object({
  fp_type: z.enum(['install_id', 'openid', 'unionid', 'machine_id', 'account']),
  fingerprint: z.string().min(4).max(256),
  platform: z.enum([
    'wechat_miniapp',
    'android',
    'ios',
    'web',
    'windows',
    'macos',
    'linux',
    'server',
  ]),
});

/** 申请设备码: 客户端没有授权码时用 */
const CreateSchema = z.object({
  product_code: z.string().min(1).max(64),
  tenant_code: z.string().min(1).max(64).optional(),
  app_version: z.string().max(40).optional(),
  user_id: z.string().max(128).optional(),
  device: DeviceSchema,
});

/** 轮询: 必须带同样的设备指纹, 否则不能领取别人的授权 */
const PollSchema = z.object({
  device: DeviceSchema,
});

function clientIp(req: FastifyRequest): string | null {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0]!.trim();
  return req.ip ?? null;
}

@Controller('client/v1/device-requests')
export class DeviceRequestController {
  constructor(private readonly service: DeviceRequestService) {}

  @Post()
  async create(@Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError('REQ_INVALID', '请求参数不合法');
    const d = parsed.data;
    const data = await this.service.create(
      {
        productCode: d.product_code,
        tenantCode: d.tenant_code,
        appVersion: d.app_version,
        userId: d.user_id,
        device: { fpType: d.device.fp_type, fingerprint: d.device.fingerprint, platform: d.device.platform },
      },
      clientIp(req),
    );
    void reply.code(201).send({ data });
  }

  @Post(':code/poll')
  async poll(
    @Req() req: FastifyRequest,
    @Param('code') code: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = PollSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError('REQ_INVALID', '请求参数不合法');
    const data = await this.service.poll(code, {
      fpType: parsed.data.device.fp_type,
      fingerprint: parsed.data.device.fingerprint,
    });
    void reply.code(200).send({ data });
  }
}

/** 便捷: 允许用 GET 轮询(带查询参数), 便于简单客户端实现 */
@Controller('client/v1/device-requests')
export class DeviceRequestPollController {
  constructor(private readonly service: DeviceRequestService) {}

  @Get(':code')
  async poll(
    @Req() req: FastifyRequest,
    @Param('code') code: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const q = req.query as Record<string, string | undefined>;
    const parsed = PollSchema.safeParse({
      device: {
        fp_type: q.fp_type,
        fingerprint: q.fingerprint,
        platform: q.platform ?? 'windows',
      },
    });
    if (!parsed.success) throw new AppError('REQ_INVALID', '需要 fp_type 与 fingerprint');
    const data = await this.service.poll(code, {
      fpType: parsed.data.device.fp_type,
      fingerprint: parsed.data.device.fingerprint,
    });
    void reply.code(200).send({ data });
  }
}
