/** Port: application log for authentication and administration events. Never pass secrets. */
export interface AuditLog {
  info(event: string, data: Record<string, unknown>): void;
  warn(event: string, data: Record<string, unknown>): void;
}
