import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { importPKCS8, SignJWT } from 'jose';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCESS_TOKEN_ISSUER } from '@inventory/shared';
import { loadConfig, type AppConfig } from '../config/config.js';
import { AppModule } from './app.module.js';
import { configureCors } from './cors.js';

/**
 * Integration tests over HTTP against a real PostgreSQL. They use a SEPARATE database
 * (POSTGRES_TEST_DB, default inventory_test). Users and roles are inserted directly with SQL
 * (identity owns those tables; here they only simulate what identity would have created).
 */
const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const testDb = process.env.POSTGRES_TEST_DB ?? 'inventory_test';
const unique = () => randomBytes(4).toString('hex');

let app: NestFastifyApplication;
let pool: Pool;
let config: AppConfig;
let privatePem: string;
let publicPem: string;
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
  options: {
    token?: string;
    body?: unknown;
    target?: NestFastifyApplication;
    headers?: Record<string, string>;
  } = {},
): Promise<Res> {
  const response = await (options.target ?? app).inject({
    method,
    url,
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...options.headers,
    },
    ...(options.body !== undefined ? { payload: options.body as object } : {}),
  });
  let body: unknown;
  try {
    body = response.body ? JSON.parse(response.body) : undefined;
  } catch {
    body = response.body;
  }
  return { status: response.statusCode, raw: response.body, body };
}

async function sign(userId: string, expiresIn = '15m', pem = privatePem): Promise<string> {
  const key = await importPKCS8(pem, 'ES256');
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256' })
    .setSubject(userId)
    .setIssuer(ACCESS_TOKEN_ISSUER)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(key);
}

