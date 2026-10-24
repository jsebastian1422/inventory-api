export type ComponentState = 'up' | 'down';

export interface HealthStatus {
  readonly api: ComponentState;
  readonly database: ComponentState;
  readonly timestamp: string;
}

export function isHealthy(status: HealthStatus): boolean {
  return status.api === 'up' && status.database === 'up';
}
