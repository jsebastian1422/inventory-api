import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadConfig } from './infrastructure/config/config.js';
import { AppModule } from './infrastructure/http/app.module.js';

async function bootstrap(): Promise<void> {
  // Validate configuration once, first: fail fast with a clear message.
  const config = loadConfig();
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register(config),
    new FastifyAdapter(),
  );
  app.enableShutdownHooks();
  await app.listen(config.port, config.host);
}

bootstrap().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
