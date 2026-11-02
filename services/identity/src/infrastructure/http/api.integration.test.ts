import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { importPKCS8, SignJWT } from 'jose';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCESS_TOKEN_ISSUER } from '@inventory/shared';
import { CreateInitialAdminUseCase } from '../../application/auth/create-initial-admin.use-case.js';
import { loadConfig, type IdentityConfig } from '../config/config.js';
import { createPool } from '../database/pool.js';
import { Argon2PasswordHasher } from '../security/argon2-password-hasher.js';
import { AppModule } from './app.module.js';
import { configureCors } from './cors.js';
import { createRepositories } from './composition.js';
import { registerSessionCookies } from './session-cookie.js';
import { FakeMailer } from '../../testing/in-memory.js';

/**
 * Integration tests over HTTP against a real PostgreSQL. They use a SEPARATE database
 * (POSTGRES_TEST_DB, default inventory_test) created beforehand in the same container.
 */
const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const testDb = process.env.POSTGRES_TEST_DB ?? 'inventory_test';
const password = () => `Aa1${randomBytes(8).toString('hex')}`;
const ADMIN_PASSWORD = password();
const USER_PASSWORD = password();

let app: NestFastifyApplication;
let pool: Pool;
let config: IdentityConfig;
let privatePem: string;
const logs: string[] = [];
const mailer = new FakeMailer();
const WEB_ORIGIN = 'http://localhost:5173';

interface Res {
  status: number;
  /** Raw `Set-Cookie` header lines. */
  setCookie: string[];
  headers: Record<string, unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  raw: string;
}

