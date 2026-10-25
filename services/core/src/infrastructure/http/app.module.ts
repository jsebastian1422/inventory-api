import { Inject, Module, type DynamicModule, type OnApplicationShutdown } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import type { Pool } from 'pg';
import { AuthorizeUseCase } from '../../application/auth/authorize.use-case.js';
import { CheckHealthUseCase } from '../../application/health/check-health.use-case.js';
import { EstablishmentUseCases } from '../../application/establishments/establishment.use-cases.js';
import { PostgresIdempotencyStore } from '../database/postgres-idempotency-store.js';
import { PostgresAccessReader } from '../database/postgres-access-reader.js';
import { PostgresEstablishmentRepository } from '../database/postgres-establishment-repository.js';
import { PostgresHealthCheck } from '../database/postgres-health-check.js';
import { createPool } from '../database/pool.js';
import type { AppConfig } from '../config/config.js';
import { AuthGuard } from './auth.guard.js';
import { AllExceptionsFilter } from './domain-exception.filter.js';
import { EstablishmentsController } from './establishments.controller.js';
import { HealthController } from './health.controller.js';
import { NestAuditLog } from './nest-audit-log.js';
import {
  APP_CONFIG,
  AUDIT_LOG,
  AUTHORIZE_USE_CASE,
  CHECK_HEALTH_USE_CASE,
  DB_POOL,
  ESTABLISHMENT_USE_CASES,
  IDEMPOTENCY_STORE,
} from './tokens.js';

@Module({})
export class AppModule implements OnApplicationShutdown {
  constructor(
    @Inject(PostgresHealthCheck) private readonly db: PostgresHealthCheck,
    @Inject(DB_POOL) private readonly pool: Pool,
  ) {}

  /** The configuration is validated once by the caller and reused here (no second loadConfig). */
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, EstablishmentsController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: DB_POOL, useFactory: (): Pool => createPool(config) },
        {
          provide: PostgresHealthCheck,
          useFactory: (appConfig: AppConfig) => new PostgresHealthCheck(appConfig),
          inject: [APP_CONFIG],
        },
        {
          provide: CHECK_HEALTH_USE_CASE,
          useFactory: (db: PostgresHealthCheck) => new CheckHealthUseCase(db),
          inject: [PostgresHealthCheck],
        },
        {
          provide: AUTHORIZE_USE_CASE,
          useFactory: (pool: Pool) => new AuthorizeUseCase(new PostgresAccessReader(pool)),
          inject: [DB_POOL],
        },
        {
          provide: ESTABLISHMENT_USE_CASES,
          useFactory: (pool: Pool) =>
            new EstablishmentUseCases(
              new PostgresEstablishmentRepository(pool),
              new NestAuditLog(),
            ),
          inject: [DB_POOL],
        },
        { provide: AUDIT_LOG, useFactory: () => new NestAuditLog() },
        {
          provide: IDEMPOTENCY_STORE,
          useFactory: (pool: Pool) => new PostgresIdempotencyStore(pool),
          inject: [DB_POOL],
        },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
    };
  }

  async onApplicationShutdown(): Promise<void> {
    await this.db.close();
    await this.pool.end();
  }
}
