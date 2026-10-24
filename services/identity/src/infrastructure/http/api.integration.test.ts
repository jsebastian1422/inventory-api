import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
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
import { createRepositories } from './composition.js';

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

interface Res {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  raw: string;
}

async function call(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  options: { token?: string; body?: unknown } = {},
): Promise<Res> {
  const response = await app.inject({
    method,
    url,
    headers: options.token ? { authorization: `Bearer ${options.token}` } : {},
    ...(options.body !== undefined ? { payload: options.body as object } : {}),
  });
  return {
    status: response.statusCode,
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
    refresh: res.body.refreshToken as string,
  };
}

beforeAll(async () => {
  if (!testDb.endsWith('_test')) throw new Error('POSTGRES_TEST_DB must end with _test');
  const env = { ...process.env, POSTGRES_DB: testDb };
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  config = loadConfig({
    ...env,
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
    AppModule.register(config),
    new FastifyAdapter(),
    { logger: { log: capture, warn: capture, error: capture, debug: capture, verbose: capture } },
  );
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
  it('CA-1: login returns an ES256 JWT (~15 min) and a refresh token', async () => {
    const res = await login(adminEmail, ADMIN_PASSWORD);
    expect(res.status).toBe(200);
    const [header, payload] = res.body.accessToken
      .split('.')
      .slice(0, 2)
      .map((part: string) => JSON.parse(Buffer.from(part, 'base64url').toString()));
    expect(header.alg).toBe('ES256');
    expect(payload.exp - payload.iat).toBe(900);
    expect(typeof res.body.refreshToken).toBe('string');
    // The password is never echoed back.
    expect(res.raw).not.toContain(ADMIN_PASSWORD);
  });

  it('CA-2: unknown email and wrong password produce identical 401 bodies', async () => {
    const a = await login('nobody@example.test', USER_PASSWORD);
    const b = await login(adminEmail, `${USER_PASSWORD}x`);
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.raw).toBe(b.raw);
  });

  it('CA-3 / CA-4: refresh rotates, reuse fails, logout revokes', async () => {
    const roleId = await createRole();
    const user = await tokenFor(roleId);
    const first = await call('POST', '/auth/refresh', { body: { refreshToken: user.refresh } });
    expect(first.status).toBe(200);
    expect(first.body.refreshToken).not.toBe(user.refresh);
    expect(
      (await call('POST', '/auth/refresh', { body: { refreshToken: user.refresh } })).status,
    ).toBe(401);
    // Reuse closed every session of the user, including the freshly issued one.
    expect(
      (await call('POST', '/auth/refresh', { body: { refreshToken: first.body.refreshToken } }))
        .status,
    ).toBe(401);

    const again = await login(user.email, USER_PASSWORD);
    const out = await call('POST', '/auth/logout', {
      body: { refreshToken: again.body.refreshToken },
    });
    expect(out.status).toBe(204);
    expect(
      (await call('POST', '/auth/refresh', { body: { refreshToken: again.body.refreshToken } }))
        .status,
    ).toBe(401);
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
    expect(
      (await call('POST', '/auth/refresh', { body: { refreshToken: user.refresh } })).status,
    ).toBe(401);
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
    expect(
      (await call('POST', '/auth/refresh', { body: { refreshToken: user.refresh } })).status,
    ).toBe(401);
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
      res.body.refreshToken,
    ]) {
      expect(all).not.toContain(secret);
    }
  });
});
