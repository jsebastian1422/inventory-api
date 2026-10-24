import type { DatabaseHealthCheck } from '../../domain/health/database-health-check.js';
import type { HealthStatus } from '../../domain/health/health-status.js';

export class CheckHealthUseCase {
  constructor(
    private readonly databaseHealthCheck: DatabaseHealthCheck,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(): Promise<HealthStatus> {
    const databaseUp = await this.databaseHealthCheck.isAvailable().catch(() => false);
    return {
      api: 'up',
      database: databaseUp ? 'up' : 'down',
      timestamp: this.now().toISOString(),
    };
  }
}
