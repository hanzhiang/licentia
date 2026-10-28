import { Body, Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '@lp/domain';
import { JwtAuthGuard, currentUser } from '../../iam/guards';
import { AuthService } from './auth.service';

const LoginSchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(8).max(200),
});

const RefreshSchema = z.object({
  refresh_token: z.string().min(20).max(200),
});

const RegisterSchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(8).max(200),
  /** 开发者/团队名称，成为租户名 */
  developer_name: z.string().min(1).max(100),
});

function clientIp(req: FastifyRequest): string | null {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0]!.trim();
  return req.ip ?? null;
}

@Controller('admin/v1/auth')
export class AuthController {
  constructor(private readonly service: AuthService) {}

  @Post('login')
  async login(@Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError('REQ_INVALID', '请求参数不合法', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const result = await this.service.login(parsed.data.email, parsed.data.password, clientIp(req));
    void reply.code(200).send({ data: result });
  }

  @Post('register')
  async register(@Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const parsed = RegisterSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError('REQ_INVALID', '请求参数不合法', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const result = await this.service.register(
      {
        email: parsed.data.email,
        password: parsed.data.password,
        developerName: parsed.data.developer_name,
      },
      clientIp(req),
    );
    void reply.code(201).send({ data: result });
  }

  @Post('refresh')
  async refresh(@Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const parsed = RefreshSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError('REQ_INVALID', '缺少 refresh_token');
    const result = await this.service.refresh(parsed.data.refresh_token, clientIp(req));
    void reply.code(200).send({ data: result });
  }

  @Post('logout')
  async logout(@Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const parsed = RefreshSchema.safeParse(req.body);
    if (parsed.success) {
      await this.service.logout(parsed.data.refresh_token);
    }
    void reply.code(200).send({ data: { ok: true } });
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const data = await this.service.profile(currentUser(req).id);
    void reply.code(200).send({ data });
  }
}