async function call(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  options: {
    token?: string;
    body?: unknown;
    headers?: Record<string, string>;
    target?: NestFastifyApplication;
    ip?: string;
  } = {},
): Promise<Res> {
  const response = await (options.target ?? app).inject({
    method,
    url,
    ...(options.ip ? { remoteAddress: options.ip } : {}),
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...options.headers,
    },
    ...(options.body !== undefined ? { payload: options.body as object } : {}),
  });
  return {
    status: response.statusCode,
    headers: response.headers,
    setCookie: [response.headers['set-cookie'] ?? []].flat().map(String),
    raw: response.body,
    body: response.body ? safeJson(response.body) : undefined,
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function login(email: string, pwd: string): Promise<Res> {
  return call('POST', '/auth/login', { body: { email, password: pwd } });
}

/** Value of the `inv_rt` cookie set by a response ('' when it was cleared, undefined if absent). */
function refreshCookie(res: Res): string | undefined {
  const line = res.setCookie.find((c) => c.startsWith('inv_rt='));
  return line?.split(';')[0]!.slice('inv_rt='.length);
}

/** POST to a cookie endpoint like the web app: allowed Origin, X-Requested-With and the cookie. */
function withSession(
  url: '/auth/refresh' | '/auth/logout',
  cookie: string | undefined,
  headers: Record<string, string> = { origin: WEB_ORIGIN, 'x-requested-with': 'inventory-web' },
): Promise<Res> {
  return call('POST', url, {
    headers: { ...headers, ...(cookie !== undefined ? { cookie: `inv_rt=${cookie}` } : {}) },
  });
}

let adminToken = '';
let adminEmail = '';
const unique = () => randomBytes(4).toString('hex');

async function createUser(roleId: string, pwd = USER_PASSWORD) {
  const email = `user-${unique()}@example.test`;
  const res = await call('POST', '/users', {
    token: adminToken,
    body: { email, password: pwd, fullName: 'Usuario de prueba', roleId },
  });
  expect(res.status).toBe(201);
  return { id: res.body.id as string, email };
}

async function createRole(name = `Rol ${unique()}`, permissions: string[] = []) {
  const res = await call('POST', '/roles', { token: adminToken, body: { name } });
  expect(res.status).toBe(201);
  if (permissions.length > 0) {
    const put = await call('PUT', `/roles/${res.body.id}/permissions`, {
      token: adminToken,
      body: { permissions },
    });
    expect(put.status).toBe(200);
  }
  return res.body.id as string;
}

async function tokenFor(roleId: string) {
  const user = await createUser(roleId);
  const res = await login(user.email, USER_PASSWORD);
  return {
    ...user,
    token: res.body.accessToken as string,
    refresh: refreshCookie(res)!,
  };
}

beforeAll(async () => {
  if (!testDb.endsWith('_test')) throw new Error('POSTGRES_TEST_DB must end with _test');
  const env = { ...process.env, POSTGRES_DB: testDb };
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  config = loadConfig({
    ...env,
    // Pinned: tests must not depend on the developer's .env (CORS tests set it explicitly).
    CORS_ORIGINS: WEB_ORIGIN,
    SESSION_COOKIE_SECURE: 'true',
    // The shared limiter must not trip over the many logins of this suite (see 'throttling').
    LOGIN_MAX_ATTEMPTS_EMAIL: '1000',
    LOGIN_MAX_ATTEMPTS_IP: '1000',
    LOGIN_ATTEMPT_WINDOW: '15m',
    PASSWORD_RESET_TTL: '30m',
    WEB_APP_URL: 'http://web.example.test',
    SMTP_HOST: '',
    SMTP_FROM: '',
    JWT_PRIVATE_KEY: privatePem,
    JWT_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }) as string,
  });

  try {
    execFileSync(
      process.execPath,
      ['node_modules/node-pg-migrate/bin/node-pg-migrate.js', 'up', '-f', 'migrate.config.cjs'],
      { cwd: root, env, stdio: 'pipe' },
    );
  } catch (error) {
    throw new Error(
      `Cannot migrate ${testDb}. Is the postgres container up and the database created? ${String(error)}`,
      { cause: error },
    );
  }

  pool = createPool(config.database);
  // Clean slate in the TEST database only (the system role and the permission catalog stay).
  await pool.query('DELETE FROM refresh_tokens');
  await pool.query('DELETE FROM users');
  await pool.query('DELETE FROM roles WHERE NOT is_system');

  const repos = createRepositories(pool);
  adminEmail = `admin-${unique()}@example.test`;
  await new CreateInitialAdminUseCase(repos.users, repos.roles, new Argon2PasswordHasher(), {
    info: () => undefined,
    warn: () => undefined,
  }).execute({ email: adminEmail, password: ADMIN_PASSWORD, fullName: 'Admin de prueba' });

  const capture = (...args: unknown[]) => logs.push(args.map(String).join(' '));
  app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register(config, { mailer }),
    new FastifyAdapter(),
    { logger: { log: capture, warn: capture, error: capture, debug: capture, verbose: capture } },
  );
  await registerSessionCookies(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  const res = await login(adminEmail, ADMIN_PASSWORD);
  adminToken = res.body.accessToken;
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

describe('auth', () => {
  it('CA-1: login returns an ES256 JWT (~15 min) and the refresh token only in an HttpOnly cookie', async () => {
    const res = await login(adminEmail, ADMIN_PASSWORD);
    expect(res.status).toBe(200);
    const [header, payload] = res.body.accessToken
      .split('.')
      .slice(0, 2)
      .map((part: string) => JSON.parse(Buffer.from(part, 'base64url').toString()));
    expect(header.alg).toBe('ES256');
    expect(payload.exp - payload.iat).toBe(900);
    expect(res.body.tokenType).toBe('Bearer');
    expect(res.body.expiresIn).toBe(900);
    expect(res.body).not.toHaveProperty('refreshToken');
    const cookie = res.setCookie.find((c) => c.startsWith('inv_rt='))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/auth(;|$)/);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/Max-Age=604800/i);
    expect(res.raw).not.toContain(refreshCookie(res)!);
    // The password is never echoed back.
    expect(res.raw).not.toContain(ADMIN_PASSWORD);
  });

  it('CA-2: unknown email and wrong password produce identical 401 bodies', async () => {
    const a = await login('nobody@example.test', USER_PASSWORD);
    const b = await login(adminEmail, `${USER_PASSWORD}x`);
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.raw).toBe(b.raw);
    expect(a.setCookie).toEqual([]);
    expect(b.setCookie).toEqual([]);
  });

  it('CA-3 / CA-5: refresh rotates the cookie, reuse closes every session, logout revokes', async () => {
    const roleId = await createRole();
    const user = await tokenFor(roleId);
    const first = await withSession('/auth/refresh', user.refresh);
    expect(first.status).toBe(200);
    expect(first.body.accessToken).toEqual(expect.any(String));
    expect(first.body).not.toHaveProperty('refreshToken');
    const rotated = refreshCookie(first)!;
    expect(rotated).not.toBe(user.refresh);
    expect((await withSession('/auth/refresh', user.refresh)).status).toBe(401);
    // Reuse closed every session of the user, including the freshly issued one.
    expect((await withSession('/auth/refresh', rotated)).status).toBe(401);

    const again = await login(user.email, USER_PASSWORD);
    const cookie = refreshCookie(again)!;
    const out = await withSession('/auth/logout', cookie);
    expect(out.status).toBe(204);
    expect(refreshCookie(out)).toBe('');
    expect(out.setCookie[0]).toMatch(/Path=\/auth/);
    expect((await withSession('/auth/refresh', cookie)).status).toBe(401);
  });

  it('CA-3: refresh without a cookie or with a bogus one is 401 INVALID_SESSION and clears the cookie', async () => {
    for (const cookie of [undefined, 'not-a-real-token']) {
      const res = await withSession('/auth/refresh', cookie);
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('INVALID_SESSION');
      expect(refreshCookie(res)).toBe('');
    }
  });

  it('CA-4: refresh and logout without X-Requested-With or from another Origin are 403 and change nothing', async () => {
    const user = await tokenFor(await createRole());
    const bad: Array<Record<string, string>> = [
      { origin: WEB_ORIGIN },
      { 'x-requested-with': 'inventory-web' },
      { origin: 'http://evil.example', 'x-requested-with': 'inventory-web' },
      { origin: WEB_ORIGIN, 'x-requested-with': 'XMLHttpRequest' },
      {},
    ];
    for (const headers of bad) {
      for (const url of ['/auth/refresh', '/auth/logout'] as const) {
        const res = await withSession(url, user.refresh, headers);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('CSRF_REJECTED');
        expect(res.setCookie).toEqual([]);
      }
    }
    // Nothing was rotated or revoked: the original cookie still refreshes.
    expect((await withSession('/auth/refresh', user.refresh)).status).toBe(200);
  });

  it('CA-5: logout without a cookie is 204 with no effect', async () => {
    const out = await withSession('/auth/logout', undefined);
    expect(out.status).toBe(204);
  });

  it('CA-5: a deactivated user cannot login, refresh or use a still-valid access token', async () => {
    const user = await tokenFor(await createRole(undefined, ['users.read']));
    expect((await call('GET', '/users', { token: user.token })).status).toBe(200);
    const off = await call('PATCH', `/users/${user.id}/status`, {
      token: adminToken,
      body: { isActive: false },
    });
    expect(off.status).toBe(200);
    expect((await login(user.email, USER_PASSWORD)).status).toBe(401);
    expect((await withSession('/auth/refresh', user.refresh)).status).toBe(401);
    expect((await call('GET', '/users', { token: user.token })).status).toBe(401);
  });

  it('CA-6: /auth/me returns user, role and permissions without hashes; change-password', async () => {
    const roleId = await createRole(undefined, ['users.read']);
    const user = await tokenFor(roleId);
    const me = await call('GET', '/auth/me', { token: user.token });
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(user.email);
    expect(me.body.user.role.id).toBe(roleId);
    expect(me.body.permissions).toEqual(['users.read']);
    expect(me.raw).not.toMatch(/password|hash/i);

    const wrong = await call('POST', '/auth/change-password', {
      token: user.token,
      body: { currentPassword: 'nope', newPassword: password() },
    });
    expect(wrong.status).toBe(400);
    const weak = await call('POST', '/auth/change-password', {
      token: user.token,
      body: { currentPassword: USER_PASSWORD, newPassword: 'short' },
    });
    expect(weak.status).toBe(400);
    const next = password();
    const ok = await call('POST', '/auth/change-password', {
      token: user.token,
      body: { currentPassword: USER_PASSWORD, newPassword: next },
    });
    expect(ok.status).toBe(204);
    expect((await withSession('/auth/refresh', user.refresh)).status).toBe(401);
    expect((await login(user.email, USER_PASSWORD)).status).toBe(401);
    expect((await login(user.email, next)).status).toBe(200);
  });
});

