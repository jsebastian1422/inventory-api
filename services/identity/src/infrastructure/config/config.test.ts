import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, loadDatabaseConfig } from './config.js';

const valid = {
  POSTGRES_HOST: 'localhost',
  POSTGRES_PORT: '5432',
  POSTGRES_USER: 'u',
  POSTGRES_PASSWORD: 'p',
  POSTGRES_DB: 'd',
  JWT_PRIVATE_KEY: 'PRIVATE\\nPEM',
  JWT_PUBLIC_KEY_PATH: '/keys/pub.pem',
};
const readFile = (path: string) => `content of ${path}`;

describe('identity loadConfig', () => {
  it('applies defaults and resolves inline and file keys', () => {
    const config = loadConfig(valid, readFile);
    expect(config.port).toBe(3001);
    expect(config.accessTokenTtlSeconds).toBe(900);
    expect(config.refreshTokenTtlSeconds).toBe(7 * 86400);
    expect(config.privateKeyPem).toBe('PRIVATE\nPEM');
    expect(config.publicKeyPem).toBe('content of /keys/pub.pem');
  });

  it('names the missing variable', () => {
    const { POSTGRES_DB: _omit, ...rest } = valid;
    expect(() => loadConfig(rest, readFile)).toThrow(/POSTGRES_DB/);
  });

  it('requires the signing keys', () => {
    const { JWT_PRIVATE_KEY: _omit, ...rest } = valid;
    expect(() => loadConfig(rest, readFile)).toThrow(/JWT_PRIVATE_KEY/);
  });

  it('reports unreadable key files without leaking content', () => {
    const failing = () => {
      throw new Error('ENOENT');
    };
    expect(() => loadConfig({ ...valid, JWT_PUBLIC_KEY_PATH: '/x' }, failing)).toThrow(ConfigError);
  });

  it('validates ports and durations', () => {
    expect(() => loadConfig({ ...valid, IDENTITY_API_PORT: '70000' }, readFile)).toThrow(
      /IDENTITY_API_PORT/,
    );
    expect(() => loadConfig({ ...valid, ACCESS_TOKEN_TTL: '15 minutes' }, readFile)).toThrow(
      /ACCESS_TOKEN_TTL/,
    );
  });

  it('loads database settings alone', () => {
    expect(loadDatabaseConfig(valid).database).toBe('d');
  });
});

describe('identity CORS_ORIGINS', () => {
  it('is empty when absent and parses exact origins', () => {
    expect(loadConfig(valid, readFile).corsOrigins).toEqual([]);
    expect(
      loadConfig({ ...valid, CORS_ORIGINS: 'http://localhost:5173,https://a.com' }, readFile)
        .corsOrigins,
    ).toEqual(['http://localhost:5173', 'https://a.com']);
  });

  it.each(['localhost:5173', 'http://x.com/path', '*', 'ftp://x.com'])(
    'fails naming CORS_ORIGINS for %j',
    (origin) => {
      expect(() => loadConfig({ ...valid, CORS_ORIGINS: origin }, readFile)).toThrow(
        /CORS_ORIGINS/,
      );
    },
  );
});
