import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from '@lp/http';
import { getConfig } from '@lp/config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, new FastifyAdapter({
    genReqId: () => randomUUID(),
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  }));
  app.useGlobalFilters(new AllExceptionsFilter());
  const port = getConfig().PORT_CLIENT;
  await app.listen(port, '0.0.0.0');
  console.log(`[client-api] listening on :${port}`);
}

void bootstrap();
