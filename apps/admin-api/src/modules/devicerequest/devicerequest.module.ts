import { Module } from '@nestjs/common';
import { DeviceRequestAdminController } from './devicerequest.controller';
import { DeviceRequestAdminService } from './devicerequest.service';

@Module({
  controllers: [DeviceRequestAdminController],
  providers: [DeviceRequestAdminService],
})
export class DeviceRequestAdminModule {}