describe('users', () => {
  it('CA-7 / CA-8: CRUD, no secrets in responses, duplicates and invalid data', async () => {
    const roleId = await createRole();
    const email = `Mixed-${unique()}@Example.Test`;
    const created = await call('POST', '/users', {
      token: adminToken,
      body: { email, password: USER_PASSWORD, fullName: '  Ana Pérez ', roleId },
    });
    expect(created.status).toBe(201);
    expect(created.body.email).toBe(email.toLowerCase());
    expect(created.body.fullName).toBe('Ana Pérez');
    expect(created.raw).not.toMatch(/password|hash/i);

    const dup = await call('POST', '/users', {
      token: adminToken,
      body: { email: email.toUpperCase(), password: USER_PASSWORD, fullName: 'Otra', roleId },
    });
    expect(dup.status).toBe(409);

    const invalid = await call('POST', '/users', {
      token: adminToken,
      body: { email: 'no-es-correo', password: 'corta', roleId: 'x' },
    });
    expect(invalid.status).toBe(400);
    const fields = invalid.body.details.map((d: { field: string }) => d.field);
    expect(fields).toEqual(['fullName', 'roleId']);
    expect(
      (
        await call('POST', '/users', {
          token: adminToken,
          body: {
            email,
            password: USER_PASSWORD,
            fullName: 'x',
            roleId: '00000000-0000-4000-8000-000000000000',
          },
        })
      ).status,
    ).toBe(400);

    const badEmail = await call('POST', '/users', {
      token: adminToken,
      body: { email: 'no-es-correo', password: USER_PASSWORD, fullName: 'x', roleId },
    });
    expect(badEmail.status).toBe(400);
    expect(badEmail.body.details[0].field).toBe('email');
    const weakPwd = await call('POST', '/users', {
      token: adminToken,
      body: { email: `w-${unique()}@example.test`, password: 'corta', fullName: 'x', roleId },
    });
    expect(weakPwd.status).toBe(400);
    expect(weakPwd.body.details[0].field).toBe('password');

    const list = await call('GET', '/users?limit=2', { token: adminToken });
    expect(list.status).toBe(200);
    expect(list.body.items.length).toBeLessThanOrEqual(2);
    expect(list.raw).not.toMatch(/password|hash/i);

    const one = await call('GET', `/users/${created.body.id}`, { token: adminToken });
    expect(one.status).toBe(200);
    expect(
      (await call('GET', '/users/00000000-0000-4000-8000-000000000000', { token: adminToken }))
        .status,
    ).toBe(404);
    expect((await call('GET', '/users/not-a-uuid', { token: adminToken })).status).toBe(400);

    const patched = await call('PATCH', `/users/${created.body.id}`, {
      token: adminToken,
      body: { fullName: 'Ana P.' },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.fullName).toBe('Ana P.');
    expect(
      (await call('PATCH', `/users/${created.body.id}`, { token: adminToken, body: {} })).status,
    ).toBe(400);

    const newPwd = password();
    expect(
      (
        await call('POST', `/users/${created.body.id}/reset-password`, {
          token: adminToken,
          body: { newPassword: newPwd },
        })
      ).status,
    ).toBe(204);
    expect((await login(email, newPwd)).status).toBe(200);
    expect((await call('DELETE', `/users/${created.body.id}`, { token: adminToken })).status).toBe(
      404,
    );
  });

  it('CA-13: the last active administrator cannot be deactivated or change role', async () => {
    const admin = await call('GET', '/auth/me', { token: adminToken });
    const adminId = admin.body.user.id as string;
    const other = await createRole();
    const status = await call('PATCH', `/users/${adminId}/status`, {
      token: adminToken,
      body: { isActive: false },
    });
    expect(status.status).toBe(409);
    expect(status.body.code).toBe('LAST_ADMIN');
    const role = await call('PATCH', `/users/${adminId}`, {
      token: adminToken,
      body: { roleId: other },
    });
    expect(role.status).toBe(409);
    expect(role.body.code).toBe('LAST_ADMIN');

    // With a second administrator the rule no longer blocks the change of role.
    const adminRoleId = admin.body.user.role.id as string;
    const second = await createUser(adminRoleId);
    const moved = await call('PATCH', `/users/${adminId}`, {
      token: adminToken,
      body: { roleId: other },
    });
    expect(moved.status).toBe(200);
    // Restore: the second admin gives the role back to the first one.
    const secondToken = (await login(second.email, USER_PASSWORD)).body.accessToken;
    const back = await call('PATCH', `/users/${adminId}`, {
      token: secondToken,
      body: { roleId: adminRoleId },
    });
    expect(back.status).toBe(200);
    expect(
      (
        await call('PATCH', `/users/${second.id}/status`, {
          token: adminToken,
          body: { isActive: false },
        })
      ).status,
    ).toBe(200);
  });
});

describe('roles and permissions', () => {
  it('CA-9: role CRUD, permission assignment and catalog', async () => {
    const catalog = await call('GET', '/permissions', { token: adminToken });
    expect(catalog.status).toBe(200);
    expect(catalog.body.items.map((p: { code: string }) => p.code)).toContain('users.read');

    const name = `Ventas ${unique()}`;
    const created = await call('POST', '/roles', {
      token: adminToken,
      body: { name, description: 'd' },
    });
    expect(created.status).toBe(201);
    expect(
      (await call('POST', '/roles', { token: adminToken, body: { name: name.toUpperCase() } }))
        .status,
    ).toBe(409);
    expect((await call('POST', '/roles', { token: adminToken, body: { name: '  ' } })).status).toBe(
      400,
    );

    const bad = await call('PUT', `/roles/${created.body.id}/permissions`, {
      token: adminToken,
      body: { permissions: ['users.read', 'nope.nothing'] },
    });
    expect(bad.status).toBe(400);
    const good = await call('PUT', `/roles/${created.body.id}/permissions`, {
      token: adminToken,
      body: { permissions: ['users.read', 'roles.read'] },
    });
    expect(good.status).toBe(200);
    expect(good.body.permissions).toEqual(['roles.read', 'users.read']);

    expect(
      (
        await call('PATCH', `/roles/${created.body.id}`, {
          token: adminToken,
          body: { description: 'nueva' },
        })
      ).body.description,
    ).toBe('nueva');
    expect((await call('GET', `/roles/${created.body.id}`, { token: adminToken })).status).toBe(
      200,
    );
    expect((await call('GET', '/roles', { token: adminToken })).body.items.length).toBeGreaterThan(
      1,
    );
    expect((await call('DELETE', `/roles/${created.body.id}`, { token: adminToken })).status).toBe(
      204,
    );
    expect((await call('GET', `/roles/${created.body.id}`, { token: adminToken })).status).toBe(
      404,
    );
  });

  it('CA-12: system role and roles in use are protected', async () => {
    const admin = await call('GET', '/auth/me', { token: adminToken });
    const adminRoleId = admin.body.user.role.id as string;
    expect((await call('DELETE', `/roles/${adminRoleId}`, { token: adminToken })).status).toBe(409);
    expect(
      (
        await call('PUT', `/roles/${adminRoleId}/permissions`, {
          token: adminToken,
          body: { permissions: [] },
        })
      ).status,
    ).toBe(409);
    expect(
      (await call('PATCH', `/roles/${adminRoleId}`, { token: adminToken, body: { name: 'Otro' } }))
        .status,
    ).toBe(409);

    const used = await createRole();
    await createUser(used);
    const del = await call('DELETE', `/roles/${used}`, { token: adminToken });
    expect(del.status).toBe(409);
    expect(del.body.code).toBe('ROLE_IN_USE');
  });
});

describe('protection', () => {
  it('CA-10: 401 without/tampered/expired token, 403 without permission, health is public', async () => {
    expect((await call('GET', '/users')).status).toBe(401);
    expect((await call('GET', '/users', { token: 'garbage' })).status).toBe(401);
    const tampered = adminToken.slice(0, -3) + (adminToken.endsWith('AAA') ? 'BBB' : 'AAA');
    expect((await call('GET', '/users', { token: tampered })).status).toBe(401);

    const me = await call('GET', '/auth/me', { token: adminToken });
    const expired = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256' })
      .setSubject(me.body.user.id)
      .setIssuer(ACCESS_TOKEN_ISSUER)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(await importPKCS8(privatePem, 'ES256'));
    expect((await call('GET', '/users', { token: expired })).status).toBe(401);

    const noPerms = await tokenFor(await createRole());
    expect((await call('GET', '/users', { token: noPerms.token })).status).toBe(403);
    expect((await call('GET', '/auth/me', { token: noPerms.token })).status).toBe(200);

    const health = await call('GET', '/health');
    expect(health.status).toBe(200);
    expect(health.body.database).toBe('up');
  });

  it('CA-11: removing a permission from a role takes effect on the next request', async () => {
    const roleId = await createRole(undefined, ['users.read', 'roles.read']);
    const user = await tokenFor(roleId);
    expect((await call('GET', '/users', { token: user.token })).status).toBe(200);
    await call('PUT', `/roles/${roleId}/permissions`, {
      token: adminToken,
      body: { permissions: ['roles.read'] },
    });
    expect((await call('GET', '/users', { token: user.token })).status).toBe(403);
    expect((await call('GET', '/roles', { token: user.token })).status).toBe(200);
  });

  it('returns the uniform JSON error format for unknown routes and malformed JSON', async () => {
    const missing = await call('GET', '/nope', { token: adminToken });
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ statusCode: 404, error: 'Not Found' });
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{bad json',
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({ statusCode: 400, error: 'Bad Request' });
  });
});

