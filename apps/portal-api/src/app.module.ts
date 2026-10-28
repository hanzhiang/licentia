import { Module } from '@nestjs/common';
import { DbModule } from './db.module';
import { RedisModule } from './redis.module';
import { PortalController } from './portal.controller';
import { OtpService } from './otp.service';
import { PortalLicenseService } from './license.service';

@Module({
  imports: [DbModule, RedisModule],
  controllers: [PortalController],
  providers: [OtpService, PortalLicenseService],
})
export class AppModule {}
