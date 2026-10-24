import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

const valid = {
  API_PORT: '3000',
  POSTGRES_HOST: 'localhost',
  POSTGRES_PORT: '5432',
  POSTGRES_USER: 'u',
  POSTGRES_PASSWORD: 'p',
  POSTGRES_DB: 'd',
  JWT_PUBLIC_KEY: 'pem\\ncontent',
};

describe('loadConfig', () => {
  it('parses a valid environment', () => {
    expect(loadConfig(valid).POSTGRES_PORT).toBe(5432);
  });

  it('names the missing variable', () => {
    const { POSTGRES_DB: _omit, ...rest } = valid;
    expect(() => loadConfig(rest)).toThrow(ConfigError);
    expect(() => loadConfig(rest)).toThrow(/POSTGRES_DB/);
  });

  it.each(['API_PORT', 'POSTGRES_PORT'])('rejects %s above 65535 naming the variable', (name) => {
    const env = { ...valid, [name]: '99999' };
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(new RegExp(name));
  });

  it.each(['API_PORT', 'POSTGRES_PORT'])('accepts %s at 65535 and rejects 0', (name) => {
    expect(loadConfig({ ...valid, [name]: '65535' })[name as 'API_PORT']).toBe(65535);
    expect(() => loadConfig({ ...valid, [name]: '0' })).toThrow(new RegExp(name));
  });

  it('reads the public key from a file path', () => {
    const { JWT_PUBLIC_KEY: _omit, ...rest } = valid;
    const config = loadConfig({ ...rest, JWT_PUBLIC_KEY_PATH: '/k.pem' }, () => 'FROM-FILE');
    expect(config.publicKeyPem).toBe('FROM-FILE');
  });

  it('expands literal \\n in an inline public key', () => {
    expect(loadConfig(valid).publicKeyPem).toBe('pem\ncontent');
  });

  it('fails with a clear message when no public key is configured', () => {
    const { JWT_PUBLIC_KEY: _omit, ...rest } = valid;
    expect(() => loadConfig(rest)).toThrow(ConfigError);
    expect(() => loadConfig(rest)).toThrow(/JWT_PUBLIC_KEY or JWT_PUBLIC_KEY_PATH is required/);
  });

  it('fails when the public key file cannot be read', () => {
    const { JWT_PUBLIC_KEY: _omit, ...rest } = valid;
    const failing = () => {
      throw new Error('ENOENT');
    };
    expect(() => loadConfig({ ...rest, JWT_PUBLIC_KEY_PATH: '/nope.pem' }, failing)).toThrow(
      /JWT_PUBLIC_KEY_PATH: cannot read the file/,
    );
  });
});
