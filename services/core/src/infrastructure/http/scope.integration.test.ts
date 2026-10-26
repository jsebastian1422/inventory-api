import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { importPKCS8, SignJWT } from 'jose';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACCESS_TOKEN_ISSUER,
  CATEGORY_PERMISSIONS,
  INVENTORY_PERMISSIONS,
  PRODUCT_PERMISSIONS,
} from '@inventory/shared';
import { loadConfig, type AppConfig } from '../config/config.js';
import { AppModule } from './app.module.js';

/**
 * Integration tests (sprint 006) over HTTP against a real PostgreSQL TEST database: assignments of
 * users to establishments, "my establishments", stock search and the feeds with scope (ADR-0004).
 * Users and roles are inserted with SQL (identity owns those tables). Everything created here is
 * removed at the end.
 */
const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const testDb = process.env.POSTGRES_TEST_DB ?? 'inventory_test';
const unique = () => randomBytes(4).toString('hex');
const ZERO = '00000000-0000-4000-8000-000000000000';

let app: NestFastifyApplication;
let pool: Pool;
let config: AppConfig;
let privatePem: string;
const logs: string[] = [];
const establishmentIds: string[] = [];
const userIds: string[] = [];
const roleIds: string[] = [];

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
  let body: unknown;
  try {
    body = response.body ? JSON.parse(response.body) : undefined;
  } catch {
    body = response.body;
  }
  return { status: response.statusCode, raw: response.body, body };
}

async function sign(userId: string): Promise<string> {
  const key = await importPKCS8(privatePem, 'ES256');
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256' })
    .setSubject(userId)
    .setIssuer(ACCESS_TOKEN_ISSUER)
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(key);
}

type Actor = Awaited<ReturnType<typeof actor>>;

/** Creates a role with the given permissions and an active user in it. */
async function actor(codes: readonly string[], isActive = true) {
  const role = await pool.query<{ id: string }>(
    `INSERT INTO roles (name, description) VALUES ($1, 'test') RETURNING id`,
    [`Rol ${unique()}`],
  );
  const roleId = role.rows[0]!.id;
  roleIds.push(roleId);
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
    [`scope-${unique()}@example.test`, roleId, isActive],
  );
  const userId = user.rows[0]!.id;
  userIds.push(userId);
  return { userId, roleId, token: await sign(userId) };
}

const CATALOG = [...CATEGORY_PERMISSIONS, ...PRODUCT_PERMISSIONS, ...INVENTORY_PERMISSIONS];
let builder: Actor;
let assigner: Actor;

const as = (
  who: Actor,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  body?: unknown,
) => call(method, url, { token: who.token, body });
const build = (method: 'POST' | 'PATCH', url: string, body: unknown) =>
  as(builder, method, url, body);
const assign = (est: string, user: string, who: Actor = assigner) =>
  as(who, 'PUT', `/establishments/${est}/users/${user}`);
const unassign = (est: string, user: string, who: Actor = assigner) =>
  as(who, 'DELETE', `/establishments/${est}/users/${user}`);