describe('anti-escalation rule', () => {
  it('CA-21: users.read + users.update cannot escalate through users', async () => {
    const adminRoleId = (await call('GET', '/auth/me', { token: adminToken })).body.user.role
      .id as string;
    const managerRole = await createRole(undefined, ['users.read', 'users.create', 'users.update']);
    const manager = await tokenFor(managerRole);
    const denied = (res: Res) => {
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PRIVILEGE_ESCALATION');
      expect(typeof res.body.message).toBe('string');
    };

    // Assign the Administrador role to themselves or to someone else.
    denied(
      await call('PATCH', `/users/${manager.id}`, {
        token: manager.token,
        body: { roleId: adminRoleId },
      }),
    );
    const victim = await createUser(await createRole(undefined, ['users.read']));
    denied(
      await call('PATCH', `/users/${victim.id}`, {
        token: manager.token,
        body: { roleId: adminRoleId },
      }),
    );
    denied(
      await call('POST', '/users', {
        token: manager.token,
        body: {
          email: `n-${unique()}@example.test`,
          password: USER_PASSWORD,
          fullName: 'Nuevo admin',
          roleId: adminRoleId,
        },
      }),
    );

    // Touch an administrator: reset password, email, data.
    const target = await createUser(adminRoleId);
    denied(
      await call('POST', `/users/${target.id}/reset-password`, {
        token: manager.token,
        body: { newPassword: 'Hacked12345' },
      }),
    );
    denied(
      await call('PATCH', `/users/${target.id}`, {
        token: manager.token,
        body: { email: `attacker-${unique()}@example.test` },
      }),
    );
    expect((await login(target.email, USER_PASSWORD)).status).toBe(200);
    expect((await call('GET', '/auth/me', { token: manager.token })).body.user.role.id).toBe(
      managerRole,
    );

    // The same kind of operations within their permissions work.
    const readerRole = await createRole(undefined, ['users.read']);
    const ok = await call('PATCH', `/users/${victim.id}`, {
      token: manager.token,
      body: { roleId: readerRole, fullName: 'Renombrado' },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.role.id).toBe(readerRole);
    const reset = await call('POST', `/users/${victim.id}/reset-password`, {
      token: manager.token,
      body: { newPassword: password() },
    });
    expect(reset.status).toBe(204);
    const created = await call('POST', '/users', {
      token: manager.token,
      body: {
        email: `n-${unique()}@example.test`,
        password: USER_PASSWORD,
        fullName: 'Nuevo lector',
        roleId: readerRole,
      },
    });
    expect(created.status).toBe(201);

    // The Administrador can do all of the above.
    expect(
      (
        await call('PATCH', `/users/${target.id}`, {
          token: adminToken,
          body: { fullName: 'Admin editado' },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call('POST', `/users/${target.id}/reset-password`, {
          token: adminToken,
          body: { newPassword: password() },
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await call('PATCH', `/users/${manager.id}`, {
          token: adminToken,
          body: { roleId: adminRoleId },
        })
      ).status,
    ).toBe(200);
    // The denied attempts were logged.
    expect(logs.join('\n')).toContain('privilege.escalation.denied');
  });

  it('CA-21: roles.read + roles.update cannot touch the own role nor grant what they lack', async () => {
    const editorRole = await createRole(undefined, [
      'roles.read',
      'roles.update',
      'roles.delete',
      'users.read',
    ]);
    const editor = await tokenFor(editorRole);
    const denied = (res: Res) => {
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PRIVILEGE_ESCALATION');
    };
    const all = (await call('GET', '/permissions', { token: editor.token })).body.items.map(
      (p: { code: string }) => p.code,
    );

    denied(
      await call('PUT', `/roles/${editorRole}/permissions`, {
        token: editor.token,
        body: { permissions: all },
      }),
    );
    denied(
      await call('PATCH', `/roles/${editorRole}`, {
        token: editor.token,
        body: { description: 'mío' },
      }),
    );
    denied(await call('DELETE', `/roles/${editorRole}`, { token: editor.token }));

    const other = await createRole();
    denied(
      await call('PUT', `/roles/${other}/permissions`, {
        token: editor.token,
        body: { permissions: ['users.read', 'users.create'] },
      }),
    );
    const adminRoleId = (await call('GET', '/auth/me', { token: adminToken })).body.user.role
      .id as string;
    denied(
      await call('PATCH', `/roles/${adminRoleId}`, {
        token: editor.token,
        body: { description: 'x' },
      }),
    );
    // Nothing changed for the editor.
    const me = await call('GET', '/auth/me', { token: editor.token });
    expect(me.body.permissions).toEqual([
      'roles.delete',
      'roles.read',
      'roles.update',
      'users.read',
    ]);

    // Within their permissions it works.
    const ok = await call('PUT', `/roles/${other}/permissions`, {
      token: editor.token,
      body: { permissions: ['users.read', 'roles.read'] },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.permissions).toEqual(['roles.read', 'users.read']);
    expect(
      (await call('PATCH', `/roles/${other}`, { token: editor.token, body: { description: 'ok' } }))
        .status,
    ).toBe(200);
  });

  it('CA-21: the Administrador keeps managing roles other than its own', async () => {
    const role = await createRole(undefined, ['users.read']);
    const all = (await call('GET', '/permissions', { token: adminToken })).body.items.map(
      (p: { code: string }) => p.code,
    );
    const put = await call('PUT', `/roles/${role}/permissions`, {
      token: adminToken,
      body: { permissions: all },
    });
    expect(put.status).toBe(200);
    expect((await call('DELETE', `/roles/${role}`, { token: adminToken })).status).toBe(204);
  });
});

describe('last administrator under concurrency', () => {
  async function activeAdmins(): Promise<number> {
    const { rows } = await pool.query<{ total: string }>(
      'SELECT count(*) AS total FROM users u JOIN roles r ON r.id = u.role_id WHERE r.is_system AND u.is_active',
    );
    return Number(rows[0]!.total);
  }

  it('CA-13: two administrators deactivating each other at once never leave zero active', async () => {
    const baseId = (await call('GET', '/auth/me', { token: adminToken })).body.user.id as string;
    const adminRoleId = (await call('GET', '/auth/me', { token: adminToken })).body.user.role
      .id as string;
    const x = await tokenFor(adminRoleId);
    const y = await tokenFor(adminRoleId);
    const other = await createRole();
    // Leave only X and Y as active administrators (test database only).
    await pool.query(
      `UPDATE users SET is_active = false
       WHERE id <> ALL($1::uuid[]) AND role_id = $2`,
      [[x.id, y.id], adminRoleId],
    );
    expect(await activeAdmins()).toBe(2);

    const outcomes: number[][] = [];
    for (let i = 0; i < 6; i++) {
      const [a, b] = await Promise.all([
        call('PATCH', `/users/${y.id}/status`, { token: x.token, body: { isActive: false } }),
        call('PATCH', `/users/${x.id}/status`, { token: y.token, body: { isActive: false } }),
      ]);
      outcomes.push([a.status, b.status]);
      // Exactly one wins; the other is refused (409 last admin, or 401 if the winner got first).
      expect([a.status, b.status].filter((code) => code === 200)).toHaveLength(1);
      expect([a.status, b.status].filter((code) => code === 409 || code === 401)).toHaveLength(1);
      expect(await activeAdmins()).toBe(1);
      // The survivor reactivates the other one, and the cycle starts again.
      const survivor = a.status === 200 ? x : y;
      const loser = a.status === 200 ? y : x;
      const back = await call('PATCH', `/users/${loser.id}/status`, {
        token: survivor.token,
        body: { isActive: true },
      });
      expect(back.status).toBe(200);
      expect(await activeAdmins()).toBe(2);
    }
    expect(outcomes.length).toBe(6);

    // Same race with a role change instead of deactivation.
    const [c, d] = await Promise.all([
      call('PATCH', `/users/${y.id}`, { token: x.token, body: { roleId: other } }),
      call('PATCH', `/users/${x.id}`, { token: y.token, body: { roleId: other } }),
    ]);
    expect([c.status, d.status].filter((code) => code === 200)).toHaveLength(1);
    expect(await activeAdmins()).toBe(1);

    // Restore the base administrator with the surviving one.
    const survivor = c.status === 200 ? x : y;
    const back = await call('PATCH', `/users/${baseId}/status`, {
      token: survivor.token,
      body: { isActive: true },
    });
    expect(back.status).toBe(200);
  });
});

describe('CA-22 / CA-24', () => {
  it('CA-22: reset-password on oneself is rejected with USE_CHANGE_PASSWORD', async () => {
    const me = await call('GET', '/auth/me', { token: adminToken });
    const res = await call('POST', `/users/${me.body.user.id}/reset-password`, {
      token: adminToken,
      body: { newPassword: password() },
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('USE_CHANGE_PASSWORD');
    expect(JSON.stringify(res.body)).toContain('/auth/change-password');
    expect((await login(adminEmail, ADMIN_PASSWORD)).status).toBe(200);
  });

  it('CA-24: fullName over 150 and role name over 100 give 400 with the field', async () => {
    const roles = await call('GET', '/roles', { token: adminToken });
    const roleId = roles.body.items?.[0]?.id ?? roles.body[0].id;
    const user = await call('POST', '/users', {
      token: adminToken,
      body: {
        email: `long-${unique()}@example.test`,
        password: USER_PASSWORD,
        fullName: 'x'.repeat(151),
        roleId,
      },
    });
    expect(user.status).toBe(400);
    expect(JSON.stringify(user.body)).toContain('fullName');
    const role = await call('POST', '/roles', {
      token: adminToken,
      body: { name: 'r'.repeat(101) },
    });
    expect(role.status).toBe(400);
    expect(JSON.stringify(role.body)).toContain('name');
  });
});

describe('logs', () => {
  it('CA-18: logs record auth and admin events but never passwords or tokens', async () => {
    await login(adminEmail, `${ADMIN_PASSWORD}x`);
    const res = await login(adminEmail, ADMIN_PASSWORD);
    const all = logs.join('\n');
    expect(all).toContain('auth.login.success');
    expect(all).toContain('auth.login.failed');
    expect(all).toContain('user.created');
    expect(all).toContain('role.permissions.changed');
    for (const secret of [
      ADMIN_PASSWORD,
      USER_PASSWORD,
      res.body.accessToken,
      refreshCookie(res)!,
    ]) {
      expect(all).not.toContain(secret);
    }
  });
});

describe('CORS (sprint 004)', () => {
  const allowed = 'http://localhost:5173';

  async function bootWith(corsOrigins: string[]) {
    const sink: string[] = [];
    const capture = (...args: unknown[]) => sink.push(args.map(String).join(' '));
    const instance = await NestFactory.create<NestFastifyApplication>(
      AppModule.register({ ...config, corsOrigins }),
      new FastifyAdapter(),
      { logger: { log: capture, warn: capture, error: capture, debug: capture, verbose: capture } },
    );
    await registerSessionCookies(instance);
    configureCors(instance, corsOrigins);
    await instance.init();
    await instance.getHttpAdapter().getInstance().ready();
    return instance;
  }

  it('CA-17: with CORS_ORIGINS the allowed origin gets preflight and response headers; others do not', async () => {
    const cors = await bootWith([allowed]);
    try {
      const pre = await cors.inject({
        method: 'OPTIONS',
        url: '/auth/login',
        headers: {
          origin: allowed,
          'access-control-request-method': 'POST',
          'access-control-request-headers':
            'content-type,idempotency-key,if-match,authorization,x-requested-with',
        },
      });
      expect(pre.statusCode).toBeLessThan(300);
      expect(pre.headers['access-control-allow-origin']).toBe(allowed);
      expect(String(pre.headers['access-control-allow-methods'])).toMatch(/POST/);
      const headers = String(pre.headers['access-control-allow-headers']).toLowerCase();
      for (const name of [
        'authorization',
        'content-type',
        'idempotency-key',
        'if-match',
        'x-requested-with',
      ]) {
        expect(headers).toContain(name);
      }
      expect(pre.headers['access-control-allow-credentials']).toBe('true');
      const real = await cors.inject({
        method: 'GET',
        url: '/health',
        headers: { origin: allowed },
      });
      expect(real.statusCode).toBe(200);
      expect(real.headers['access-control-allow-origin']).toBe(allowed);
      const denied = await cors.inject({
        method: 'GET',
        url: '/health',
        headers: { origin: 'http://evil.example' },
      });
      expect(denied.headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      await cors.close();
    }
  });

  it('CA-17: without CORS_ORIGINS there are no CORS headers', async () => {
    const res = await app.inject({ method: 'GET', url: '/health', headers: { origin: allowed } });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('CA-16: Idempotency-Key and If-Match are ignored by identity', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'idempotency-key': 'not-a-uuid', 'if-match': '*' },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('UUID case-insensitivity (sprint 006 cycle 3)', () => {
  it('self-deactivation and self password reset with an uppercase id are still refused', async () => {
    const roleId = await createRole(undefined, ['users.read', 'users.update', 'users.deactivate']);
    const me = await tokenFor(roleId);
    const upper = me.id.toUpperCase();
    expect(upper).not.toBe(me.id);

    const off = await call('PATCH', `/users/${upper}/status`, {
      token: me.token,
      body: { isActive: false },
    });
    const offLower = await call('PATCH', `/users/${me.id}/status`, {
      token: me.token,
      body: { isActive: false },
    });
    expect(off.status).toBe(409);
    expect(off.body.code).toBe('SELF_DEACTIVATION');
    expect(offLower.status).toBe(409);
    expect(offLower.body.code).toBe('SELF_DEACTIVATION');

    const reset = await call('POST', `/users/${upper}/reset-password`, {
      token: me.token,
      body: { newPassword: password() },
    });
    expect(reset.status).toBe(409);
    expect(reset.body.code).toBe('USE_CHANGE_PASSWORD');
    expect((await login(me.email, USER_PASSWORD)).status).toBe(200);
  });

  it('roleId in uppercase behaves like lowercase and responses carry lowercase ids', async () => {
    const roleId = await createRole();
    const otherRole = await createRole();
    const email = `upper-${unique()}@example.test`;
    const created = await call('POST', '/users', {
      token: adminToken,
      body: {
        email,
        password: USER_PASSWORD,
        fullName: 'Mayusculas',
        roleId: roleId.toUpperCase(),
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.role.id).toBe(roleId);
    const patched = await call('PATCH', `/users/${created.body.id.toUpperCase()}`, {
      token: adminToken,
      body: { roleId: otherRole.toUpperCase() },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.id).toBe(created.body.id);
    expect(patched.body.role.id).toBe(otherRole);
    const same = await call('PATCH', `/users/${created.body.id}`, {
      token: adminToken,
      body: { roleId: otherRole.toUpperCase() },
    });
    expect(same.status).toBe(200);
    expect(same.body.role.id).toBe(otherRole);
  });

  it('NUL (\\u0000) in any text input is a 400 VALIDATION_ERROR with the field, never a 500', async () => {
    const nul = 'a\u0000b';
    const loginEmail = await login(nul, USER_PASSWORD);
    expect(loginEmail.status).toBe(400);
    expect(loginEmail.body.code).toBe('VALIDATION_ERROR');
    expect(loginEmail.body.details[0].field).toBe('email');
    expect((await login('x@example.test', nul)).status).toBe(400);
    const reset = await call('POST', '/auth/password-reset/confirm', {
      body: { token: nul, newPassword: USER_PASSWORD },
    });
    expect(reset.status).toBe(400);
    expect(reset.body.details[0].field).toBe('token');
    const user = await call('POST', '/users', {
      token: adminToken,
      body: {
        email: `nul-${unique()}@example.test`,
        password: USER_PASSWORD,
        fullName: nul,
        roleId: await createRole(),
      },
    });
    expect(user.status).toBe(400);
    expect(user.body.code).toBe('VALIDATION_ERROR');
    expect(user.body.details[0].field).toBe('fullName');
    const role = await call('POST', '/roles', { token: adminToken, body: { name: nul } });
    expect(role.status).toBe(400);
    expect(role.body.details[0].field).toBe('name');
    const roleId = await createRole();
    const perms = await call('PUT', `/roles/${roleId}/permissions`, {
      token: adminToken,
      body: { permissions: [nul] },
    });
    expect(perms.status).toBe(400);
  });
});

/** Boots another application over the same database, with its own limiter and sinks. */
async function bootApp(overrides: Partial<IdentityConfig> = {}, instanceMailer = mailer) {
  const sink: string[] = [];
  const capture = (...args: unknown[]) => sink.push(args.map(String).join(' '));
  const instance = await NestFactory.create<NestFastifyApplication>(
    AppModule.register({ ...config, ...overrides }, { mailer: instanceMailer }),
    new FastifyAdapter(),
    { logger: { log: capture, warn: capture, error: capture, debug: capture, verbose: capture } },
  );
  await registerSessionCookies(instance);
  await instance.init();
  await instance.getHttpAdapter().getInstance().ready();
  return { instance, sink };
}

async function eventually(check: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
}

describe('login throttling (sprint 011)', () => {
  it('CA-6: 429 TOO_MANY_ATTEMPTS with Retry-After after the email limit; success clears the counter', async () => {
    const { instance, sink } = await bootApp({ loginMaxAttemptsEmail: 2, loginMaxAttemptsIp: 50 });
    try {
      const user = await createUser(await createRole());
      const attempt = (email: string, pwd: string) =>
        call('POST', '/auth/login', { target: instance, body: { email, password: pwd } });
      expect((await attempt(user.email, 'wrong-1A')).status).toBe(401);
      expect((await attempt(user.email, 'wrong-2A')).status).toBe(401);
      const blocked = await attempt(user.email, USER_PASSWORD);
      expect(blocked.status).toBe(429);
      expect(blocked.body.code).toBe('TOO_MANY_ATTEMPTS');
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
      expect(blocked.setCookie).toEqual([]);
      expect(sink.join('\n')).toContain('auth.login.throttled');
      expect(sink.join('\n')).not.toContain(USER_PASSWORD);

      // Another account is unaffected by the first one's failures; success resets its counter.
      const other = await createUser(await createRole());
      expect((await attempt(other.email, 'wrong-1A')).status).toBe(401);
      expect((await attempt(other.email, USER_PASSWORD)).status).toBe(200);
      expect((await attempt(other.email, 'wrong-1A')).status).toBe(401);
      expect((await attempt(other.email, USER_PASSWORD)).status).toBe(200);
    } finally {
      await instance.close();
    }
  });

  it('CA-6: 429 after the IP limit across different emails', async () => {
    const { instance } = await bootApp({ loginMaxAttemptsEmail: 50, loginMaxAttemptsIp: 3 });
    try {
      for (let i = 0; i < 3; i++) {
        const res = await call('POST', '/auth/login', {
          target: instance,
          body: { email: `nobody-${i}-${unique()}@example.test`, password: 'wrong-1A' },
        });
        expect(res.status).toBe(401);
      }
      const res = await call('POST', '/auth/login', {
        target: instance,
        body: { email: adminEmail, password: ADMIN_PASSWORD },
      });
      expect(res.status).toBe(429);
      expect(res.headers['retry-after']).toBeDefined();
    } finally {
      await instance.close();
    }
  });
});

describe('password reset (sprint 011)', () => {
  const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
  const tokenOf = (link: string) => link.split('#token=')[1]!;
  // Each request comes from its own address so the per-IP limit never interferes with the tests.
  let nextIp = 0;
  const request = (email: string, target: NestFastifyApplication) =>
    call('POST', '/auth/password-reset/request', {
      target,
      ip: `10.9.${Math.floor(++nextIp / 250)}.${(nextIp % 250) + 1}`,
      body: { email },
    });
  const confirm = (token: string, newPassword: string, target: NestFastifyApplication) =>
    call('POST', '/auth/password-reset/confirm', { target, body: { token, newPassword } });
  let reset: NestFastifyApplication;
  let sink: string[];
  const outbox = new FakeMailer();

  beforeAll(async () => {
    const booted = await bootApp({}, outbox);
    reset = booted.instance;
    sink = booted.sink;
  });
  afterAll(async () => {
    await reset?.close();
  });

  async function activeUser() {
    const user = await createUser(await createRole());
    return user;
  }
  const lastMailTo = (email: string) => [...outbox.sent].reverse().find((m) => m.to === email);

  it('CA-7: same 202 body for active, unknown and inactive accounts; only the active one gets mail', async () => {
    const active = await activeUser();
    const inactive = await activeUser();
    await call('PATCH', `/users/${inactive.id}/status`, {
      token: adminToken,
      body: { isActive: false },
    });
    const before = outbox.sent.length;
    const results = [
      await request(active.email, reset),
      await request(`nobody-${unique()}@example.test`, reset),
      await request(inactive.email, reset),
    ];
    for (const res of results) expect(res.status).toBe(202);
    expect(new Set(results.map((r) => r.raw)).size).toBe(1);
    expect(outbox.sent.length - before).toBe(1);
    expect(lastMailTo(active.email)).toBeDefined();
    expect(lastMailTo(inactive.email)).toBeUndefined();
    const { rows } = await pool.query('SELECT 1 FROM password_reset_tokens WHERE user_id = $1', [
      inactive.id,
    ]);
    expect(rows).toHaveLength(0);
    expect((await request('not-an-email', reset)).status).toBe(400);
  });

  it('CA-8: link in the fragment, only the hash in the database, a new request voids the old token', async () => {
    const user = await activeUser();
    await request(user.email, reset);
    const first = lastMailTo(user.email)!;
    expect(first.link).toMatch(
      /^http:\/\/web\.example\.test\/restablecer#token=[A-Za-z0-9_-]{43}$/,
    );
    const firstToken = tokenOf(first.link);
    const { rows } = await pool.query<{ token_hash: string }>(
      'SELECT token_hash FROM password_reset_tokens WHERE user_id = $1',
      [user.id],
    );
    expect(rows.map((r) => r.token_hash)).toEqual([sha256(firstToken)]);

    await request(user.email, reset);
    const secondToken = tokenOf(lastMailTo(user.email)!.link);
    expect(secondToken).not.toBe(firstToken);
    const stale = await confirm(firstToken, password(), reset);
    expect(stale.status).toBe(400);
    expect(stale.body.code).toBe('INVALID_RESET_TOKEN');
    expect((await confirm(secondToken, password(), reset)).status).toBe(204);
  });

  it('CA-9: password change, token use and session revocation are one transaction', async () => {
    const user = await activeUser();
    const session = await login(user.email, USER_PASSWORD);
    expect(refreshCookie(session)).toBeDefined();
    await request(user.email, reset);
    const tokenHash = sha256(tokenOf(lastMailTo(user.email)!.link));
    const before = await pool.query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [user.id],
    );
    const repo = createRepositories(pool).passwordResetTokens;
    // Every write is done, then the callback fails: the whole unit must roll back.
    await expect(
      repo.redeem(tokenHash, new Date(), async (userId, tx) => {
        await tx.setPassword(userId, 'hash-que-no-debe-quedar');
        await tx.revokeAllRefreshTokens(userId);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const after = await pool.query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [user.id],
    );
    expect(after.rows[0]!.password_hash).toBe(before.rows[0]!.password_hash);
    const used = await pool.query(
      'SELECT 1 FROM password_reset_tokens WHERE token_hash = $1 AND used_at IS NULL',
      [tokenHash],
    );
    expect(used.rows).toHaveLength(1);
    const live = await pool.query(
      'SELECT 1 FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL',
      [user.id],
    );
    expect(live.rows.length).toBeGreaterThan(0);
  });

  it('CA-9: confirm changes the password, spends the token and revokes the sessions', async () => {
    const user = await activeUser();
    const session = await login(user.email, USER_PASSWORD);
    const cookie = refreshCookie(session)!;
    await request(user.email, reset);
    const token = tokenOf(lastMailTo(user.email)!.link);
    const next = password();
    const done = await confirm(token, next, reset);
    expect(done.status).toBe(204);
    expect(done.raw).toBe('');
    expect((await login(user.email, USER_PASSWORD)).status).toBe(401);
    expect((await login(user.email, next)).status).toBe(200);
    expect((await withSession('/auth/refresh', cookie)).status).toBe(401);
    const { rows } = await pool.query<{ used_at: Date | null }>(
      'SELECT used_at FROM password_reset_tokens WHERE token_hash = $1',
      [sha256(token)],
    );
    expect(rows[0]!.used_at).not.toBeNull();
    const again = await confirm(token, password(), reset);
    expect(again.status).toBe(400);
    expect(again.body.code).toBe('INVALID_RESET_TOKEN');
  });

  it('CA-10: expired, tampered and inactive-user tokens fail the same way; policy errors keep the token', async () => {
    const expired = await activeUser();
    await request(expired.email, reset);
    const expiredToken = tokenOf(lastMailTo(expired.email)!.link);
    await pool.query(
      "UPDATE password_reset_tokens SET expires_at = now() - interval '1 minute' WHERE user_id = $1",
      [expired.id],
    );

    const inactive = await activeUser();
    await request(inactive.email, reset);
    const inactiveToken = tokenOf(lastMailTo(inactive.email)!.link);
    await call('PATCH', `/users/${inactive.id}/status`, {
      token: adminToken,
      body: { isActive: false },
    });

    const valid = await activeUser();
    await request(valid.email, reset);
    const validToken = tokenOf(lastMailTo(valid.email)!.link);
    const tampered = `${validToken.slice(0, -1)}${validToken.endsWith('A') ? 'B' : 'A'}`;

    const failures = [
      await confirm(expiredToken, password(), reset),
      await confirm(inactiveToken, password(), reset),
      await confirm(tampered, password(), reset),
      await confirm('short', password(), reset),
    ];
    for (const res of failures) {
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_RESET_TOKEN');
    }
    expect(new Set(failures.map((r) => r.body.message)).size).toBe(1);
    expect((await login(expired.email, USER_PASSWORD)).status).toBe(200);

    const weak = await confirm(validToken, 'short', reset);
    expect(weak.status).toBe(400);
    expect(weak.body.details[0].field).toBe('newPassword');
    expect((await confirm(validToken, password(), reset)).status).toBe(204);
  });

  it('CA-7: the per-email limit does not change the answer but stops the mail', async () => {
    const user = await activeUser();
    const before = outbox.sent.length;
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await request(user.email, reset)).status);
    expect(statuses).toEqual([202, 202, 202, 202, 202]);
    expect(outbox.sent.length - before).toBe(3);
    expect(sink.join('\n')).toContain('auth.password_reset.throttled');
  });

  it('CA-7: the per-IP limit also stops the mail without changing the answer', async () => {
    const capped = new FakeMailer();
    const { instance: limited } = await bootApp({}, capped);
    try {
      const users = [];
      for (let i = 0; i < 12; i++) users.push(await activeUser());
      for (const user of users) {
        const res = await call('POST', '/auth/password-reset/request', {
          target: limited,
          ip: '10.7.7.7',
          body: { email: user.email },
        });
        expect(res.status).toBe(202);
      }
      expect(capped.sent).toHaveLength(10);
    } finally {
      await limited.close();
    }
  });

  it('CA-11: an SMTP failure still answers 202, logs auth.mail.failed and leaks no token or link', async () => {
    const failing = new FakeMailer();
    failing.failWith = new Error('connect ECONNREFUSED smtp.internal:25');
    const { instance, sink: failSink } = await bootApp({}, failing);
    try {
      const user = await activeUser();
      const res = await request(user.email, instance);
      expect(res.status).toBe(202);
      await eventually(() => failSink.join('\n').includes('auth.mail.failed'));
      const { rows } = await pool.query<{ token_hash: string }>(
        'SELECT token_hash FROM password_reset_tokens WHERE user_id = $1',
        [user.id],
      );
      expect(rows).toHaveLength(1);
      const all = failSink.join('\n');
      expect(all).not.toMatch(/restablecer|token=|ECONNREFUSED/);
      expect(all).not.toContain(rows[0]!.token_hash);
    } finally {
      await instance.close();
    }
  });

  it('CA-11: logs of the whole flow never contain tokens, links or passwords', async () => {
    const user = await activeUser();
    await request(user.email, reset);
    const token = tokenOf(lastMailTo(user.email)!.link);
    const next = password();
    await confirm(token, next, reset);
    const all = sink.join('\n');
    expect(all).toContain('auth.password_reset.requested');
    expect(all).toContain('auth.password_reset.completed');
    for (const secret of [token, next, USER_PASSWORD, 'restablecer']) {
      expect(all).not.toContain(secret);
    }
  });
});
