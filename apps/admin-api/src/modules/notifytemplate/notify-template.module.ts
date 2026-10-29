import { Module } from '@nestjs/common';
import { NotifyTemplateController } from './notify-template.controller';
import { NotifyTemplateService } from './notify-template.service';

@Module({
  controllers: [NotifyTemplateController],
  providers: [NotifyTemplateService],
})
export class NotifyTemplatesModule {}
