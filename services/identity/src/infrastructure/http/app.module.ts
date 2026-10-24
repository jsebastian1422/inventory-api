import { Inject, Module, type DynamicModule, type OnApplicationShutdown } from '@nestjs/common';
import { APP_GUARD, APP_FILTER } from '@nestjs/core';
import type { Pool } from 'pg';
import type { IdentityConfig } from '../config/config.js';
import { createPool } from '../database/pool.js';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { createUseCases } from './composition.js';
import { AllExceptionsFilter } from './domain-exception.filter.js';
import { HealthController } from './health.controller.js';
import { NestAuditLog } from './nest-audit-log.js';
import { RolesController } from './roles.controller.js';
import { APP_CONFIG, DB_POOL, USE_CASES } from './tokens.js';
import { UsersController } from './users.controller.js';

@Module({})
export class AppModule implements OnApplicationShutdown {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  /** The configuration is validated once by the caller and reused here (no second loadConfig). */
  static register(config: IdentityConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, AuthController, UsersController, RolesController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: DB_POOL, useFactory: (): Pool => createPool(config.database) },
        {
          provide: USE_CASES,
          useFactory: (pool: Pool) => createUseCases(config, pool, new NestAuditLog()),
          inject: [DB_POOL],
        },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
    };
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
