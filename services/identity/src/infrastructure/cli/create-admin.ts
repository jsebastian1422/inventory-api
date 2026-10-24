import { z } from 'zod';
import { CreateInitialAdminUseCase } from '../../application/auth/create-initial-admin.use-case.js';
import { DomainError } from '../../domain/shared/errors.js';
import { ConfigError, loadDatabaseConfig } from '../config/config.js';
import { createPool } from '../database/pool.js';
import { createRepositories } from '../http/composition.js';
import { NestAuditLog } from '../http/nest-audit-log.js';
import { Argon2PasswordHasher } from '../security/argon2-password-hasher.js';

const adminEnv = z.object({
  ADMIN_EMAIL: z.string().min(1),
  ADMIN_PASSWORD: z.string().min(1),
  ADMIN_FULL_NAME: z.string().default('Administrador'),
});

/** Creates the first administrator from ADMIN_EMAIL / ADMIN_PASSWORD. Never prints the password. */
async function main(): Promise<void> {
  const parsed = adminEnv.safeParse(process.env);
  if (!parsed.success) {
    const names = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new ConfigError(`Faltan variables de entorno requeridas: ${names}`);
  }
  const pool = createPool(loadDatabaseConfig());
  try {
    const repos = createRepositories(pool);
    const useCase = new CreateInitialAdminUseCase(
      repos.users,
      repos.roles,
      new Argon2PasswordHasher(),
      new NestAuditLog(),
    );
    const user = await useCase.execute({
      email: parsed.data.ADMIN_EMAIL,
      password: parsed.data.ADMIN_PASSWORD,
      fullName: parsed.data.ADMIN_FULL_NAME,
    });
    console.log(`Administrador creado: ${user.email} (id ${user.id})`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  if (error instanceof DomainError) {
    const details = error.details?.map((d) => d.message).join('; ');
    console.error(`Error: ${error.message}${details ? ` -> ${details}` : ''}`);
  } else {
    console.error(error instanceof Error ? `Error: ${error.message}` : 'Error inesperado');
  }
  process.exit(1);
});
