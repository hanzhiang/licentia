import { Module } from '@nestjs/common';
import { ActivateController } from './activate.controller';
import { ActivateService } from './activate.service';

@Module({
  controllers: [ActivateController],
  providers: [ActivateService],
})
export class ActivateModule {}