async function mkEstablishment(isActive = true): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO establishments (name, address, city, department, latitude, longitude, is_active)
     VALUES ($1, 'Cra 1', 'Medellín', 'Antioquia', 6.25, -75.56, $2) RETURNING id`,
    [`Sede ${unique()}`, isActive],
  );
  establishmentIds.push(rows[0]!.id);
  return rows[0]!.id;
}

async function mkProduct(overrides: Record<string, unknown> = {}) {
  const category = await build('POST', '/categories', {
    code: `C-${unique()}`.toUpperCase(),
    name: `Categoría ${unique()}`,
  });
  const res = await build('POST', '/products', {
    sku: `SKU-${unique()}`,
    name: `Producto ${unique()}`,
    unit: 'unit',
    categoryId: category.body.id,
    price: '12500.50',
    ...overrides,
  });
  expect(res.status, res.raw).toBe(201);
  return res.body as { id: string; sku: string; name: string };
}

async function mkInventory(establishmentId: string, name = `Inventario ${unique()}`) {
  const res = await build('POST', '/inventories', {
    establishmentId,
    name,
    startDate: '2026-01-01',
    endDate: '2026-01-31',
    origin: 'Proveedor X',
  });
  expect(res.status, res.raw).toBe(201);
  return res.body as { id: string; name: string };
}

async function mkLine(
  inventoryId: string,
  productId: string,
  overrides: Record<string, unknown> = {},
) {
  const res = await build('POST', `/inventories/${inventoryId}/lines`, {
    productId,
    barcode: `BC-${unique()}`,
    quantityInitial: '10',
    quantityAlert: '2',
    ...overrides,
  });
  expect(res.status, res.raw).toBe(201);
  return res.body as { id: string; barcode: string };
}

/** Parsed JSON audit events of the given name. */
function events(name: string): Record<string, unknown>[] {
  return logs
    .filter((line) => line.includes(`"event":"${name}"`) && /^\{.*\}/.test(line))
    .map((line) => JSON.parse(/^\{.*\}/.exec(line)![0]) as Record<string, unknown>);
}

async function clean() {
  if (establishmentIds.length > 0) {
    await pool.query('DELETE FROM establishment_users WHERE establishment_id = ANY($1::uuid[])', [
      establishmentIds,
    ]);
  }
  await pool.query('DELETE FROM inventory_line_history');
  await pool.query('DELETE FROM inventory_lines');
  await pool.query('DELETE FROM inventories');
  await pool.query('DELETE FROM product_price_history');
  await pool.query('DELETE FROM products');
  await pool.query('DELETE FROM categories');
  if (establishmentIds.length > 0) {
    await pool.query('DELETE FROM establishments WHERE id = ANY($1::uuid[])', [establishmentIds]);
  }
  await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
  await pool.query('DELETE FROM role_permissions WHERE role_id = ANY($1::uuid[])', [roleIds]);
  await pool.query('DELETE FROM roles WHERE id = ANY($1::uuid[])', [roleIds]);
}

beforeAll(async () => {
  if (!testDb.endsWith('_test')) throw new Error('POSTGRES_TEST_DB must end with _test');
  const env = { ...process.env, POSTGRES_DB: testDb };
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
  config = loadConfig({ ...env, CORS_ORIGINS: '', JWT_PUBLIC_KEY: publicPem });
  try {
    execFileSync(
      process.execPath,
      ['node_modules/node-pg-migrate/bin/node-pg-migrate.js', 'up', '-f', 'migrate.config.cjs'],
      { cwd: root, env, stdio: 'pipe' },
    );
  } catch (error) {
    throw new Error(`Cannot migrate ${testDb}: ${String(error)}`, { cause: error });
  }
  pool = new Pool({
    host: config.POSTGRES_HOST,
    port: config.POSTGRES_PORT,
    user: config.POSTGRES_USER,
    password: config.POSTGRES_PASSWORD,
    database: testDb,
  });
  await clean();
  const capture = (...args: unknown[]) => logs.push(args.map(String).join(' '));
  app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register(config),
    new FastifyAdapter(),
    { logger: { log: capture, warn: capture, error: capture, debug: capture, verbose: capture } },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  builder = await actor(CATALOG);
  assigner = await actor(['establishments.assign']);
});

afterAll(async () => {
  await clean();
  await app?.close();
  await pool?.end();
});

// ---------------------------------------------------------------------------------------------

describe('schema (CA-1) and permissions (CA-2)', () => {
  it('establishment_users has the columns, FK RESTRICT, CHECK and partial indexes of the spec', async () => {
    const cols = await pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_name = 'establishment_users' ORDER BY column_name`,
    );
    expect(cols.rows.map((r) => r.column_name)).toEqual([
      'assigned_at',
      'assigned_by',
      'establishment_id',
      'id',
      'removed_at',
      'removed_by',
      'user_id',
    ]);
    const nullable = cols.rows.filter((r) => r.is_nullable === 'YES').map((r) => r.column_name);
    expect(nullable.sort()).toEqual(['removed_at', 'removed_by']);
    const constraints = await pool.query<{ conname: string; def: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conrelid = 'establishment_users'::regclass`,
    );
    const fks = constraints.rows.filter((r) => r.def.startsWith('FOREIGN KEY'));
    expect(fks).toHaveLength(1);
    expect(fks[0]!.def).toMatch(/FOREIGN KEY \(establishment_id\) REFERENCES establishments\(id\)/);
    expect(fks[0]!.def).toMatch(/ON DELETE RESTRICT/);
    expect(
      constraints.rows.find((r) => r.conname === 'establishment_users_removed_check')?.def,
    ).toMatch(/removed_at IS NULL/);
    const indexes = await pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'establishment_users'`,
    );
    const def = (name: string) => indexes.rows.find((r) => r.indexname === name)?.indexdef ?? '';
    expect(def('establishment_users_active_key')).toMatch(
      /UNIQUE INDEX .*\(establishment_id, user_id\) WHERE \(removed_at IS NULL\)/,
    );
    expect(def('establishment_users_user_active_idx')).toMatch(
      /\(user_id\) WHERE \(removed_at IS NULL\)/,
    );
  });

  it('the CHECK rejects a half-filled removal and the unique index a second current pair', async () => {
    const est = await mkEstablishment();
    const user = await actor([]);
    await expect(
      pool.query(
        `INSERT INTO establishment_users (establishment_id, user_id, assigned_by, removed_at)
         VALUES ($1, $2, $2, now())`,
        [est, user.userId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    const insert = () =>
      pool.query(
        `INSERT INTO establishment_users (establishment_id, user_id, assigned_by) VALUES ($1, $2, $2)`,
        [est, user.userId],
      );
    await insert();
    await expect(insert()).rejects.toMatchObject({ code: '23505' });
    await expect(
      pool.query('DELETE FROM establishments WHERE id = $1', [est]),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('the 3 permissions exist with Spanish descriptions and the Administrador holds them', async () => {
    const { rows } = await pool.query<{ code: string; description: string; assigned: boolean }>(
      `SELECT p.code, p.description,
         EXISTS (SELECT 1 FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
                 WHERE rp.permission_id = p.id AND r.is_system) AS assigned
       FROM permissions p
       WHERE p.code IN ('establishments.assign', 'establishments.all', 'stock.search')
       ORDER BY p.code`,
    );
    expect(rows).toEqual([
      { code: 'establishments.all', description: 'Acceso a todos los locales', assigned: true },
      {
        code: 'establishments.assign',
        description: 'Asignar y retirar usuarios de locales',
        assigned: true,
      },
      {
        code: 'stock.search',
        description: 'Buscar existencias en sus locales',
        assigned: true,
      },
    ]);
  });
});

describe('assign and remove (CA-3, CA-4, CA-12, CA-13)', () => {
  it('assigns (201), repeats (200, same assignment, no new event) and answers the full representation', async () => {
    const est = await mkEstablishment();
    const employee = await actor([]);
    const first = await assign(est, employee.userId);
    expect(first.status, first.raw).toBe(201);
    expect(first.body).toMatchObject({
      establishmentId: est,
      user: { id: employee.userId, fullName: 'Usuario de prueba', isActive: true },
      assignedBy: assigner.userId,
      removedBy: null,
      removedAt: null,
    });
    expect(first.body.user.email).toMatch(/@example\.test$/);
    const again = await assign(est, employee.userId);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    const rows = await pool.query(
      'SELECT 1 FROM establishment_users WHERE establishment_id = $1 AND user_id = $2',
      [est, employee.userId],
    );
    expect(rows.rowCount).toBe(1);
    const assigned = events('establishment.user_assigned').filter(
      (e) => e.establishmentId === est && e.userId === employee.userId,
    );
    expect(assigned).toEqual([
      {
        event: 'establishment.user_assigned',
        establishmentId: est,
        userId: employee.userId,
        actorId: assigner.userId,
      },
    ]);
  });

  it('error codes: 400, 404, 409 and 403 (own user), in the documented order', async () => {
    const est = await mkEstablishment();
    const inactiveEst = await mkEstablishment(false);
    const employee = await actor([]);
    const inactiveUser = await actor([], false);
    expect((await assign('no-uuid', employee.userId)).status).toBe(400);
    expect((await assign(est, 'no-uuid')).status).toBe(400);
    expect((await assign(crypto.randomUUID(), employee.userId)).status).toBe(404);
    expect((await assign(est, crypto.randomUUID())).status).toBe(404);
    const e409 = await assign(inactiveEst, employee.userId);
    expect(e409).toMatchObject({ status: 409, body: { code: 'ESTABLISHMENT_INACTIVE' } });
    const u409 = await assign(est, inactiveUser.userId);
    expect(u409).toMatchObject({ status: 409, body: { code: 'USER_INACTIVE' } });
    // establishment problems come before user problems
    expect((await assign(inactiveEst, crypto.randomUUID())).body.code).toBe(
      'ESTABLISHMENT_INACTIVE',
    );
    const self = await assign(est, assigner.userId);
    expect(self).toMatchObject({ status: 403, body: { code: 'SELF_ASSIGNMENT' } });
    const selfRemove = await unassign(est, assigner.userId);
    expect(selfRemove).toMatchObject({ status: 403, body: { code: 'SELF_ASSIGNMENT' } });
    // DEF-1: the actor's own UUID in uppercase is still the actor
    const upper = assigner.userId.toUpperCase();
    expect(await assign(est, upper)).toMatchObject({
      status: 403,
      body: { code: 'SELF_ASSIGNMENT' },
    });
    expect(await unassign(est, upper)).toMatchObject({
      status: 403,
      body: { code: 'SELF_ASSIGNMENT' },
    });
    // an uppercase id of another endpoint behaves like the lowercase one
    const upperUser = employee.userId.toUpperCase();
    expect((await assign(est.toUpperCase(), upperUser)).status).toBe(201);
    expect((await assign(est, employee.userId)).status).toBe(200);
    expect((await unassign(est.toUpperCase(), upperUser)).status).toBe(204);
    const count = await pool.query(
      'SELECT 1 FROM establishment_users WHERE establishment_id = $1 AND removed_at IS NULL',
      [est],
    );
    expect(count.rowCount).toBe(0);
  });

  it('removal from an unknown establishment is 404 worded about the establishment; own user is still 403 first', async () => {
    const employee = await actor([]);
    const unknown = await unassign(crypto.randomUUID(), employee.userId);
    expect(unknown.status).toBe(404);
    expect(unknown.body.message).toMatch(/Establecimiento/);
    expect(unknown.body.message).not.toMatch(/asignado/);
    expect((await unassign(crypto.randomUUID(), assigner.userId)).status).toBe(403);
    const est = await mkEstablishment();
    const notAssigned = await unassign(est, employee.userId);
    expect(notAssigned.status).toBe(404);
    expect(notAssigned.body.message).toMatch(/asignado/);
  });

  it('removes (204) keeping who and when; again is 404; reassigning creates a new row and keeps the history', async () => {
    const est = await mkEstablishment();
    const employee = await actor([]);
    const first = await assign(est, employee.userId);
    const removed = await unassign(est, employee.userId);
    expect(removed.status).toBe(204);
    const row = await pool.query<{ removed_by: string; removed_at: Date }>(
      'SELECT removed_by, removed_at FROM establishment_users WHERE id = $1',
      [first.body.id],
    );
    expect(row.rows[0]!.removed_by).toBe(assigner.userId);
    expect(row.rows[0]!.removed_at).toBeInstanceOf(Date);
    expect((await unassign(est, employee.userId)).status).toBe(404);
    expect((await unassign(est, crypto.randomUUID())).status).toBe(404);
    const second = await assign(est, employee.userId);
    expect(second.status).toBe(201);
    expect(second.body.id).not.toBe(first.body.id);
    const history = await as(assigner, 'GET', `/establishments/${est}/users?includeRemoved=true`);
    expect(history.body.total).toBe(2);
    expect(history.body.items.map((i: { id: string }) => i.id).sort()).toEqual(
      [first.body.id, second.body.id].sort(),
    );
    const removedEvents = events('establishment.user_removed').filter(
      (e) => e.establishmentId === est,
    );
    expect(removedEvents).toEqual([
      {
        event: 'establishment.user_removed',
        establishmentId: est,
        userId: employee.userId,
        actorId: assigner.userId,
      },
    ]);
  });

  it('removing from an inactive establishment is allowed', async () => {
    const est = await mkEstablishment();
    const employee = await actor([]);
    await assign(est, employee.userId);
    await pool.query('UPDATE establishments SET is_active = false WHERE id = $1', [est]);
    expect((await unassign(est, employee.userId)).status).toBe(204);
  });

  it('only establishments.assign: assigns and removes, nothing else (CA-12)', async () => {
    const est = await mkEstablishment();
    const employee = await actor([]);
    expect((await assign(est, employee.userId)).status).toBe(201);
    for (const [method, url] of [
      ['GET', '/inventories'],
      ['POST', '/inventories'],
      ['GET', '/products'],
      ['GET', '/establishments'],
      ['GET', '/stock/search'],
      ['GET', '/stock/lines/changes'],
    ] as const) {
      expect(
        (await as(assigner, method, url, method === 'POST' ? {} : undefined)).status,
        url,
      ).toBe(403);
    }
    const noPermission = await actor(['stock.search']);
    expect((await assign(est, employee.userId, noPermission)).status).toBe(403);
    expect((await unassign(est, employee.userId, noPermission)).status).toBe(403);
    expect((await as(noPermission, 'GET', `/establishments/${est}/users`)).status).toBe(403);
    expect((await call('PUT', `/establishments/${est}/users/${employee.userId}`)).status).toBe(401);
  });

  it('concurrent assignments of one pair leave one current row: one 201, the rest 200, no 500 (CA-6)', async () => {
    const est = await mkEstablishment();
    const employee = await actor([]);
    const before = events('establishment.user_assigned').length;
    const results = await Promise.all(
      Array.from({ length: 8 }, () => assign(est, employee.userId)),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 200, 200, 201]);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    const current = await pool.query(
      'SELECT 1 FROM establishment_users WHERE establishment_id = $1 AND removed_at IS NULL',
      [est],
    );
    expect(current.rowCount).toBe(1);
    expect(events('establishment.user_assigned').length - before).toBe(1);
  });

  it('concurrent removals: one 204 and the rest 404 (CA-6)', async () => {
    const est = await mkEstablishment();
    const employee = await actor([]);
    await assign(est, employee.userId);
    const before = events('establishment.user_removed').length;
    const results = await Promise.all(
      Array.from({ length: 6 }, () => unassign(est, employee.userId)),
    );
    expect(results.map((r) => r.status).sort()).toEqual([204, 404, 404, 404, 404, 404]);
    expect(events('establishment.user_removed').length - before).toBe(1);
  });
});

describe('listing assignments (CA-5)', () => {
  it('one user in several establishments and one establishment with several users, paginated', async () => {
    const [a, b, c] = [await mkEstablishment(), await mkEstablishment(), await mkEstablishment()];
    const u1 = await actor([]);
    const u2 = await actor([]);
    for (const est of [a, b, c]) expect((await assign(est, u1.userId)).status).toBe(201);
    expect((await assign(a, u2.userId)).status).toBe(201);
    await unassign(c, u1.userId);

    const byUser = await as(assigner, 'GET', `/establishment-assignments?userId=${u1.userId}`);
    expect(byUser.status).toBe(200);
    expect(byUser.body).toMatchObject({ total: 2, limit: 50, offset: 0 });
    expect(
      byUser.body.items.map((i: { establishmentId: string }) => i.establishmentId).sort(),
    ).toEqual([a, b].sort());
    const withHistory = await as(
      assigner,
      'GET',
      `/establishment-assignments?userId=${u1.userId}&includeRemoved=true`,
    );
    expect(withHistory.body.total).toBe(3);
    const removed = withHistory.body.items.find(
      (i: { establishmentId: string }) => i.establishmentId === c,
    );
    expect(removed.removedAt).not.toBeNull();
    expect(removed.removedBy).toBe(assigner.userId);
    const paged = await as(
      assigner,
      'GET',
      `/establishment-assignments?userId=${u1.userId}&includeRemoved=true&limit=2&offset=2`,
    );
    expect(paged.body).toMatchObject({ total: 3, limit: 2, offset: 2 });
    expect(paged.body.items).toHaveLength(1);

    const byEst = await as(assigner, 'GET', `/establishments/${a}/users?limit=1`);
    expect(byEst.body.total).toBe(2);
    expect(byEst.body.items).toHaveLength(1);
    expect(byEst.body.items[0].user).toHaveProperty('fullName');
  });

  it('validation: userId required, limit range, unknown establishment or user is 404', async () => {
    expect((await as(assigner, 'GET', '/establishment-assignments')).status).toBe(400);
    expect((await as(assigner, 'GET', '/establishment-assignments?userId=x')).status).toBe(400);
    expect(
      (await as(assigner, 'GET', `/establishment-assignments?userId=${ZERO}&limit=0`)).status,
    ).toBe(400);
    expect((await as(assigner, 'GET', `/establishment-assignments?userId=${ZERO}`)).status).toBe(
      404,
    );
    expect((await as(assigner, 'GET', `/establishments/${ZERO}/users`)).status).toBe(404);
    const est = await mkEstablishment();
    expect(
      (await as(assigner, 'GET', `/establishments/${est}/users?includeRemoved=maybe`)).status,
    ).toBe(400);
  });
});

describe('my establishments (CA-7)', () => {
  it('assigned active establishments only, access "assigned"; none -> empty', async () => {
    const [a, b, inactive] = [
      await mkEstablishment(),
      await mkEstablishment(),
      await mkEstablishment(),
    ];
    await mkEstablishment(); // not assigned
    const employee = await actor(['stock.search']);
    expect((await as(employee, 'GET', '/me/establishments')).body).toEqual({ items: [] });
    for (const est of [a, b, inactive]) await assign(est, employee.userId);
    await pool.query('UPDATE establishments SET is_active = false WHERE id = $1', [inactive]);
    const res = await as(employee, 'GET', '/me/establishments');
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { id: string }) => i.id).sort()).toEqual([a, b].sort());
    for (const item of res.body.items) {
      expect(item).toMatchObject({ access: 'assigned', isActive: true });
      expect(item.mapsUrl).toMatch(/^https:\/\/www\.google\.com\/maps/);
    }
    await unassign(a, employee.userId);
    const after = await as(employee, 'GET', '/me/establishments');
    expect(after.body.items.map((i: { id: string }) => i.id)).toEqual([b]);
  });

  it('establishments.all lists every active establishment with access "all"', async () => {
    const active = await mkEstablishment();
    const inactive = await mkEstablishment(false);
    const manager = await actor(['establishments.all']);
    const res = await as(manager, 'GET', '/me/establishments');
    const ids = res.body.items.map((i: { id: string }) => i.id);
    expect(ids).toContain(active);
    expect(ids).not.toContain(inactive);
    expect(res.body.items.every((i: { access: string }) => i.access === 'all')).toBe(true);
    const real = await pool.query('SELECT count(*) AS n FROM establishments WHERE is_active');
    expect(ids).toHaveLength(Number(real.rows[0].n));
  });

  it('requires authentication but no specific permission', async () => {
    expect((await call('GET', '/me/establishments')).status).toBe(401);
    const nobody = await actor([]);
    expect((await as(nobody, 'GET', '/me/establishments')).status).toBe(200);
  });
});

