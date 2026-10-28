import { Global, Module, OnApplicationShutdown } from '@nestjs/common';
import { Kysely } from 'kysely';
import { createDb, type LpDb } from '@lp/db';
import { getConfig } from '@lp/config';

export const DB = Symbol('DB');

let instance: Kysely<LpDb> | undefined;

@Global()
@Module({
  providers: [
    {
      provide: DB,
      useFactory: () => (instance = createDb(getConfig().DATABASE_URL)),
    },
  ],
  exports: [DB],
})
export class DbModule implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> {
    await instance?.destroy();
    instance = undefined;
  }
}
