import { Module } from '@nestjs/common';
import { DbModule } from './db.module';
import { RedisModule } from './redis.module';
import { SignerModule } from './signer.module';
import { ActivateModule } from './modules/activate/activate.module';
import { HeartbeatModule } from './modules/heartbeat/heartbeat.module';
import { DeviceRequestModule } from './modules/device-request/device-request.module';
import { HealthController } from './health.controller';
import { JwksController } from './jwks.controller';

@Module({
  imports: [DbModule, RedisModule, SignerModule, ActivateModule, HeartbeatModule, DeviceRequestModule],
  controllers: [HealthController, JwksController],
})
export class AppModule {}
