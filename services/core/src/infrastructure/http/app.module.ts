import { Module, type DynamicModule, type OnApplicationShutdown } from '@nestjs/common';
import { CheckHealthUseCase } from '../../application/health/check-health.use-case.js';
import { PostgresHealthCheck } from '../database/postgres-health-check.js';
import type { AppConfig } from '../config/config.js';
import { HealthController } from './health.controller.js';
import { APP_CONFIG, CHECK_HEALTH_USE_CASE } from './tokens.js';

@Module({})
export class AppModule implements OnApplicationShutdown {
  constructor(private readonly db: PostgresHealthCheck) {}

  /** The configuration is validated once by the caller and reused here (no second loadConfig). */
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
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
      ],
    };
  }

  async onApplicationShutdown(): Promise<void> {
    await this.db.close();
  }
}
