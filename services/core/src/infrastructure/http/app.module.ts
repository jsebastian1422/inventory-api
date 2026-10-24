import { Module, type OnApplicationShutdown } from '@nestjs/common';
import { CheckHealthUseCase } from '../../application/health/check-health.use-case.js';
import { PostgresHealthCheck } from '../database/postgres-health-check.js';
import { loadConfig, type AppConfig } from '../config/config.js';
import { HealthController } from './health.controller.js';
import { APP_CONFIG, CHECK_HEALTH_USE_CASE } from './tokens.js';

@Module({
  controllers: [HealthController],
  providers: [
    { provide: APP_CONFIG, useFactory: (): AppConfig => loadConfig() },
    {
      provide: PostgresHealthCheck,
      useFactory: (config: AppConfig) => new PostgresHealthCheck(config),
      inject: [APP_CONFIG],
    },
    {
      provide: CHECK_HEALTH_USE_CASE,
      useFactory: (db: PostgresHealthCheck) => new CheckHealthUseCase(db),
      inject: [PostgresHealthCheck],
    },
  ],
})
export class AppModule implements OnApplicationShutdown {
  constructor(private readonly db: PostgresHealthCheck) {}

  async onApplicationShutdown(): Promise<void> {
    await this.db.close();
  }
}
