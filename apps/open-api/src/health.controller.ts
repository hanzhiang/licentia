import { Controller, Get } from '@nestjs/common';

@Controller()
export class HealthController {
  @Get('healthz')
  health(): { ok: boolean; service: string } {
    return { ok: true, service: 'open-api' };
  }
}
