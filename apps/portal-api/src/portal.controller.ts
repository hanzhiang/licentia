import { Body, Controller, Get, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '@lp/domain';
import { getConfig } from '@lp/config';
import { PortalAuthGuard, portalCtx } from './portal.guard';
import { OtpService } from './otp.service';
import { PortalLicenseService } from './license.service';

const PhoneSchema = z.object({
  phone: z.string().regex(/^\d{6,20}$/, '手机号格式错误'),
  tenant_id: z.string().uuid().optional(),
});

const VerifySchema = z.object({
  phone: z.string().regex(/^\d{6,20}$/),
  code: z.string().regex(/^\d{6}$/, '验证码为 6 位数字'),
  tenant_id: z.string().uuid().optional(),
});

const ActivateOrgSchema = z.object({
  code: z.string().min(8).max(64),
  org_name: z.string().min(1).max(100),
});

const ReleaseSchema = z.object({
  reason: z.string().min(1).max(200),
});

function tenantOf(bodyTenantId: string | undefined): string {
  return bodyTenantId ?? getConfig().PORTAL_DEV_TENANT_ID;
}

@Controller('portal/v1')
export class PortalController {
  constructor(
    private readonly otp: OtpService,
    private readonly licenses: PortalLicenseService,
  ) {}

  @Get('healthz')
  health(): { ok: boolean; service: string } {
    return { ok: true, service: 'portal-api' };
  }

  @Post('auth/otp/request')
  async requestOtp(@Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const parsed = PhoneSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError('REQ_INVALID', '请求参数不合法', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const result = await this.otp.requestOtp(
      parsed.data.phone,
      tenantOf(parsed.data.tenant_id),
    );
    void reply.code(200).send({ data: result });
  }

  @Post('auth/otp/verify')
  async verifyOtp(@Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const parsed = VerifySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError('REQ_INVALID', '请求参数不合法');
    }
    const result = await this.otp.verifyOtp(
      parsed.data.phone,
      parsed.data.code,
      tenantOf(parsed.data.tenant_id),
    );
    void reply.code(200).send({ data: result });
  }

  @Post('licenses/activate-org')
  @UseGuards(PortalAuthGuard)
  async activateOrg(@Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const { phoneHash, tenantId } = portalCtx(req);
    const parsed = ActivateOrgSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError('REQ_INVALID', '请求参数不合法');
    }
    const result = await this.licenses.activateOrg(
      tenantId,
      Buffer.from(phoneHash, 'base64url'),
      parsed.data.code,
      parsed.data.org_name,
    );
    void reply.code(result.replayed ? 200 : 201).send({ data: result });
  }

  @Get('licenses')
  @UseGuards(PortalAuthGuard)
  async myLicenses(@Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const { phoneHash, tenantId } = portalCtx(req);
    const data = await this.licenses.myLicenses(
      tenantId,
      Buffer.from(phoneHash, 'base64url'),
    );
    void reply.code(200).send({ data });
  }

  @Get('licenses/:id/devices')
  @UseGuards(PortalAuthGuard)
  async devices(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const { phoneHash, tenantId } = portalCtx(req);
    const data = await this.licenses.licenseDevices(
      tenantId,
      Buffer.from(phoneHash, 'base64url'),
      id,
    );
    void reply.code(200).send({ data });
  }

  @Post('activations/:id/release')
  @UseGuards(PortalAuthGuard)
  async release(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const { phoneHash, tenantId } = portalCtx(req);
    const parsed = ReleaseSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError('REQ_INVALID', '请填写换机原因');
    const data = await this.licenses.releaseDevice(
      tenantId,
      Buffer.from(phoneHash, 'base64url'),
      id,
      parsed.data.reason,
    );
    void reply.code(200).send({ data });
  }
}
