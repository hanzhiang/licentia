import { Module } from '@nestjs/common';
import { ActivationsController } from './activation.controller';
import { ActivationsService } from './activation.service';

@Module({
  controllers: [ActivationsController],
  providers: [ActivationsService],
})
export class ActivationsModule {}