/** Creates a role with the given establishments permissions and a user in it; returns a token. */
async function actor(codes: string[], isActive = true) {
  const role = await pool.query<{ id: string }>(
    `INSERT INTO roles (name, description) VALUES ($1, 'test') RETURNING id`,
    [`Rol ${unique()}`],
  );
  const roleId = role.rows[0]!.id;
  for (const code of codes) {
    await pool.query(
      `INSERT INTO role_permissions (role_id, permission_id)
       SELECT $1, id FROM permissions WHERE code = $2`,
      [roleId, code],
    );
  }
  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, full_name, role_id, is_active)
     VALUES ($1, 'x', 'Usuario de prueba', $2, $3) RETURNING id`,
    [`core-${unique()}@example.test`, roleId, isActive],
  );
  const userId = user.rows[0]!.id;
  return { userId, roleId, token: await sign(userId) };
}

const ALL = [
  'establishments.read',
  'establishments.create',
  'establishments.update',
  'establishments.deactivate',
];
let admin: Awaited<ReturnType<typeof actor>>;

const body = (overrides: Record<string, unknown> = {}) => ({
  name: `Sede ${unique()}`,
  address: 'Cra 10 # 20-30',
  city: 'Medellín',
  department: 'Antioquia',
  phone: '+57 604 555 0000',
  latitude: 6.25184,
  longitude: -75.563591,
  ...overrides,
});

async function createSede(overrides: Record<string, unknown> = {}) {
  const res = await call('POST', '/establishments', { token: admin.token, body: body(overrides) });
  expect(res.status).toBe(201);
  return res.body as { id: string; name: string };
}

async function boot(cfg: AppConfig, sink?: string[]) {
  const capture = (...args: unknown[]) => sink?.push(args.map(String).join(' '));
  const instance = await NestFactory.create<NestFastifyApplication>(
    AppModule.register(cfg),
    new FastifyAdapter(),
    { logger: { log: capture, warn: capture, error: capture, debug: capture, verbose: capture } },
  );
  configureCors(instance, cfg.corsOrigins);
  await instance.init();
  await instance.getHttpAdapter().getInstance().ready();
  return instance;
}

beforeAll(async () => {
  if (!testDb.endsWith('_test')) throw new Error('POSTGRES_TEST_DB must end with _test');
  const env = { ...process.env, POSTGRES_DB: testDb };
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  publicPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
  // CORS_ORIGINS is pinned: tests must not depend on the developer's .env (CORS tests set it explicitly).
  config = loadConfig({ ...env, CORS_ORIGINS: '', JWT_PUBLIC_KEY: publicPem });

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

  pool = new Pool({
    host: config.POSTGRES_HOST,
    port: config.POSTGRES_PORT,
    user: config.POSTGRES_USER,
    password: config.POSTGRES_PASSWORD,
    database: testDb,
  });
  // Clean slate in the TEST database only.
  await pool.query('DELETE FROM establishments');
  app = await boot(config, logs);
  admin = await actor(ALL);
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

describe('authentication and live authorization (ADR-0001)', () => {
  const endpoints: [string, string][] = [
    ['GET', '/establishments'],
    ['POST', '/establishments'],
    ['GET', '/establishments/00000000-0000-4000-8000-000000000000'],
    ['PATCH', '/establishments/00000000-0000-4000-8000-000000000000'],
    ['PATCH', '/establishments/00000000-0000-4000-8000-000000000000/status'],
  ];

  it('CA-13: no token, bad token, expired token -> 401 on every endpoint', async () => {
    const expired = await sign(admin.userId, '-1m');
    const foreign = await sign(
      admin.userId,
      '15m',
      generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({
        type: 'pkcs8',
        format: 'pem',
      }) as string,
    );
    for (const [method, url] of endpoints) {
      for (const token of [undefined, 'garbage', expired, foreign]) {
        const res = await call(method as 'GET', url, { token, body: {} });
        expect(res.status, `${method} ${url}`).toBe(401);
      }
    }
  });

  it('CA-13: valid token of an unknown or deactivated user -> 401', async () => {
    const ghost = await sign('00000000-0000-4000-8000-0000000000aa');
    expect((await call('GET', '/establishments', { token: ghost })).status).toBe(401);
    const inactive = await actor(ALL, false);
    expect((await call('GET', '/establishments', { token: inactive.token })).status).toBe(401);
  });

  it('CA-3: a role with only establishments.read lists but cannot create', async () => {
    const reader = await actor(['establishments.read']);
    expect((await call('GET', '/establishments', { token: reader.token })).status).toBe(200);
    const res = await call('POST', '/establishments', { token: reader.token, body: body() });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('CA-14: removing a permission or deactivating the user applies on the next request', async () => {
    const user = await actor(['establishments.read', 'establishments.create']);
    expect(
      (await call('POST', '/establishments', { token: user.token, body: body() })).status,
    ).toBe(201);
    await pool.query(
      `DELETE FROM role_permissions WHERE role_id = $1
       AND permission_id = (SELECT id FROM permissions WHERE code = 'establishments.create')`,
      [user.roleId],
    );
    expect(
      (await call('POST', '/establishments', { token: user.token, body: body() })).status,
    ).toBe(403);
    await pool.query('UPDATE users SET is_active = false WHERE id = $1', [user.userId]);
    expect((await call('GET', '/establishments', { token: user.token })).status).toBe(401);
  });

  it('the Administrador system role holds the establishments permissions', async () => {
    const { rows } = await pool.query(
      `SELECT p.code FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
       JOIN permissions p ON p.id = rp.permission_id
       WHERE r.is_system AND p.module = 'establishments' ORDER BY p.code`,
    );
    expect(rows.map((r) => r.code)).toEqual([...ALL].sort());
  });
});

describe('create and read', () => {
  it('CA-4 / CA-9: creates trimmed, active, phone empty -> null, numeric coordinates and mapsUrl', async () => {
    const res = await call('POST', '/establishments', {
      token: admin.token,
      body: body({ name: `  Trim ${unique()}  `, city: ' Cali ', phone: '  ' }),
    });
    expect(res.status).toBe(201);
    expect(res.body.isActive).toBe(true);
    expect(res.body.city).toBe('Cali');
    expect(res.body.name).not.toMatch(/^\s|\s$/);
    expect(res.body.phone).toBeNull();
    expect(typeof res.body.latitude).toBe('number');
    expect(typeof res.body.longitude).toBe('number');
    expect(res.body.mapsUrl).toBe(
      'https://www.google.com/maps/search/?api=1&query=6.25184,-75.563591',
    );
  });

  it('CA-6: gets by id (with mapsUrl) and CA-12: unknown id -> 404', async () => {
    const created = await createSede();
    const res = await call('GET', `/establishments/${created.id}`, { token: admin.token });
    expect(res.status).toBe(200);
    expect(res.body.mapsUrl).toContain('query=6.25184,-75.563591');
    const missing = await call('GET', '/establishments/00000000-0000-4000-8000-000000000000', {
      token: admin.token,
    });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('NOT_FOUND');
  });

  it('CA-5: list shape, order by name, status filter and literal q', async () => {
    const tag = unique();
    const a = await createSede({ name: `zeta ${tag}`, city: 'Pereira' });
    await createSede({ name: `Alfa ${tag}`, city: 'Cali' });
    await createSede({ name: `Pct ${tag} 100%`, city: 'Bogotá_Norte' });
    await call('PATCH', `/establishments/${a.id}/status`, {
      token: admin.token,
      body: { isActive: false },
    });

    const all = await call('GET', `/establishments?q=${tag}`, { token: admin.token });
    expect(all.status).toBe(200);
    expect(Object.keys(all.body).sort()).toEqual(['items', 'limit', 'offset', 'total']);
    expect(all.body.total).toBe(3);
    expect(all.body.limit).toBe(50);
    expect(all.body.items.map((i: { name: string }) => i.name)).toEqual([
      `Alfa ${tag}`,
      `Pct ${tag} 100%`,
      `zeta ${tag}`,
    ]);
    expect(all.body.items.every((i: { mapsUrl: string }) => i.mapsUrl.startsWith('https://'))).toBe(
      true,
    );

    const active = await call('GET', `/establishments?q=${tag}&status=active`, {
      token: admin.token,
    });
    expect(active.body.total).toBe(2);
    const inactive = await call('GET', `/establishments?q=${tag}&status=inactive`, {
      token: admin.token,
    });
    expect(inactive.body.items.map((i: { id: string }) => i.id)).toEqual([a.id]);

    const byCity = await call('GET', `/establishments?q=${encodeURIComponent('PEREIRA')}`, {
      token: admin.token,
    });
    expect(byCity.body.items.some((i: { id: string }) => i.id === a.id)).toBe(true);

    // % and _ are literal text
    expect(
      (await call('GET', `/establishments?q=${tag} 100%25`, { token: admin.token })).body.total,
    ).toBe(1);
    expect((await call('GET', '/establishments?q=%25', { token: admin.token })).body.total).toBe(1);
    expect(
      (await call('GET', `/establishments?q=${tag}%25`, { token: admin.token })).body.total,
    ).toBe(0);
    expect(
      (await call('GET', '/establishments?q=Bogot%C3%A1_N', { token: admin.token })).body.total,
    ).toBe(1);
    expect(
      (await call('GET', '/establishments?q=Bogot%C3%A1xN', { token: admin.token })).body.total,
    ).toBe(0);

    const paged = await call('GET', `/establishments?q=${tag}&limit=1&offset=1`, {
      token: admin.token,
    });
    expect(paged.body.items).toHaveLength(1);
    expect(paged.body.total).toBe(3);
    expect(paged.body.offset).toBe(1);
  });

  it('CA-5: orders by name with Spanish rules (accents and ñ in place, case-insensitive)', async () => {
    const tag = unique();
    for (const prefix of ['zeta', 'ñandú', 'Multipartes', 'Árbol', 'arbusto']) {
      await createSede({ name: `${prefix} ${tag}` });
    }
    const res = await call('GET', `/establishments?q=${tag}`, { token: admin.token });
    expect(res.body.items.map((i: { name: string }) => i.name)).toEqual([
      `Árbol ${tag}`,
      `arbusto ${tag}`,
      `Multipartes ${tag}`,
      `ñandú ${tag}`,
      `zeta ${tag}`,
    ]);
  });

  it('rejects an invalid list query (400)', async () => {
    for (const query of ['status=x', 'limit=0', 'limit=201', 'offset=-1']) {
      expect((await call('GET', `/establishments?${query}`, { token: admin.token })).status).toBe(
        400,
      );
    }
  });
});

describe('validation (CA-10) and uniqueness (CA-11)', () => {
  const fieldsOf = (res: Res) => (res.body.details as { field: string }[]).map((d) => d.field);

  it('missing, empty-after-trim, too long, out of range, strings and bad phone -> 400 with details', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ name: undefined }, 'name'],
      [{ name: '   ' }, 'name'],
      [{ address: '' }, 'address'],
      [{ name: 'a'.repeat(151) }, 'name'],
      [{ address: 'a'.repeat(256) }, 'address'],
      [{ city: 'a'.repeat(101) }, 'city'],
      [{ department: 'a'.repeat(101) }, 'department'],
      [{ phone: '1'.repeat(31) }, 'phone'],
      [{ phone: 'abc' }, 'phone'],
      [{ latitude: 90.1 }, 'latitude'],
      [{ latitude: -91 }, 'latitude'],
      [{ longitude: 180.1 }, 'longitude'],
      [{ longitude: -181 }, 'longitude'],
      [{ latitude: '6.25' }, 'latitude'],
      [{ longitude: '-75.5' }, 'longitude'],
    ];
    for (const [override, field] of cases) {
      const res = await call('POST', '/establishments', {
        token: admin.token,
        body: body(override),
      });
      expect(res.status, JSON.stringify(override)).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(fieldsOf(res), JSON.stringify(override)).toContain(field);
    }
  });

  it('H-5: limits apply after trimming outer spaces (accepts if it fits, 400 if it still exceeds)', async () => {
    const limits: [string, number][] = [
      ['name', 150],
      ['address', 255],
      ['city', 100],
      ['department', 100],
    ];
    for (const [field, max] of limits) {
      const over = await call('POST', '/establishments', {
        token: admin.token,
        body: body({ [field]: ` ${'b'.repeat(max + 1)} ` }),
      });
      expect(over.status, field).toBe(400);
      expect(fieldsOf(over), field).toContain(field);
    }
    const phoneOver = await call('POST', '/establishments', {
      token: admin.token,
      body: body({ phone: ` ${'1'.repeat(31)} ` }),
    });
    expect(phoneOver.status).toBe(400);
    expect(fieldsOf(phoneOver)).toContain('phone');

    const ok = await call('POST', '/establishments', {
      token: admin.token,
      body: body({
        name: `  ${'n'.repeat(150)}  `,
        address: `  ${'a'.repeat(255)}  `,
        city: `  ${'c'.repeat(100)}  `,
        department: `  ${'d'.repeat(100)}  `,
        phone: `  ${'1'.repeat(30)}  `,
      }),
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect((ok.body.name as string).length).toBe(150);
    expect((ok.body.phone as string).length).toBe(30);
  });

  it('malformed id -> 400 on get, patch and status', async () => {
    expect((await call('GET', '/establishments/abc', { token: admin.token })).status).toBe(400);
    expect(
      (await call('PATCH', '/establishments/abc', { token: admin.token, body: { city: 'x' } }))
        .status,
    ).toBe(400);
    expect(
      (
        await call('PATCH', '/establishments/abc/status', {
          token: admin.token,
          body: { isActive: true },
        })
      ).status,
    ).toBe(400);
  });

  it('CA-11: duplicate name (other case, outer spaces, inactive) -> 409; editing keeping own name -> 200', async () => {
    const created = await createSede({ name: `Unica ${unique()}` });
    const dup = await call('POST', '/establishments', {
      token: admin.token,
      body: body({ name: `  ${created.name.toUpperCase()}  ` }),
    });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('ESTABLISHMENT_NAME_TAKEN');

    await call('PATCH', `/establishments/${created.id}/status`, {
      token: admin.token,
      body: { isActive: false },
    });
    const dupInactive = await call('POST', '/establishments', {
      token: admin.token,
      body: body({ name: created.name.toLowerCase() }),
    });
    expect(dupInactive.status).toBe(409);

    const other = await createSede();
    const clash = await call('PATCH', `/establishments/${other.id}`, {
      token: admin.token,
      body: { name: created.name },
    });
    expect(clash.status).toBe(409);
    const own = await call('PATCH', `/establishments/${other.id}`, {
      token: admin.token,
      body: { name: other.name.toUpperCase(), city: 'Cali' },
    });
    expect(own.status).toBe(200);
  });

  it('concurrent creations with the same name: one 201 and the rest 409', async () => {
    const name = `Carrera ${unique()}`;
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        call('POST', '/establishments', { token: admin.token, body: body({ name }) }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
  });
});

describe('update and status', () => {
  it('CA-7: modifies only sent fields, updates updatedAt, phone null clears, empty body -> 400', async () => {
    const created = await createSede();
    const before = (await call('GET', `/establishments/${created.id}`, { token: admin.token }))
      .body;
    await new Promise((resolve) => setTimeout(resolve, 15));
    const res = await call('PATCH', `/establishments/${created.id}`, {
      token: admin.token,
      body: { city: ' Cali ', phone: null, unknown: 'ignored' },
    });
    expect(res.status).toBe(200);
    expect(res.body.city).toBe('Cali');
    expect(res.body.phone).toBeNull();
    expect(res.body.address).toBe(before.address);
    expect(res.body.name).toBe(before.name);
    expect(res.body.createdAt).toBe(before.createdAt);
    expect(new Date(res.body.updatedAt).getTime()).toBeGreaterThan(
      new Date(before.updatedAt).getTime(),
    );
    expect(res.body.mapsUrl).toBe(before.mapsUrl);

    const coords = await call('PATCH', `/establishments/${created.id}`, {
      token: admin.token,
      body: { latitude: 4.711, longitude: -74.0721 },
    });
    expect(coords.body.mapsUrl).toBe(
      'https://www.google.com/maps/search/?api=1&query=4.711,-74.0721',
    );

    const empty = await call('PATCH', `/establishments/${created.id}`, {
      token: admin.token,
      body: {},
    });
    expect(empty.status).toBe(400);
    const invalid = await call('PATCH', `/establishments/${created.id}`, {
      token: admin.token,
      body: { latitude: 95 },
    });
    expect(invalid.status).toBe(400);
  });

  it('CA-8 / CA-12: deactivate and reactivate, missing id -> 404, no DELETE route', async () => {
    const created = await createSede();
    const off = await call('PATCH', `/establishments/${created.id}/status`, {
      token: admin.token,
      body: { isActive: false },
    });
    expect(off.status).toBe(200);
    expect(off.body.isActive).toBe(false);
    expect(off.body.mapsUrl).toBeTypeOf('string');
    const active = await call('GET', `/establishments?status=active&q=${created.name}`, {
      token: admin.token,
    });
    expect(active.body.total).toBe(0);
    const on = await call('PATCH', `/establishments/${created.id}/status`, {
      token: admin.token,
      body: { isActive: true },
    });
    expect(on.body.isActive).toBe(true);
    expect(
      (
        await call('PATCH', `/establishments/${created.id}/status`, {
          token: admin.token,
          body: { isActive: 'yes' },
        })
      ).status,
    ).toBe(400);

    const missing = '00000000-0000-4000-8000-000000000000';
    expect(
      (
        await call('PATCH', `/establishments/${missing}`, {
          token: admin.token,
          body: { city: 'x' },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call('PATCH', `/establishments/${missing}/status`, {
          token: admin.token,
          body: { isActive: false },
        })
      ).status,
    ).toBe(404);
    expect([404, 405]).toContain(
      (await call('DELETE', `/establishments/${created.id}`, { token: admin.token })).status,
    );
  });

  it('403 when the role lacks update or deactivate', async () => {
    const created = await createSede();
    const reader = await actor(['establishments.read']);
    expect(
      (
        await call('PATCH', `/establishments/${created.id}`, {
          token: reader.token,
          body: { city: 'x' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call('PATCH', `/establishments/${created.id}/status`, {
          token: reader.token,
          body: { isActive: false },
        })
      ).status,
    ).toBe(403);
    expect(
      (await call('GET', `/establishments/${created.id}`, { token: reader.token })).status,
    ).toBe(200);
  });
});

describe('logs, errors and health', () => {
  it('CA-15: lifecycle events carry establishmentId and actorId; logs never hold the token', async () => {
    const created = await createSede();
    await call('PATCH', `/establishments/${created.id}`, {
      token: admin.token,
      body: { city: 'Neiva' },
    });
    await call('PATCH', `/establishments/${created.id}/status`, {
      token: admin.token,
      body: { isActive: false },
    });
    await call('PATCH', `/establishments/${created.id}/status`, {
      token: admin.token,
      body: { isActive: true },
    });
    const events = logs
      .filter((line) => line.includes(created.id))
      // The captured line is "<json> <context>": keep only the JSON object.
      .map((line) => JSON.parse(/^\{.*\}/.exec(line)![0]) as Record<string, unknown>);
    expect(events.map((e) => e.event)).toEqual([
      'establishment.created',
      'establishment.updated',
      'establishment.deactivated',
      'establishment.activated',
    ]);
    for (const event of events) {
      expect(event.establishmentId).toBe(created.id);
      expect(event.actorId).toBe(admin.userId);
    }
    expect(events[1]!.fields).toEqual(['city']);
    expect(logs.join('\n')).not.toContain(admin.token);
    expect(logs.join('\n')).not.toContain('Neiva');
  });

  it('CA-16: a database failure answers a generic 500 and logs the detail', async () => {
    const broken = await boot({ ...config, POSTGRES_PORT: 1 }, logs2);
    try {
      const res = await call('GET', '/establishments', { token: admin.token, target: broken });
      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        statusCode: 500,
        error: 'Internal Server Error',
        message: 'Error interno del servidor',
      });
      expect(res.raw).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|pg/);
      expect(logs2.join('\n')).toMatch(/PostgresAccessReader\.load/);
    } finally {
      await broken.close();
    }
  });

  it('CA-17: /health stays public with the same shape', async () => {
    const res = await call('GET', '/health');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['api', 'database', 'timestamp']);
    expect(res.body.api).toBe('up');
    expect(res.body.database).toBe('up');
  });
});

const logs2: string[] = [];

// ---------------------------------------------------------------------------------------------
// Sprint 004: offline sync protocol (ADR-0002) and CORS
// ---------------------------------------------------------------------------------------------

type Sede = { id: string; name: string; version: number; city: string; isActive: boolean };
const IDEM = 'Idempotency-Key';
const uuid = () => crypto.randomUUID();
const withKey = (key: string, extra: Record<string, string> = {}) => ({
  [IDEM]: key,
  ...extra,
});

/** Every captured log line (Nest's logger override is global: the last booted app owns it). */
const allLogs = () => [...logs, ...logs2];

/** JSON events of the captured logs that mention `needle`. */
function eventsOf(needle: string): Record<string, unknown>[] {
  return allLogs()
    .filter((line) => line.includes(needle))
    .map((line) => JSON.parse(/^\{.*\}/.exec(line)![0]) as Record<string, unknown>);
}

/** Reads the whole feed from `cursor`, page by page; returns every item and the final cursor. */
async function drain(cursor?: string, limit = 3) {
  const items: Sede[] = [];
  let next = cursor;
  for (let guard = 0; guard < 1000; guard++) {
    const query = `limit=${limit}${next ? `&cursor=${next}` : ''}`;
    const res = await call('GET', `/establishments/changes?${query}`, { token: admin.token });
    expect(res.status).toBe(200);
    items.push(...(res.body.items as Sede[]));
    next = res.body.nextCursor ?? undefined;
    if (!res.body.hasMore) return { items, cursor: next };
  }
  throw new Error('feed does not terminate');
}

describe('S4 versions and client ids (CA-2, CA-3)', () => {
  it('CA-2: every representation has version; create 1, +1 per effective change, same status keeps it', async () => {
    const created = await createSede();
    expect(created.version).toBe(1);
    const patch = (payload: object) =>
      call('PATCH', `/establishments/${created.id}`, { token: admin.token, body: payload });
    const status = (isActive: boolean) =>
      call('PATCH', `/establishments/${created.id}/status`, {
        token: admin.token,
        body: { isActive },
      });
    expect((await patch({ city: 'Cali' })).body.version).toBe(2);
    expect((await status(false)).body.version).toBe(3);
    expect((await status(false)).body.version).toBe(3);
    expect((await status(true)).body.version).toBe(4);
    const got = await call('GET', `/establishments/${created.id}`, { token: admin.token });
    expect(got.body.version).toBe(4);
    const list = await call('GET', '/establishments?limit=200', { token: admin.token });
    expect((list.body.items as Sede[]).find((e) => e.id === created.id)?.version).toBe(4);
  });

  it('CA-3: creates with the client id; a used id is 409 ESTABLISHMENT_ID_TAKEN; a bad id is 400', async () => {
    const id = uuid();
    const res = await call('POST', '/establishments', { token: admin.token, body: body({ id }) });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(id);
    const again = await call('POST', '/establishments', { token: admin.token, body: body({ id }) });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ESTABLISHMENT_ID_TAKEN');
    const bad = await call('POST', '/establishments', {
      token: admin.token,
      body: body({ id: 'not-a-uuid' }),
    });
    expect(bad.status).toBe(400);
    expect(bad.body.details[0].field).toBe('id');
  });

  it('CA-3: concurrent creations with the same client id: one 201, the rest 409 ID_TAKEN', async () => {
    const id = uuid();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        call('POST', '/establishments', { token: admin.token, body: body({ id }) }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    for (const r of results.filter((r) => r.status !== 201)) {
      expect(r.status).toBe(409);
      expect(['ESTABLISHMENT_ID_TAKEN', 'ESTABLISHMENT_NAME_TAKEN']).toContain(r.body.code);
    }
  });
});

describe('S4 Idempotency-Key (CA-4 to CA-7)', () => {
  it('CA-4: repeating POST, PATCH and PATCH status returns the same status and body without side effects', async () => {
    const postKey = uuid();
    const payload = body();
    const first = await call('POST', '/establishments', {
      token: admin.token,
      body: payload,
      headers: withKey(postKey),
    });
    expect(first.status).toBe(201);
    const id = first.body.id as string;
    const replayPost = await call('POST', '/establishments', {
      token: admin.token,
      body: payload,
      headers: withKey(postKey),
    });
    expect(replayPost.status).toBe(201);
    expect(replayPost.body).toEqual(first.body);
    const count = await pool.query('SELECT count(*) FROM establishments WHERE name = $1', [
      payload.name,
    ]);
    expect(Number(count.rows[0].count)).toBe(1);

    const patchKey = uuid();
    const patched = await call('PATCH', `/establishments/${id}`, {
      token: admin.token,
      body: { city: 'Pasto' },
      headers: withKey(patchKey),
    });
    const replayPatch = await call('PATCH', `/establishments/${id}`, {
      token: admin.token,
      body: { city: 'Pasto' },
      headers: withKey(patchKey),
    });
    expect(replayPatch.status).toBe(patched.status);
    expect(replayPatch.body).toEqual(patched.body);
    expect(replayPatch.body.version).toBe(2);

    const statusKey = uuid();
    const off = await call('PATCH', `/establishments/${id}/status`, {
      token: admin.token,
      body: { isActive: false },
      headers: withKey(statusKey),
    });
    const replayOff = await call('PATCH', `/establishments/${id}/status`, {
      token: admin.token,
      body: { isActive: false },
      headers: withKey(statusKey),
    });
    expect(replayOff.body).toEqual(off.body);
    expect(replayOff.body.version).toBe(3);

    const current = await call('GET', `/establishments/${id}`, { token: admin.token });
    expect(current.body.version).toBe(3);
    // One event per real write; replays leave their own log line.
    expect(
      eventsOf(id)
        .map((e) => e.event)
        .filter((e) => String(e).startsWith('establishment.')),
    ).toEqual(['establishment.created', 'establishment.updated', 'establishment.deactivated']);
    const replays = allLogs().filter((l) => l.includes('idempotency.replayed'));
    for (const key of [postKey, patchKey, statusKey]) {
      expect(replays.some((l) => l.includes(key) && l.includes(admin.userId))).toBe(true);
    }
  });

  it('a malformed Idempotency-Key is 400 naming the header', async () => {
    const res = await call('POST', '/establishments', {
      token: admin.token,
      body: body(),
      headers: withKey('not-a-uuid'),
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.details[0].field).toBe(IDEM);
  });

  it('H-6: alternating the If-Match format with the same key is a replay, not a reuse', async () => {
    const key = uuid();
    const sede = await createSede();
    const first = await call('PATCH', `/establishments/${sede.id}`, {
      token: admin.token,
      body: { city: 'A' },
      headers: withKey(key, { 'If-Match': '"1"' }),
    });
    expect(first.status).toBe(200);
    const again = await call('PATCH', `/establishments/${sede.id}`, {
      token: admin.token,
      body: { city: 'A' },
      headers: withKey(key, { 'If-Match': '1' }),
    });
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    const current = await call('GET', `/establishments/${sede.id}`, { token: admin.token });
    expect(current.body.version).toBe(2);
  });

  it('CA-5: same key with other content is 409 IDEMPOTENCY_KEY_REUSED (also for If-Match)', async () => {
    const key = uuid();
    const sede = await createSede();
    const ok = await call('PATCH', `/establishments/${sede.id}`, {
      token: admin.token,
      body: { city: 'A' },
      headers: withKey(key),
    });
    expect(ok.status).toBe(200);
    for (const [payload, extra] of [
      [{ city: 'B' }, {}],
      [{ city: 'A' }, { 'If-Match': '"2"' }],
    ] as const) {
      const res = await call('PATCH', `/establishments/${sede.id}`, {
        token: admin.token,
        body: payload,
        headers: withKey(key, extra),
      });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    }
    const other = await call('PATCH', `/establishments/${uuid()}`, {
      token: admin.token,
      body: { city: 'A' },
      headers: withKey(key),
    });
    expect(other.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('CA-5: simultaneous requests with the same key apply once', async () => {
    const key = uuid();
    const payload = body();
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        call('POST', '/establishments', {
          token: admin.token,
          body: payload,
          headers: withKey(key),
        }),
      ),
    );
    const created = results.filter((r) => r.status === 201);
    expect(created.length).toBeGreaterThanOrEqual(1);
    for (const r of results.filter((r) => r.status !== 201)) {
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('IDEMPOTENCY_IN_PROGRESS');
    }
    expect(new Set(created.map((r) => r.body.id)).size).toBe(1);
    const count = await pool.query('SELECT count(*) FROM establishments WHERE name = $1', [
      payload.name,
    ]);
    expect(Number(count.rows[0].count)).toBe(1);
  });

  it('CA-6: failed writes do not keep the key; the retry after fixing the cause is applied', async () => {
    const user = await actor(['establishments.read']);
    const key = uuid();
    const payload = body();
    const denied = await call('POST', '/establishments', {
      token: user.token,
      body: payload,
      headers: withKey(key),
    });
    expect(denied.status).toBe(403);
    await pool.query(
      `INSERT INTO role_permissions (role_id, permission_id)
       SELECT $1, id FROM permissions WHERE code = 'establishments.create'`,
      [user.roleId],
    );
    const retry = await call('POST', '/establishments', {
      token: user.token,
      body: payload,
      headers: withKey(key),
    });
    expect(retry.status).toBe(201);

    const stored = await pool.query('SELECT 1 FROM idempotency_keys WHERE actor_id = $1', [
      user.userId,
    ]);
    expect(stored.rows).toHaveLength(1);

    // 400 (invalid data), 404 and 409 (name taken) also release the key.
    const key2 = uuid();
    const sede = await createSede();
    const invalid = await call('PATCH', `/establishments/${sede.id}`, {
      token: admin.token,
      body: { city: '' },
      headers: withKey(key2),
    });
    expect(invalid.status).toBe(400);
    const fixed = await call('PATCH', `/establishments/${sede.id}`, {
      token: admin.token,
      body: { city: '' },
      headers: withKey(key2),
    });
    expect(fixed.status).toBe(400);
    const missing = await call('PATCH', `/establishments/${uuid()}`, {
      token: admin.token,
      body: { city: 'X' },
      headers: withKey(uuid()),
    });
    expect(missing.status).toBe(404);
    const rows = await pool.query(
      `SELECT 1 FROM idempotency_keys WHERE actor_id = $1 AND key = $2`,
      [admin.userId, key2],
    );
    expect(rows.rows).toHaveLength(0);
  });

  it('CA-7: the same key from another user never returns the first response', async () => {
    const key = uuid();
    const payload = body();
    const first = await call('POST', '/establishments', {
      token: admin.token,
      body: payload,
      headers: withKey(key),
    });
    expect(first.status).toBe(201);
    const other = await actor(ALL);
    const second = await call('POST', '/establishments', {
      token: other.token,
      body: payload,
      headers: withKey(key),
    });
    // Not a replay: the other actor's request runs on its own (name already taken -> 409).
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('ESTABLISHMENT_NAME_TAKEN');
    const fresh = await call('POST', '/establishments', {
      token: other.token,
      body: body(),
      headers: withKey(key),
    });
    expect(fresh.status).toBe(201);
    expect(fresh.body.id).not.toBe(first.body.id);
  });

  it('a replay still requires a valid token and the endpoint permission', async () => {
    const key = uuid();
    const user = await actor(['establishments.read', 'establishments.create']);
    const payload = body();
    expect(
      (
        await call('POST', '/establishments', {
          token: user.token,
          body: payload,
          headers: withKey(key),
        })
      ).status,
    ).toBe(201);
    await pool.query(
      `DELETE FROM role_permissions WHERE role_id = $1
       AND permission_id = (SELECT id FROM permissions WHERE code = 'establishments.create')`,
      [user.roleId],
    );
    const replay = await call('POST', '/establishments', {
      token: user.token,
      body: payload,
      headers: withKey(key),
    });
    expect(replay.status).toBe(403);
    const anonymous = await call('POST', '/establishments', {
      body: payload,
      headers: withKey(key),
    });
    expect(anonymous.status).toBe(401);
  });
});

describe('S4 If-Match (CA-8 to CA-10, CA-15)', () => {
  it('CA-8: matching version applies; stale version is 409 VERSION_CONFLICT with current, unchanged, logged', async () => {
    const sede = await createSede();
    const ok = await call('PATCH', `/establishments/${sede.id}`, {
      token: admin.token,
      body: { city: 'Cali' },
      headers: { 'If-Match': '"1"' },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.version).toBe(2);

    const stale = await call('PATCH', `/establishments/${sede.id}`, {
      token: admin.token,
      body: { city: 'Pasto' },
      headers: { 'If-Match': '"1"' },
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('VERSION_CONFLICT');
    expect(stale.body.current.city).toBe('Cali');
    expect(stale.body.current.version).toBe(2);
    expect(stale.body.current.mapsUrl).toContain('google.com/maps');
    const unchanged = await call('GET', `/establishments/${sede.id}`, { token: admin.token });
    expect(unchanged.body.city).toBe('Cali');
    expect(unchanged.body.version).toBe(2);

    const staleStatus = await call('PATCH', `/establishments/${sede.id}/status`, {
      token: admin.token,
      body: { isActive: false },
      headers: { 'If-Match': '1' },
    });
    expect(staleStatus.status).toBe(409);
    expect(staleStatus.body.current.isActive).toBe(true);
    const okStatus = await call('PATCH', `/establishments/${sede.id}/status`, {
      token: admin.token,
      body: { isActive: false },
      headers: { 'If-Match': '2' },
    });
    expect(okStatus.status).toBe(200);
    expect(okStatus.body.version).toBe(3);

    const conflicts = eventsOf(sede.id).filter((e) => e.event === 'establishment.version_conflict');
    expect(conflicts).toHaveLength(2);
    expect(conflicts[0]).toMatchObject({
      establishmentId: sede.id,
      actorId: admin.userId,
      expectedVersion: 1,
      currentVersion: 2,
    });
  });

  it('CA-8: of two simultaneous edits with the same If-Match exactly one wins', async () => {
    const sede = await createSede();
    const results = await Promise.all(
      ['A', 'B', 'C', 'D'].map((city) =>
        call('PATCH', `/establishments/${sede.id}`, {
          token: admin.token,
          body: { city },
          headers: { 'If-Match': '"1"' },
        }),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    for (const r of results.filter((r) => r.status !== 200)) {
      expect(r.body.code).toBe('VERSION_CONFLICT');
    }
    const final = await call('GET', `/establishments/${sede.id}`, { token: admin.token });
    expect(final.body.version).toBe(2);
  });

  it('CA-8: same state with a stale If-Match is still a conflict', async () => {
    const sede = await createSede();
    const res = await call('PATCH', `/establishments/${sede.id}/status`, {
      token: admin.token,
      body: { isActive: true },
      headers: { 'If-Match': '9' },
    });
    expect(res.status).toBe(409);
  });

  it('CA-9: without If-Match the sprint 003 behaviour holds; malformed or * is 400', async () => {
    const sede = await createSede();
    expect(
      (
        await call('PATCH', `/establishments/${sede.id}`, {
          token: admin.token,
          body: { city: 'Sin precondicion' },
        })
      ).status,
    ).toBe(200);
    for (const value of ['*', 'abc', '0', '"1", "2"', 'W/"1"']) {
      for (const [url, payload] of [
        [`/establishments/${sede.id}`, { city: 'x' }],
        [`/establishments/${sede.id}/status`, { isActive: false }],
      ] as const) {
        const res = await call('PATCH', url, {
          token: admin.token,
          body: payload,
          headers: { 'If-Match': value },
        });
        expect(res.status, `${url} If-Match ${value}`).toBe(400);
        expect(res.body.code).toBe('VALIDATION_ERROR');
        expect(res.body.details[0].field).toBe('If-Match');
      }
    }
  });

  it('CA-10: errors come in order 400 -> 404 -> VERSION_CONFLICT -> NAME_TAKEN', async () => {
    const a = await createSede();
    const b = await createSede();
    const headers = { 'If-Match': '"9"' };
    const invalid = await call('PATCH', `/establishments/${a.id}`, {
      token: admin.token,
      body: { name: '' },
      headers,
    });
    expect(invalid.status).toBe(400);
    const missing = await call('PATCH', `/establishments/${uuid()}`, {
      token: admin.token,
      body: { name: 'Nuevo nombre' },
      headers,
    });
    expect(missing.status).toBe(404);
    const stale = await call('PATCH', `/establishments/${a.id}`, {
      token: admin.token,
      body: { name: b.name },
      headers,
    });
    expect(stale.body.code).toBe('VERSION_CONFLICT');
    const taken = await call('PATCH', `/establishments/${a.id}`, {
      token: admin.token,
      body: { name: b.name },
      headers: { 'If-Match': '"1"' },
    });
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe('ESTABLISHMENT_NAME_TAKEN');
  });

  it('CA-15: when syncing, permissions, validation and uniqueness of the moment apply', async () => {
    const user = await actor(['establishments.read', 'establishments.create']);
    const before = await pool.query('SELECT count(*) FROM establishments');
    await pool.query(
      `DELETE FROM role_permissions WHERE role_id = $1
       AND permission_id = (SELECT id FROM permissions WHERE code = 'establishments.create')`,
      [user.roleId],
    );
    const id = uuid();
    const denied = await call('POST', '/establishments', {
      token: user.token,
      body: body({ id }),
      headers: withKey(uuid()),
    });
    expect(denied.status).toBe(403);
    const after = await pool.query('SELECT count(*) FROM establishments');
    expect(after.rows[0].count).toBe(before.rows[0].count);
    const missing = await call('GET', `/establishments/${id}`, { token: admin.token });
    expect(missing.status).toBe(404);

    const existing = await createSede();
    const taken = await call('POST', '/establishments', {
      token: admin.token,
      body: body({ id: uuid(), name: existing.name.toUpperCase() }),
      headers: withKey(uuid()),
    });
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe('ESTABLISHMENT_NAME_TAKEN');
  });
});

describe('S4 change feed (CA-11 to CA-14)', () => {
  it('CA-11: without cursor returns every establishment (active and inactive) without repeats or gaps', async () => {
    for (let i = 0; i < 4; i++) await createSede();
    const off = await createSede();
    await call('PATCH', `/establishments/${off.id}/status`, {
      token: admin.token,
      body: { isActive: false },
    });
    const { items } = await drain(undefined, 3);
    const ids = items.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const all = await pool.query<{ id: string }>('SELECT id FROM establishments');
    expect([...ids].sort()).toEqual(all.rows.map((r) => r.id).sort());
    expect(items.find((e) => e.id === off.id)?.isActive).toBe(false);

    const page = await call('GET', '/establishments/changes?limit=2', { token: admin.token });
    expect(page.status).toBe(200);
    expect(Object.keys(page.body).sort()).toEqual(['hasMore', 'items', 'nextCursor']);
    expect(page.body.items).toHaveLength(2);
    expect(page.body.hasMore).toBe(true);
    expect(typeof page.body.nextCursor).toBe('string');
  });

  it('CA-12: from a cursor returns exactly what was created, edited, activated or deactivated after', async () => {
    const a = await createSede();
    const b = await createSede();
    const { cursor } = await drain();
    expect(cursor).toBeTruthy();
    const idle = await call('GET', `/establishments/changes?cursor=${cursor}`, {
      token: admin.token,
    });
    expect(idle.body).toEqual({ items: [], nextCursor: cursor, hasMore: false });

    const c = await createSede();
    await call('PATCH', `/establishments/${a.id}`, {
      token: admin.token,
      body: { city: 'Leticia' },
    });
    await call('PATCH', `/establishments/${b.id}/status`, {
      token: admin.token,
      body: { isActive: false },
    });
    const { items, cursor: end } = await drain(cursor);
    expect(items.map((e) => e.id).sort()).toEqual([a.id, b.id, c.id].sort());
    expect(items.find((e) => e.id === a.id)?.city).toBe('Leticia');
    expect(items.find((e) => e.id === b.id)?.isActive).toBe(false);
    expect((await drain(end)).items).toEqual([]);
  });

  it('CA-12: an idempotent replay or a conflict does not produce feed entries', async () => {
    const a = await createSede();
    const { cursor } = await drain();
    await call('PATCH', `/establishments/${a.id}`, {
      token: admin.token,
      body: { city: 'X' },
      headers: { 'If-Match': '"9"' },
    });
    await call('PATCH', `/establishments/${a.id}/status`, {
      token: admin.token,
      body: { isActive: true },
    });
    expect((await drain(cursor)).items).toEqual([]);
  });

  it('CA-13: a change in a transaction still open while reading is not lost: it shows up later', async () => {
    const open = await createSede();
    const { cursor: start } = await drain();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE establishments SET city = 'Pendiente', version = version + 1,
           change_xid = pg_current_xact_id() WHERE id = $1`,
        [open.id],
      );
      // A later transaction commits while the first one is still open.
      const later = await createSede();

      const during = await call('GET', `/establishments/changes?cursor=${start}`, {
        token: admin.token,
      });
      expect(during.status).toBe(200);
      const seen = (during.body.items as Sede[]).map((e) => e.id);
      expect(seen).not.toContain(open.id);
      expect(seen).not.toContain(later.id);
      expect(during.body.nextCursor).toBe(start);

      await client.query('COMMIT');
      const { items } = await drain(during.body.nextCursor);
      const ids = items.map((e) => e.id);
      expect(ids).toContain(open.id);
      expect(ids).toContain(later.id);
      expect(items.find((e) => e.id === open.id)?.city).toBe('Pendiente');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('CA-14: invalid cursor or limit is 400 and "changes" is not read as an id', async () => {
    const token = admin.token;
    const bad = [
      'cursor=***',
      `cursor=${Buffer.from('{oops').toString('base64url')}`,
      `cursor=${Buffer.from(JSON.stringify({ x: '12a', i: uuid() })).toString('base64url')}`,
      `cursor=${Buffer.from(JSON.stringify({ x: '1', i: 'nope' })).toString('base64url')}`,
      `cursor=${Buffer.from(JSON.stringify({ x: '99999999999999999999999', i: uuid() })).toString('base64url')}`,
      'limit=0',
      'limit=501',
      'limit=abc',
    ];
    for (const query of bad) {
      const res = await call('GET', `/establishments/changes?${query}`, { token });
      expect(res.status, query).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    }
    const edge = await call('GET', '/establishments/changes?limit=500', { token });
    expect(edge.status).toBe(200);
    const plain = await call('GET', '/establishments/changes', { token });
    expect(plain.status).toBe(200);
    expect(plain.body).toHaveProperty('items');
  });

  it('the feed requires establishments.read', async () => {
    const user = await actor(['establishments.create']);
    expect((await call('GET', '/establishments/changes', { token: user.token })).status).toBe(403);
    expect((await call('GET', '/establishments/changes')).status).toBe(401);
  });
});