describe('stock search (CA-8, CA-9, CA-10)', () => {
  const search = (who: Actor, query: string) => as(who, 'GET', `/stock/search?${query}`);

  it('barcode: exact match across all active inventories of the establishment only', async () => {
    const north = await mkEstablishment();
    const south = await mkEstablishment();
    const product = await mkProduct({ name: 'Leche entera', price: '4200.50', unit: 'liter' });
    const other = await mkProduct({ name: 'Arroz' });
    const inv1 = await mkInventory(north, 'Norte 1');
    const inv2 = await mkInventory(north, 'Norte 2');
    const inactive = await mkInventory(north, 'Norte viejo');
    const southInv = await mkInventory(south);
    const code = `BC-${unique()}`;
    const l1 = await mkLine(inv1.id, product.id, { barcode: code, expiresOn: '2026-06-01' });
    const l2 = await mkLine(inv2.id, product.id, { barcode: code });
    await mkLine(inactive.id, product.id, { barcode: code });
    await mkLine(southInv.id, product.id, { barcode: code });
    await mkLine(inv1.id, other.id, { barcode: `${code}X` });
    await pool.query('UPDATE inventories SET is_active = false WHERE id = $1', [inactive.id]);
    const employee = await actor(['stock.search']);
    await assign(north, employee.userId);

    const res = await search(employee, `establishmentId=${north}&barcode=${code}`);
    expect(res.status, res.raw).toBe(200);
    expect(res.body).toMatchObject({ total: 2, limit: 50, offset: 0 });
    // expiry null goes last
    expect(res.body.items.map((i: { lineId: string }) => i.lineId)).toEqual([l1.id, l2.id]);
    expect(res.body.items[0]).toEqual({
      lineId: l1.id,
      inventoryId: inv1.id,
      inventoryName: 'Norte 1',
      barcode: code,
      expiresOn: '2026-06-01',
      quantityCurrent: '10.000',
      product: {
        id: product.id,
        sku: product.sku,
        name: 'Leche entera',
        unit: 'liter',
        price: '4200.50',
      },
    });
    expect(res.body.items[1].expiresOn).toBeNull();
  });

  it('NUL in text is a 400 with the field detail, not a 500 (DEF-2, H-1)', async () => {
    const north = await mkEstablishment();
    const employee = await actor(['stock.search']);
    await assign(north, employee.userId);
    for (const query of ['q=%00', 'q=a%00b', 'barcode=%00', 'barcode=a%00b']) {
      const res = await search(employee, `establishmentId=${north}&${query}`);
      expect(res.status, query).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(res.body.details[0].field).toBe(query.split('=')[0]);
    }
    const reader = await actor([...CATALOG, 'establishments.read']);
    for (const path of ['/products', '/establishments', '/categories', '/inventories']) {
      const res = await as(reader, 'GET', `${path}?q=a%00b`);
      expect(res.status, path).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(res.body.details[0].field).toBe('q');
    }
  });

  it('q: name or SKU, case-insensitive, wildcards literal; excludes inactive lines and products, includes 0 stock', async () => {
    const est = await mkEstablishment();
    const tag = unique();
    const percent = await mkProduct({ name: `Sal 50%_${tag}` });
    const decoy = await mkProduct({ name: `Sal 50xx${tag}` });
    const bySku = await mkProduct({ sku: `ZQ-${tag}`.toUpperCase(), name: 'Otro nombre' });
    const inactiveProduct = await mkProduct({ name: `Sal inactiva ${tag}` });
    const inv = await mkInventory(est);
    const lPercent = await mkLine(inv.id, percent.id);
    await mkLine(inv.id, decoy.id);
    const lSku = await mkLine(inv.id, bySku.id);
    const lInactiveLine = await mkLine(inv.id, percent.id, { barcode: `BC-${unique()}` });
    await mkLine(inv.id, inactiveProduct.id);
    await pool.query('UPDATE inventory_lines SET quantity_current = 0 WHERE id = $1', [
      lPercent.id,
    ]);
    await pool.query('UPDATE inventory_lines SET is_active = false WHERE id = $1', [
      lInactiveLine.id,
    ]);
    await pool.query('UPDATE products SET is_active = false WHERE id = $1', [inactiveProduct.id]);
    const manager = await actor(['stock.search', 'establishments.all']);

    const literal = await search(manager, `establishmentId=${est}&q=${encodeURIComponent('50%_')}`);
    expect(literal.body.items.map((i: { lineId: string }) => i.lineId)).toEqual([lPercent.id]);
    expect(literal.body.items[0].quantityCurrent).toBe('0.000');

    const upper = await search(
      manager,
      `establishmentId=${est}&q=${encodeURIComponent('SAL 50%_')}`,
    );
    expect(upper.body.items.map((i: { lineId: string }) => i.lineId)).toEqual([lPercent.id]);
    const caseless = await search(manager, `establishmentId=${est}&q=sal%2050`);
    expect(caseless.body.total).toBe(2);
    const skuHit = await search(manager, `establishmentId=${est}&q=zq-${tag}`);
    expect(skuHit.body.items.map((i: { lineId: string }) => i.lineId)).toEqual([lSku.id]);
    const inactive = await search(manager, `establishmentId=${est}&q=inactiva`);
    expect(inactive.body.total).toBe(0);
  });

  it('orders by product name, expiry (nulls last), line id and paginates (limit 1..100)', async () => {
    const est = await mkEstablishment();
    const tag = unique();
    const beta = await mkProduct({ name: `beta ${tag}` });
    const alfa = await mkProduct({ name: `Álfa ${tag}` });
    const inv = await mkInventory(est);
    const bNull = await mkLine(inv.id, beta.id, { barcode: 'B1' });
    const bDate = await mkLine(inv.id, beta.id, { barcode: 'B2', expiresOn: '2026-03-01' });
    const aLine = await mkLine(inv.id, alfa.id, { barcode: 'B3' });
    const manager = await actor(['stock.search', 'establishments.all']);
    const query = `establishmentId=${est}&q=${tag}`;
    const all = await search(manager, query);
    expect(all.body.items.map((i: { lineId: string }) => i.lineId)).toEqual([
      aLine.id,
      bDate.id,
      bNull.id,
    ]);
    const page2 = await search(manager, `${query}&limit=2&offset=2`);
    expect(page2.body).toMatchObject({ total: 3, limit: 2, offset: 2 });
    expect(page2.body.items.map((i: { lineId: string }) => i.lineId)).toEqual([bNull.id]);
    expect((await search(manager, `${query}&limit=101`)).status).toBe(400);
    expect((await search(manager, `${query}&limit=0`)).status).toBe(400);
    expect((await search(manager, `${query}&offset=-1`)).status).toBe(400);
  });

  it('criteria: none or both is 400; q is trimmed (1..100) and barcode at most 64', async () => {
    const est = await mkEstablishment();
    const manager = await actor(['stock.search', 'establishments.all']);
    const base = `establishmentId=${est}`;
    expect((await search(manager, base)).status).toBe(400);
    expect((await search(manager, `${base}&barcode=A&q=b`)).status).toBe(400);
    expect((await search(manager, `${base}&q=%20%20`)).status).toBe(400);
    expect((await search(manager, `${base}&q=${'a'.repeat(101)}`)).status).toBe(400);
    expect((await search(manager, `${base}&barcode=${'1'.repeat(65)}`)).status).toBe(400);
    expect((await search(manager, `${base}&barcode=${'1'.repeat(64)}`)).status).toBe(200);
    expect((await search(manager, 'q=a')).status).toBe(400);
    expect((await search(manager, 'establishmentId=x&q=a')).status).toBe(400);
  });

  it('scope (CA-9): not assigned 403, all -> 200, missing 404, inactive 409, no permission 403', async () => {
    const north = await mkEstablishment();
    const south = await mkEstablishment();
    const inactive = await mkEstablishment(false);
    const employee = await actor(['stock.search']);
    await assign(north, employee.userId);
    const ok = await search(employee, `establishmentId=${north}&q=a`);
    expect(ok.status).toBe(200);
    const denied = await search(employee, `establishmentId=${south}&q=a`);
    expect(denied).toMatchObject({ status: 403, body: { code: 'ESTABLISHMENT_NOT_IN_SCOPE' } });
    expect((await search(employee, `establishmentId=${ZERO}&q=a`)).status).toBe(404);
    expect((await search(employee, `establishmentId=${inactive}&q=a`)).body.code).toBe(
      'ESTABLISHMENT_INACTIVE',
    );
    const manager = await actor(['stock.search', 'establishments.all']);
    expect((await search(manager, `establishmentId=${south}&q=a`)).status).toBe(200);
    expect((await search(manager, `establishmentId=${inactive}&q=a`)).status).toBe(409);
    const noSearch = await actor(['establishments.all']);
    expect((await search(noSearch, `establishmentId=${south}&q=a`)).status).toBe(403);
    const noAssign = await actor(['stock.search']);
    expect((await search(noAssign, `establishmentId=${north}&q=a`)).body.code).toBe(
      'ESTABLISHMENT_NOT_IN_SCOPE',
    );
    expect((await call('GET', `/stock/search?establishmentId=${north}&q=a`)).status).toBe(401);
  });

  it('is evaluated live with a valid token (CA-10): removal, deactivation and losing establishments.all', async () => {
    const est = await mkEstablishment();
    const employee = await actor(['stock.search']);
    await assign(est, employee.userId);
    const url = `establishmentId=${est}&q=a`;
    expect((await search(employee, url)).status).toBe(200);

    await unassign(est, employee.userId);
    expect((await search(employee, url)).status).toBe(403);
    await assign(est, employee.userId);
    expect((await search(employee, url)).status).toBe(200);

    await pool.query('UPDATE establishments SET is_active = false WHERE id = $1', [est]);
    expect((await search(employee, url)).status).toBe(409);
    await pool.query('UPDATE establishments SET is_active = true WHERE id = $1', [est]);
    expect((await search(employee, url)).status).toBe(200);

    await pool.query('UPDATE users SET is_active = false WHERE id = $1', [employee.userId]);
    expect((await search(employee, url)).status).toBe(401);

    const manager = await actor(['stock.search', 'establishments.all']);
    expect((await search(manager, url)).status).toBe(200);
    await pool.query(
      `DELETE FROM role_permissions WHERE role_id = $1
       AND permission_id = (SELECT id FROM permissions WHERE code = 'establishments.all')`,
      [manager.roleId],
    );
    expect((await search(manager, url)).body.code).toBe('ESTABLISHMENT_NOT_IN_SCOPE');
    await pool.query(
      `DELETE FROM role_permissions WHERE role_id = $1
       AND permission_id = (SELECT id FROM permissions WHERE code = 'stock.search')`,
      [manager.roleId],
    );
    expect((await search(manager, url)).status).toBe(403);
  });

  it('searches are not audited', async () => {
    const est = await mkEstablishment();
    const manager = await actor(['stock.search', 'establishments.all']);
    const before = logs.length;
    await search(manager, `establishmentId=${est}&q=a`);
    await as(manager, 'GET', '/me/establishments');
    expect(logs.slice(before).filter((line) => line.includes('"event"'))).toEqual([]);
  });
});

