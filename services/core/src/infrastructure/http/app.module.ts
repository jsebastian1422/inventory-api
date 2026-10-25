import { Inject, Module, type DynamicModule, type OnApplicationShutdown } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import type { Pool } from 'pg';
import { AuthorizeUseCase } from '../../application/auth/authorize.use-case.js';
import { CheckHealthUseCase } from '../../application/health/check-health.use-case.js';
import { CategoryUseCases } from '../../application/categories/category.use-cases.js';
import { InventoryUseCases } from '../../application/inventories/inventory.use-cases.js';
import { InventoryLineUseCases } from '../../application/inventory-lines/inventory-line.use-cases.js';
import { ProductUseCases } from '../../application/products/product.use-cases.js';
import { EstablishmentUseCases } from '../../application/establishments/establishment.use-cases.js';
import { PostgresIdempotencyStore } from '../database/postgres-idempotency-store.js';
import { PostgresAccessReader } from '../database/postgres-access-reader.js';
import { PostgresCategoryRepository } from '../database/postgres-category-repository.js';
import { PostgresInventoryLineRepository } from '../database/postgres-inventory-line-repository.js';
import { PostgresInventoryRepository } from '../database/postgres-inventory-repository.js';
import { PostgresProductRepository } from '../database/postgres-product-repository.js';
import { PostgresEstablishmentRepository } from '../database/postgres-establishment-repository.js';
import { PostgresHealthCheck } from '../database/postgres-health-check.js';
import { createPool } from '../database/pool.js';
import type { AppConfig } from '../config/config.js';
import { AuthGuard } from './auth.guard.js';
import { AllExceptionsFilter } from './domain-exception.filter.js';
import { CategoriesController } from './categories.controller.js';
import { InventoriesController } from './inventories.controller.js';
import { InventoryLinesController } from './inventory-lines.controller.js';
import { ProductsController } from './products.controller.js';
import { EstablishmentsController } from './establishments.controller.js';
import { HealthController } from './health.controller.js';
import { NestAuditLog } from './nest-audit-log.js';
import {
  APP_CONFIG,
  AUDIT_LOG,
  AUTHORIZE_USE_CASE,
  CATEGORY_USE_CASES,
  CHECK_HEALTH_USE_CASE,
  DB_POOL,
  ESTABLISHMENT_USE_CASES,
  IDEMPOTENCY_STORE,
  INVENTORY_LINE_USE_CASES,
  INVENTORY_USE_CASES,
  PRODUCT_USE_CASES,
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
      controllers: [
        HealthController,
        EstablishmentsController,
        CategoriesController,
        ProductsController,
        InventoriesController,
        InventoryLinesController,
      ],
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
        {
          provide: CATEGORY_USE_CASES,
          useFactory: (pool: Pool) =>
            new CategoryUseCases(new PostgresCategoryRepository(pool), new NestAuditLog()),
          inject: [DB_POOL],
        },
        {
          provide: PRODUCT_USE_CASES,
          useFactory: (pool: Pool) =>
            new ProductUseCases(new PostgresProductRepository(pool), new NestAuditLog()),
          inject: [DB_POOL],
        },
        {
          provide: INVENTORY_USE_CASES,
          useFactory: (pool: Pool) =>
            new InventoryUseCases(new PostgresInventoryRepository(pool), new NestAuditLog()),
          inject: [DB_POOL],
        },
        {
          provide: INVENTORY_LINE_USE_CASES,
          useFactory: (pool: Pool) =>
            new InventoryLineUseCases(
              new PostgresInventoryLineRepository(pool),
              new PostgresInventoryRepository(pool),
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
