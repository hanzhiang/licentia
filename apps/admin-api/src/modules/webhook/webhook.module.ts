import { Module } from '@nestjs/common';
import { WebhooksController } from './webhook.controller';
import { WebhooksService } from './webhook.service';

@Module({
  controllers: [WebhooksController],
  providers: [WebhooksService],
})
export class WebhooksModule {}
