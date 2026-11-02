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

describe('identity session, throttling and mail settings', () => {
  it('has secure defaults', () => {
    const config = loadConfig(valid, readFile);
    expect(config.sessionCookieSecure).toBe(true);
    expect(config.loginMaxAttemptsEmail).toBe(5);
    expect(config.loginMaxAttemptsIp).toBe(20);
    expect(config.loginAttemptWindowSeconds).toBe(900);
    expect(config.passwordResetTtlSeconds).toBe(1800);
    expect(config.smtp).toBeNull();
    expect(config.webAppUrl).toBeNull();
  });

  it('reads overrides from the environment', () => {
    const config = loadConfig(
      {
        ...valid,
        SESSION_COOKIE_SECURE: 'false',
        LOGIN_MAX_ATTEMPTS_EMAIL: '2',
        LOGIN_ATTEMPT_WINDOW: '1m',
        PASSWORD_RESET_TTL: '10m',
        WEB_APP_URL: 'http://localhost:5173/',
        SMTP_HOST: 'localhost',
        SMTP_PORT: '1025',
        SMTP_FROM: 'Inventario <no-reply@example.test>',
      },
      readFile,
    );
    expect(config.sessionCookieSecure).toBe(false);
    expect(config.loginMaxAttemptsEmail).toBe(2);
    expect(config.loginAttemptWindowSeconds).toBe(60);
    expect(config.passwordResetTtlSeconds).toBe(600);
    expect(config.webAppUrl).toBe('http://localhost:5173');
    expect(config.smtp).toEqual({
      host: 'localhost',
      port: 1025,
      from: 'Inventario <no-reply@example.test>',
    });
  });

  it('requires WEB_APP_URL and SMTP_FROM when SMTP_HOST is set', () => {
    const smtp = { ...valid, SMTP_HOST: 'localhost' };
    expect(() => loadConfig({ ...smtp, SMTP_FROM: 'a@b.co' }, readFile)).toThrow(/WEB_APP_URL/);
    expect(() => loadConfig({ ...smtp, WEB_APP_URL: 'http://x.co' }, readFile)).toThrow(
      /SMTP_FROM/,
    );
  });

  it.each(['localhost:5173', 'ftp://x.com', 'nope'])('rejects WEB_APP_URL %j', (url) => {
    expect(() => loadConfig({ ...valid, WEB_APP_URL: url }, readFile)).toThrow(/WEB_APP_URL/);
  });
});
