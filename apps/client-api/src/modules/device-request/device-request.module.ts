import { Module } from '@nestjs/common';
import { DeviceRequestController, DeviceRequestPollController } from './device-request.controller';
import { DeviceRequestService } from './device-request.service';

@Module({
  controllers: [DeviceRequestController, DeviceRequestPollController],
  providers: [DeviceRequestService],
})
export class DeviceRequestModule {}
