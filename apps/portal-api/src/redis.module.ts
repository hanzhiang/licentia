import { Global, Module, OnApplicationShutdown } from '@nestjs/common';
import { createRedis, type Redis } from '@lp/cache';
import { getConfig } from '@lp/config';

export const REDIS = Symbol('REDIS');

let instance: Redis | undefined;

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      useFactory: () => (instance = createRedis(getConfig().REDIS_URL)),
    },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> {
    void instance?.quit();
    instance = undefined;
  }
}
