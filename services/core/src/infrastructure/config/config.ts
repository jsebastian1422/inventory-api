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
  CORS_ORIGINS: z.string().optional(),
});

export type AppConfig = Omit<
  z.infer<typeof schema>,
  'JWT_PUBLIC_KEY' | 'JWT_PUBLIC_KEY_PATH' | 'CORS_ORIGINS'
> & {
  readonly publicKeyPem: string;
  /** Allowed browser origins; empty = CORS disabled. */
  readonly corsOrigins: readonly string[];
};

export class ConfigError extends Error {}

/**
 * Parses CORS_ORIGINS: comma-separated exact origins (`http(s)://host[:port]`, no path).
 * Empty or absent means no CORS. Throws a ConfigError naming the invalid origin.
 */
export function parseCorsOrigins(raw: string | undefined): string[] {
  const origins = (raw ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  for (const origin of origins) {
    let normalized: string | null = null;
    try {
      const url = new URL(origin);
      if (url.protocol === 'http:' || url.protocol === 'https:') normalized = url.origin;
    } catch {
      normalized = null;
    }
    if (normalized !== origin) {
      throw new ConfigError(
        `Invalid configuration. CORS_ORIGINS: "${origin}" is not a valid origin (use http(s)://host[:port] without path or trailing slash)`,
      );
    }
  }
  return origins;
}

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
  const { JWT_PUBLIC_KEY, JWT_PUBLIC_KEY_PATH, CORS_ORIGINS, ...rest } = result.data;
  return {
    ...rest,
    corsOrigins: parseCorsOrigins(CORS_ORIGINS),
    publicKeyPem: resolvePublicKey(JWT_PUBLIC_KEY, JWT_PUBLIC_KEY_PATH, readFile),
  };
}