describe('S4 CORS (CA-17)', () => {
  const allowed = 'http://localhost:5173';

  it('with CORS_ORIGINS: preflight and requests from the allowed origin carry CORS headers', async () => {
    const cors = await boot(
      { ...config, corsOrigins: [allowed, 'https://app.example.com'] },
      logs2,
    );
    try {
      const pre = await cors.inject({
        method: 'OPTIONS',
        url: '/establishments',
        headers: {
          origin: allowed,
          'access-control-request-method': 'PATCH',
          'access-control-request-headers': 'authorization,idempotency-key,if-match,content-type',
        },
      });
      expect(pre.statusCode).toBeLessThan(300);
      expect(pre.headers['access-control-allow-origin']).toBe(allowed);
      expect(String(pre.headers['access-control-allow-methods'])).toMatch(/PATCH/);
      const headers = String(pre.headers['access-control-allow-headers']).toLowerCase();
      for (const name of ['authorization', 'content-type', 'idempotency-key', 'if-match']) {
        expect(headers).toContain(name);
      }
      expect(pre.headers['access-control-allow-credentials']).toBeUndefined();

      const real = await call('GET', '/establishments?limit=1', {
        token: admin.token,
        target: cors,
        headers: { origin: allowed },
      });
      expect(real.status).toBe(200);
      const response = await cors.inject({
        method: 'GET',
        url: '/health',
        headers: { origin: 'https://app.example.com' },
      });
      expect(response.headers['access-control-allow-origin']).toBe('https://app.example.com');

      const denied = await cors.inject({
        method: 'OPTIONS',
        url: '/establishments',
        headers: { origin: 'http://evil.example', 'access-control-request-method': 'GET' },
      });
      expect(denied.headers['access-control-allow-origin']).toBeUndefined();
      const deniedGet = await cors.inject({
        method: 'GET',
        url: '/health',
        headers: { origin: 'http://evil.example' },
      });
      expect(deniedGet.headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      await cors.close();
    }
  });

  it('without CORS_ORIGINS there are no CORS headers', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: allowed },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
