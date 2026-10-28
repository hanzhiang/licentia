import { Module } from '@nestjs/common';
import { ApiKeysController } from './apikey.controller';
import { ApiKeysService } from './apikey.service';

@Module({
  controllers: [ApiKeysController],
  providers: [ApiKeysService],
})
export class ApiKeysModule {}
