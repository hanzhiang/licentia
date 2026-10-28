import { Module } from '@nestjs/common';
import { DbModule } from './db.module';
import { RedisModule } from './redis.module';
import { ValidateModule } from './modules/validate/validate.module';
import { HealthController } from './health.controller';

@Module({
  imports: [DbModule, RedisModule, ValidateModule],
  controllers: [HealthController],
})
export class AppModule {}
