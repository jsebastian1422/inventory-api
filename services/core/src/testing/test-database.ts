import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
export const testDbName = process.env.POSTGRES_TEST_DB ?? 'inventory_test';

/** Applies pending migrations (up only) to the TEST database and returns a pool on it. */
export function connectTestDatabase(): Pool {
  if (!testDbName.endsWith('_test')) throw new Error('POSTGRES_TEST_DB must end with _test');
  const env = { ...process.env, POSTGRES_DB: testDbName };
  execFileSync(
    process.execPath,
    ['node_modules/node-pg-migrate/bin/node-pg-migrate.js', 'up', '-f', 'migrate.config.cjs'],
    { cwd: root, env, stdio: 'pipe' },
  );
  return new Pool({
    host: process.env.POSTGRES_HOST,
    port: Number(process.env.POSTGRES_PORT),
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    database: testDbName,
  });
}
