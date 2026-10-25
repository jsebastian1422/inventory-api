import { readFileSync } from 'node:fs';
import { z } from 'zod';

const port = z.coerce.number().int().min(1).max(65535);

const databaseSchema = z.object({
  POSTGRES_HOST: z.string().min(1),
  POSTGRES_PORT: port,
  POSTGRES_USER: z.string().min(1),
  POSTGRES_PASSWORD: z.string().min(1),
  POSTGRES_DB: z.string().min(1),
});

const duration = z
  .string()
  .regex(/^\d+[smhd]$/, 'use a number followed by s, m, h or d (for example 15m, 7d)');

const schema = databaseSchema.extend({
  IDENTITY_API_PORT: port.default(3001),
  API_HOST: z.string().min(1).default('0.0.0.0'),
  JWT_PRIVATE_KEY: z.string().min(1).optional(),
  JWT_PRIVATE_KEY_PATH: z.string().min(1).optional(),
  JWT_PUBLIC_KEY: z.string().min(1).optional(),
  JWT_PUBLIC_KEY_PATH: z.string().min(1).optional(),
  ACCESS_TOKEN_TTL: duration.default('15m'),
  REFRESH_TOKEN_TTL: duration.default('7d'),
  CORS_ORIGINS: z.string().optional(),
});

export interface DatabaseConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
}

export interface IdentityConfig {
  readonly port: number;
  readonly host: string;
  readonly database: DatabaseConfig;
  readonly privateKeyPem: string;
  readonly publicKeyPem: string;
  readonly accessTokenTtlSeconds: number;
  readonly refreshTokenTtlSeconds: number;
  /** Allowed browser origins; empty = CORS disabled. */
  readonly corsOrigins: readonly string[];
}

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

function describe(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
}

export function toSeconds(value: string): number {
  const amount = Number(value.slice(0, -1));
  const unit = { s: 1, m: 60, h: 3600, d: 86400 }[value.slice(-1) as 's' | 'm' | 'h' | 'd'];
  return amount * unit;
}

function toDatabaseConfig(env: z.infer<typeof databaseSchema>): DatabaseConfig {
  return {
    host: env.POSTGRES_HOST,
    port: env.POSTGRES_PORT,
    user: env.POSTGRES_USER,
    password: env.POSTGRES_PASSWORD,
    database: env.POSTGRES_DB,
  };
}

/** Database settings only (used by the admin CLI, which does not need the JWT keys). */
export function loadDatabaseConfig(env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  const result = databaseSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(
      `Invalid configuration. Check environment variables -> ${describe(result.error)}`,
    );
  }
  return toDatabaseConfig(result.data);
}

function resolvePem(
  inline: string | undefined,
  path: string | undefined,
  name: string,
  readFile: ReadFile,
): string {
  if (inline) return inline.replace(/\\n/g, '\n');
  if (path) {
    try {
      return readFile(path);
    } catch {
      throw new ConfigError(`Invalid configuration. ${name}_PATH: cannot read the file "${path}"`);
    }
  }
  throw new ConfigError(
    `Invalid configuration. Check environment variables -> ${name} or ${name}_PATH is required`,
  );
}

/** Validates the whole environment. Call it once per process start and reuse the result. */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  readFile: ReadFile = (path) => readFileSync(path, 'utf8'),
): IdentityConfig {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(
      `Invalid configuration. Check environment variables -> ${describe(result.error)}`,
    );
  }
  const data = result.data;
  return {
    port: data.IDENTITY_API_PORT,
    host: data.API_HOST,
    database: toDatabaseConfig(data),
    privateKeyPem: resolvePem(
      data.JWT_PRIVATE_KEY,
      data.JWT_PRIVATE_KEY_PATH,
      'JWT_PRIVATE_KEY',
      readFile,
    ),
    publicKeyPem: resolvePem(
      data.JWT_PUBLIC_KEY,
      data.JWT_PUBLIC_KEY_PATH,
      'JWT_PUBLIC_KEY',
      readFile,
    ),
    accessTokenTtlSeconds: toSeconds(data.ACCESS_TOKEN_TTL),
    refreshTokenTtlSeconds: toSeconds(data.REFRESH_TOKEN_TTL),
    corsOrigins: parseCorsOrigins(data.CORS_ORIGINS),
  };
}