describe('feeds with scope (CA-11)', () => {
  type Item = { id: string; inScope?: boolean } & Record<string, unknown>;

  /** Wait for the feed to show what was written (ADR-0002: another open write transaction delays it). */
  const FEED_WAIT_MS = 60_000;
  const FEED_TEST_TIMEOUT_MS = 90_000;

  async function eventually<T>(what: string, read: () => Promise<T>, ready: (v: T) => boolean) {
    const deadline = Date.now() + FEED_WAIT_MS;
    for (;;) {
      const value = await read();
      if (ready(value)) return value;
      if (Date.now() >= deadline) {
        throw new Error(
          `the feed did not show ${what} within ${FEED_WAIT_MS / 1000} s ` +
            '(is another write transaction open in the PostgreSQL cluster? ADR-0002)',
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  async function drain(who: Actor, path: string, cursor?: string, limit = 3) {
    const items: Item[] = [];
    let next = cursor;
    for (let guard = 0; guard < 1000; guard++) {
      const res = await as(
        who,
        'GET',
        `/stock/${path}/changes?limit=${limit}${next ? `&cursor=${next}` : ''}`,
      );
      expect(res.status, res.raw).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(['hasMore', 'items', 'nextCursor']);
      items.push(...(res.body.items as Item[]));
      next = res.body.nextCursor ?? undefined;
      if (!res.body.hasMore) return { items, cursor: next };
    }
    throw new Error('feed does not terminate');
  }

  const drainUntil = (
    who: Actor,
    path: string,
    ready: (items: Item[]) => boolean,
    cursor?: string,
  ) =>
    eventually(
      `the expected changes in ${path}`,
      () => drain(who, path, cursor),
      (r) => ready(r.items),
    );

  const find = (items: Item[], id: string) => items.filter((i) => i.id === id);
  /** Out-of-scope records carry ONLY these two keys. */
  const onlyMark = (item: Item) => expect(Object.keys(item).sort()).toEqual(['id', 'inScope']);

  async function world() {
    const north = await mkEstablishment();
    const south = await mkEstablishment();
    const product = await mkProduct({ name: `Feed ${unique()}` });
    const invN = await mkInventory(north, 'Inventario norte secreto-n');
    const invS = await mkInventory(south, 'Inventario sur secreto-s');
    const lineN = await mkLine(invN.id, product.id, { barcode: 'NORTE-1' });
    const lineS = await mkLine(invS.id, product.id, { barcode: 'SUR-1' });
    const employee = await actor(['stock.search']);
    await assign(north, employee.userId);
    return { north, south, product, invN, invS, lineN, lineS, employee };
  }

  it(
    'inventories and lines: complete in scope, only {id, inScope:false} outside, no repeats',
    async () => {
      const w = await world();
      const inv = await drainUntil(w.employee, 'inventories', (items) =>
        [w.invN.id, w.invS.id].every((id) => find(items, id).length > 0),
      );
      expect(find(inv.items, w.invN.id)).toHaveLength(1);
      const northInv = find(inv.items, w.invN.id)[0]!;
      expect(northInv).toMatchObject({
        name: 'Inventario norte secreto-n',
        establishmentId: w.north,
      });
      expect(northInv.inScope).toBeUndefined();
      onlyMark(find(inv.items, w.invS.id)[0]!);
      expect(find(inv.items, w.invS.id)[0]!.inScope).toBe(false);
      expect(new Set(inv.items.map((i) => i.id)).size).toBe(inv.items.length);
      for (const item of inv.items) {
        if (item.inScope === false) onlyMark(item);
        else expect(item.establishmentId).toBe(w.north);
      }

      const lines = await drainUntil(w.employee, 'lines', (items) =>
        [w.lineN.id, w.lineS.id].every((id) => find(items, id).length > 0),
      );
      expect(find(lines.items, w.lineN.id)[0]).toMatchObject({
        barcode: 'NORTE-1',
        inventoryId: w.invN.id,
      });
      onlyMark(find(lines.items, w.lineS.id)[0]!);
      for (const item of lines.items) {
        if (item.inScope === false) onlyMark(item);
        else expect(item.inventoryId).toBe(w.invN.id);
      }
      expect(JSON.stringify(lines.items)).not.toContain('SUR-1');
      expect(JSON.stringify(inv.items)).not.toContain('secreto-s');
    },
    FEED_TEST_TIMEOUT_MS,
  );

  it(
    'products: the full global catalog with the same representation as /products/changes',
    async () => {
      const w = await world();
      const products = await drainUntil(
        w.employee,
        'products',
        (items) => find(items, w.product.id).length > 0,
      );
      expect(find(products.items, w.product.id)[0]).toMatchObject({
        sku: w.product.sku,
        price: '12500.50',
        isActive: true,
      });
      expect(products.items.every((i) => i.inScope === undefined)).toBe(true);
    },
    FEED_TEST_TIMEOUT_MS,
  );

  it(
    'removing the assignment turns the establishment into marks on restart; later edits arrive as marks',
    async () => {
      const w = await world();
      await drainUntil(w.employee, 'inventories', (items) => find(items, w.invN.id).length > 0);
      const cursor = (await drain(w.employee, 'lines')).cursor;
      await unassign(w.north, w.employee.userId);

      const restarted = await drainUntil(
        w.employee,
        'lines',
        (items) => find(items, w.lineN.id).length > 0,
      );
      onlyMark(find(restarted.items, w.lineN.id)[0]!);
      const invs = await drainUntil(
        w.employee,
        'inventories',
        (items) => find(items, w.invN.id).length > 0,
      );
      onlyMark(find(invs.items, w.invN.id)[0]!);

      const edit = await build('PATCH', `/inventory-lines/${w.lineN.id}`, { quantityAlert: '7' });
      expect(edit.status, edit.raw).toBe(200);
      const later = await drainUntil(
        w.employee,
        'lines',
        (items) => find(items, w.lineN.id).length > 0,
        cursor,
      );
      onlyMark(find(later.items, w.lineN.id)[0]!);

      // assigned again: a restart shows it complete once more
      await assign(w.north, w.employee.userId);
      const back = await drainUntil(
        w.employee,
        'lines',
        (items) => find(items, w.lineN.id).length > 0,
      );
      expect(find(back.items, w.lineN.id)[0]).toMatchObject({ barcode: 'NORTE-1' });
    },
    FEED_TEST_TIMEOUT_MS,
  );

  it(
    'establishments.all sees everything complete; deactivating an establishment takes it out of the scope',
    async () => {
      const w = await world();
      const manager = await actor(['stock.search', 'establishments.all']);
      const lines = await drainUntil(manager, 'lines', (items) =>
        [w.lineN.id, w.lineS.id].every((id) => find(items, id).length > 0),
      );
      expect(find(lines.items, w.lineS.id)[0]).toMatchObject({ barcode: 'SUR-1' });
      await pool.query('UPDATE establishments SET is_active = false WHERE id = $1', [w.south]);
      const after = await drain(manager, 'lines');
      onlyMark(find(after.items, w.lineS.id)[0]!);
      expect(find(after.items, w.lineN.id)[0]).toMatchObject({ barcode: 'NORTE-1' });
    },
    FEED_TEST_TIMEOUT_MS,
  );

  it(
    'invalid cursor is 400, a paged walk has no gaps, and the permission is required',
    async () => {
      const w = await world();
      for (const path of ['inventories', 'lines', 'products']) {
        const bad = await as(w.employee, 'GET', `/stock/${path}/changes?cursor=!!!`);
        expect(bad.status).toBe(400);
        expect(bad.body.details[0].field).toBe('cursor');
        expect((await as(w.employee, 'GET', `/stock/${path}/changes?limit=0`)).status).toBe(400);
        expect((await as(w.employee, 'GET', `/stock/${path}/changes?limit=501`)).status).toBe(400);
        expect((await as(assigner, 'GET', `/stock/${path}/changes`)).status).toBe(403);
        expect((await call('GET', `/stock/${path}/changes`)).status).toBe(401);
      }
      const walk = await drainUntil(
        w.employee,
        'lines',
        (items) => find(items, w.lineN.id).length > 0 && find(items, w.lineS.id).length > 0,
      );
      const real = await pool.query<{ id: string }>('SELECT id FROM inventory_lines');
      expect(walk.items.map((i) => i.id).sort()).toEqual(real.rows.map((r) => r.id).sort());
      // an idle feed keeps a stable cursor
      const again = await drain(w.employee, 'lines', walk.cursor);
      expect(again.items).toEqual([]);
      expect(again.cursor).toBe(walk.cursor);
    },
    FEED_TEST_TIMEOUT_MS,
  );
});
