import { Body, Controller, Get, Param, Patch, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '@lp/domain';
import { JwtAuthGuard, PermGuard, RequirePerms, requireTenantId } from '../../iam/guards';
import { actorFrom } from '../../iam/actor';
import { CatalogService } from './catalog.service';

const CodeSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, '仅允许小写字母、数字和连字符');

const ProductSchema = z.object({
  code: CodeSchema,
  name: z.string().min(1).max(100),
});

const ChannelSchema = ProductSchema;

const PolicySchema = z.object({
  product_id: z.string().uuid(),
  code: CodeSchema,
  name: z.string().min(1).max(100),
  kind: z.enum(['trial', 'standard', 'perpetual', 'subscription', 'floating']),
  duration_days: z.number().int().min(1).max(36500).nullable(),
  device_limit: z.number().int().min(1).max(100000),
  seat_limit: z.number().int().min(1).max(1000000).nullable(),
  concurrency_limit: z.number().int().min(1).max(1000000).nullable(),
  features: z.array(z.string().min(1).max(64)).min(1).max(100),
  offline_window_days: z.number().int().min(0).max(90),
  heartbeat_hours: z.number().int().min(1).max(168),
  grace_hours: z.number().int().min(0).max(720),
  activate_within_days: z.number().int().min(0).max(3650),
  allow_renewal: z.boolean(),
  renew_window_days: z.number().int().min(0).max(3650),
  min_version: z.string().max(40).nullable(),
});

/** 产品/渠道可改名与启停；编码不可变 */
const UpdateNameStatusSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    status: z.enum(['active', 'disabled']).optional(),
  })
  .refine((v) => v.name !== undefined || v.status !== undefined, {
    message: '至少提供 name 或 status',
  });

/** 策略可改字段；kind/product_id/code 不可变 */
const UpdatePolicySchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    status: z.enum(['active', 'disabled']).optional(),
    duration_days: z.number().int().min(1).max(36500).nullable().optional(),
    device_limit: z.number().int().min(1).max(100000).optional(),
    seat_limit: z.number().int().min(1).max(1000000).nullable().optional(),
    concurrency_limit: z.number().int().min(1).max(1000000).nullable().optional(),
    features: z.array(z.string().min(1).max(64)).min(1).max(100).optional(),
    offline_window_days: z.number().int().min(0).max(90).optional(),
    heartbeat_hours: z.number().int().min(1).max(168).optional(),
    grace_hours: z.number().int().min(0).max(720).optional(),
    activate_within_days: z.number().int().min(0).max(3650).optional(),
    allow_renewal: z.boolean().optional(),
    renew_window_days: z.number().int().min(0).max(3650).optional(),
    min_version: z.string().max(40).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: '至少提供一个字段' });

function parse<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('REQ_INVALID', '请求参数不合法', {
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
  }
  return parsed.data;
}

@Controller('admin/v1/catalog')
@UseGuards(JwtAuthGuard, PermGuard)
export class CatalogController {
  constructor(private readonly service: CatalogService) {}

  @Get()
  @RequirePerms('license:read')
  async list(@Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const tenantId = requireTenantId(req);
    void reply.code(200).send({ data: await this.service.list(tenantId) });
  }

  @Post('products')
  @RequirePerms('product:write')
  async createProduct(
    @Req() req: FastifyRequest,
    @Body() body: unknown,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const tenantId = requireTenantId(req);
    const cmd = parse(ProductSchema, body);
    const data = await this.service.createProduct(tenantId, cmd, actorFrom(req));
    void reply.code(201).send({ data });
  }

  @Post('channels')
  @RequirePerms('channel:write')
  async createChannel(
    @Req() req: FastifyRequest,
    @Body() body: unknown,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const tenantId = requireTenantId(req);
    const cmd = parse(ChannelSchema, body);
    const data = await this.service.createChannel(tenantId, cmd, actorFrom(req));
    void reply.code(201).send({ data });
  }

  @Post('policies')
  @RequirePerms('policy:write')
  async createPolicy(
    @Req() req: FastifyRequest,
    @Body() body: unknown,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const tenantId = requireTenantId(req);
    const p = parse(PolicySchema, body);
    const data = await this.service.createPolicy(
      tenantId,
      {
        productId: p.product_id,
        code: p.code,
        name: p.name,
        kind: p.kind,
        durationDays: p.duration_days,
        deviceLimit: p.device_limit,
        seatLimit: p.seat_limit,
        concurrencyLimit: p.concurrency_limit,
        features: p.features,
        offlineWindowDays: p.offline_window_days,
        heartbeatHours: p.heartbeat_hours,
        graceHours: p.grace_hours,
        activateWithinDays: p.activate_within_days,
        allowRenewal: p.allow_renewal,
        renewWindowDays: p.renew_window_days,
        minVersion: p.min_version,
      },
      actorFrom(req),
    );
    void reply.code(201).send({ data });
  }

  @Patch('products/:id')
  @RequirePerms('product:write')
  async updateProduct(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const tenantId = requireTenantId(req);
    const cmd = parse(UpdateNameStatusSchema, body);
    const data = await this.service.updateProduct(tenantId, id, cmd, actorFrom(req));
    void reply.code(200).send({ data });
  }

  @Patch('channels/:id')
  @RequirePerms('channel:write')
  async updateChannel(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const tenantId = requireTenantId(req);
    const cmd = parse(UpdateNameStatusSchema, body);
    const data = await this.service.updateChannel(tenantId, id, cmd, actorFrom(req));
    void reply.code(200).send({ data });
  }

  @Patch('policies/:id')
  @RequirePerms('policy:write')
  async updatePolicy(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const tenantId = requireTenantId(req);
    const p = parse(UpdatePolicySchema, body);
    const data = await this.service.updatePolicy(
      tenantId,
      id,
      {
        name: p.name,
        status: p.status,
        durationDays: p.duration_days,
        deviceLimit: p.device_limit,
        seatLimit: p.seat_limit,
        concurrencyLimit: p.concurrency_limit,
        features: p.features,
        offlineWindowDays: p.offline_window_days,
        heartbeatHours: p.heartbeat_hours,
        graceHours: p.grace_hours,
        activateWithinDays: p.activate_within_days,
        allowRenewal: p.allow_renewal,
        renewWindowDays: p.renew_window_days,
        minVersion: p.min_version,
      },
      actorFrom(req),
    );
    void reply.code(200).send({ data });
  }
}
