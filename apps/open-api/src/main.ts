import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { AllExceptionsFilter, installMetrics } from '@lp/http';
import { getConfig } from '@lp/config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, new FastifyAdapter({
    genReqId: () => randomUUID(),
    trustProxy: true,
  }));
  app.useGlobalFilters(new AllExceptionsFilter());
  installMetrics(app.getHttpAdapter().getInstance() as never);
  const port = getConfig().PORT_OPEN;
  await app.listen(port, '0.0.0.0');
  console.log(`[open-api] listening on :${port}`);
}

void bootstrap();
