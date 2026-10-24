/** Port: reports whether the database is reachable. Must never throw. */
export interface DatabaseHealthCheck {
  isAvailable(): Promise<boolean>;
}
