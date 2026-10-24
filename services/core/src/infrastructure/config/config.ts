import { readFileSync } from 'node:fs';
import { z } from 'zod';

const schema = z.object({
  API_PORT: z.coerce.number().int().min(1).max(65535),
  API_HOST: z.string().min(1).default('0.0.0.0'),
  POSTGRES_HOST: z.string().min(1),
  POSTGRES_PORT: z.coerce.number().int().min(1).max(65535),
  POSTGRES_USER: z.string().min(1),
  POSTGRES_PASSWORD: z.string().min(1),
  POSTGRES_DB: z.string().min(1),
  // Core only verifies tokens: it never receives the private key.
  JWT_PUBLIC_KEY: z.string().min(1).optional(),
  JWT_PUBLIC_KEY_PATH: z.string().min(1).optional(),
});

export type AppConfig = Omit<z.infer<typeof schema>, 'JWT_PUBLIC_KEY' | 'JWT_PUBLIC_KEY_PATH'> & {
  readonly publicKeyPem: string;
};

export class ConfigError extends Error {}

type ReadFile = (path: string) => string;

function resolvePublicKey(
  inline: string | undefined,
  path: string | undefined,
  readFile: ReadFile,
): string {
  if (inline) return inline.replace(/\\n/g, '\n');
  if (path) {
    try {
      return readFile(path);
    } catch {
      throw new ConfigError(
        `Invalid configuration. JWT_PUBLIC_KEY_PATH: cannot read the file "${path}"`,
      );
    }
  }
  throw new ConfigError(
    'Invalid configuration. Check environment variables -> JWT_PUBLIC_KEY or JWT_PUBLIC_KEY_PATH is required',
  );
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  readFile: ReadFile = (path) => readFileSync(path, 'utf8'),
): AppConfig {
  const result = schema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(`Invalid configuration. Check environment variables -> ${problems}`);
  }
  const { JWT_PUBLIC_KEY, JWT_PUBLIC_KEY_PATH, ...rest } = result.data;
  return {
    ...rest,
    publicKeyPem: resolvePublicKey(JWT_PUBLIC_KEY, JWT_PUBLIC_KEY_PATH, readFile),
  };
}
