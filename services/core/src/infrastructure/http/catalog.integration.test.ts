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
import { PostgresInventoryLineRepository } from '../database/postgres-inventory-line-repository.js';
import { PostgresProductRepository } from '../database/postgres-product-repository.js';
import { AppModule } from './app.module.js';

/**
 * Integration tests (sprint 005) over HTTP against a real PostgreSQL TEST database: categories,
 * products, inventories and inventory lines. Users and roles are inserted with SQL (identity owns
 * those tables). Every row created here is removed at the end (inventories reference
 * establishments with RESTRICT, so the establishments tests rely on this clean-up).
 */
const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const testDb = process.env.POSTGRES_TEST_DB ?? 'inventory_test';
const unique = () => randomBytes(4).toString('hex');
const uuid = () => crypto.randomUUID();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ZERO = '00000000-0000-4000-8000-000000000000';

let app: NestFastifyApplication;
let pool: Pool;
let config: AppConfig;
let privatePem: string;
const logs: string[] = [];
const establishmentIds: string[] = [];

interface Res {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  raw: string;
}

async function call(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  options: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Res> {
  const response = await app.inject({
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

/** Creates a role with the given permissions and a user in it. */
async function actor(codes: readonly string[]) {
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
     VALUES ($1, 'x', 'Usuario de prueba', $2, true) RETURNING id`,
    [`core-${unique()}@example.test`, roleId],
  );
  const userId = user.rows[0]!.id;
  return { userId, roleId, token: await sign(userId) };
}

const ALL = [...CATEGORY_PERMISSIONS, ...PRODUCT_PERMISSIONS, ...INVENTORY_PERMISSIONS];
let admin: Awaited<ReturnType<typeof actor>>;

const post = (url: string, payload: unknown, headers?: Record<string, string>) =>
  call('POST', url, { token: admin.token, body: payload, headers });
const patch = (url: string, payload: unknown, headers?: Record<string, string>) =>
  call('PATCH', url, { token: admin.token, body: payload, headers });
const get = (url: string) => call('GET', url, { token: admin.token });
const ifMatch = (version: number) => ({ 'If-Match': `"${version}"` });
const withKey = (key: string, extra: Record<string, string> = {}) => ({
  'Idempotency-Key': key,
  ...extra,
});

async function mkCategory(overrides: Record<string, unknown> = {}) {
  const res = await post('/categories', {
    code: `C-${unique()}`.toUpperCase(),
    name: `Categoría ${unique()}`,
    ...overrides,
  });
  expect(res.status, res.raw).toBe(201);
  return res.body as { id: string; code: string; name: string; version: number };
}

async function mkProduct(categoryId: string, overrides: Record<string, unknown> = {}) {
  const res = await post('/products', {
    sku: `SKU-${unique()}`,
    name: `Producto ${unique()}`,
    unit: 'unit',
    categoryId,
    price: '12500',
    ...overrides,
  });
  expect(res.status, res.raw).toBe(201);
  return res.body as {
    id: string;
    sku: string;
    price: string;
    version: number;
    categoryId: string;
  };
}

async function mkEstablishment(isActive = true): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO establishments (name, address, city, department, latitude, longitude, is_active)
     VALUES ($1, 'Cra 1', 'Medellín', 'Antioquia', 6.25, -75.56, $2) RETURNING id`,
    [`Sede ${unique()}`, isActive],
  );
  establishmentIds.push(rows[0]!.id);
  return rows[0]!.id;
}

async function mkInventory(establishmentId: string, overrides: Record<string, unknown> = {}) {
  const res = await post('/inventories', {
    establishmentId,
    name: `Inventario ${unique()}`,
    startDate: '2026-01-01',
    endDate: '2026-01-31',
    origin: 'Proveedor X',
    ...overrides,
  });
  expect(res.status, res.raw).toBe(201);
  return res.body as { id: string; version: number; establishmentId: string };
}

async function mkLine(
  inventoryId: string,
  productId: string,
  overrides: Record<string, unknown> = {},
) {
  const res = await post(`/inventories/${inventoryId}/lines`, {
    productId,
    barcode: `BC-${unique()}`,
    quantityInitial: '10',
    quantityAlert: '2',
    ...overrides,
  });
  expect(res.status, res.raw).toBe(201);
  return res.body as {
    id: string;
    version: number;
    quantityInitial: string;
    quantityCurrent: string;
    barcode: string;
  };
}

/** A category + active product + active establishment + active inventory, ready for lines. */
async function scenario() {
  const category = await mkCategory();
  const product = await mkProduct(category.id);
  const establishmentId = await mkEstablishment();
  const inventory = await mkInventory(establishmentId);
  return { category, product, establishmentId, inventory };
}

const setStatus = (path: string, id: string, isActive: boolean, headers?: Record<string, string>) =>
  patch(`/${path}/${id}/status`, { isActive }, headers);

const fieldsOf = (res: Res) => (res.body.details as { field: string }[]).map((d) => d.field);

/** Parsed JSON audit events whose line mentions `needle`. */
function eventsOf(needle: string): Record<string, unknown>[] {
  return logs
    .filter((line) => line.includes(needle) && /^\{.*\}/.test(line))
    .map((line) => JSON.parse(/^\{.*\}/.exec(line)![0]) as Record<string, unknown>);
}

const eventNames = (id: string) => eventsOf(id).map((e) => e.event);

async function clean() {
  await pool.query('DELETE FROM inventory_line_history');
  await pool.query('DELETE FROM inventory_lines');
  await pool.query('DELETE FROM inventories');
  await pool.query('DELETE FROM product_price_history');
  await pool.query('DELETE FROM products');
  await pool.query('DELETE FROM categories');
  if (establishmentIds.length > 0) {
    await pool.query('DELETE FROM establishments WHERE id = ANY($1::uuid[])', [establishmentIds]);
  }
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
  admin = await actor(ALL);
});

afterAll(async () => {
  await clean();
  await app?.close();
  await pool?.end();
});

// ---------------------------------------------------------------------------------------------

describe('schema (CA-1) and permissions catalog (CA-2)', () => {
  it('has the 6 tables with exact numeric types, checks, FKs, indexes and the NULLS NOT DISTINCT key', async () => {
    const cols = await pool.query<{ t: string; c: string; p: number; s: number }>(
      `SELECT table_name AS t, column_name AS c, numeric_precision AS p, numeric_scale AS s
       FROM information_schema.columns
       WHERE table_name IN ('products','product_price_history','inventory_lines','inventory_line_history')
         AND data_type = 'numeric'`,
    );
    const scale = (t: string, c: string) => cols.rows.find((r) => r.t === t && r.c === c);
    expect(scale('products', 'price')).toMatchObject({ p: 14, s: 2 });
    expect(scale('product_price_history', 'old_price')).toMatchObject({ p: 14, s: 2 });
    expect(scale('product_price_history', 'new_price')).toMatchObject({ p: 14, s: 2 });
    for (const c of ['quantity_initial', 'quantity_alert', 'quantity_current']) {
      expect(scale('inventory_lines', c)).toMatchObject({ p: 14, s: 3 });
    }
    for (const c of [
      'initial_before',
      'initial_after',
      'current_before',
      'current_after',
      'delta',
    ]) {
      expect(scale('inventory_line_history', c)).toMatchObject({ p: 14, s: 3 });
    }
    const constraints = await pool.query<{ conname: string; def: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conrelid::regclass::text IN ('categories','products','product_price_history',
         'inventories','inventory_lines','inventory_line_history')`,
    );
    const def = (name: string) => constraints.rows.find((r) => r.conname === name)?.def ?? '';
    expect(def('inventory_lines_inventory_barcode_expires_key')).toMatch(
      /UNIQUE NULLS NOT DISTINCT \(inventory_id, barcode, expires_on\)/,
    );
    expect(def('inventories_dates_check')).toMatch(/end_date >= start_date/);
    expect(def('products_unit_check')).toMatch(/box/);
    const fks = constraints.rows.filter((r) => r.def.startsWith('FOREIGN KEY'));
    expect(fks.length).toBeGreaterThanOrEqual(6);
    for (const fk of fks) expect(fk.def).not.toMatch(/ON DELETE (CASCADE|SET)/);
    expect(constraints.rows.some((r) => r.def.includes('actor_id'))).toBe(false);
    const indexes = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE (indexname LIKE '%change_xid_id_idx'
           AND tablename IN ('categories','products','inventories','inventory_lines','establishments'))
         OR indexname IN ('categories_name_lower_key','products_sku_lower_key')`,
    );
    expect(indexes.rows.map((r) => r.indexname).sort()).toEqual(
      [
        'categories_change_xid_id_idx',
        'categories_name_lower_key',
        'establishments_change_xid_id_idx',
        'inventories_change_xid_id_idx',
        'inventory_lines_change_xid_id_idx',
        'products_change_xid_id_idx',
        'products_sku_lower_key',
      ].sort(),
    );
    const sync = await pool.query<{ table_name: string; column_name: string; udt_name: string }>(
      `SELECT table_name, column_name, udt_name FROM information_schema.columns
       WHERE column_name IN ('version','change_xid')
         AND table_name IN ('categories','products','inventories','inventory_lines')`,
    );
    expect(sync.rows).toHaveLength(8);
    expect(
      sync.rows.filter((r) => r.column_name === 'change_xid').every((r) => r.udt_name === 'xid8'),
    ).toBe(true);
  });

  it('the 12 permissions have a Spanish description, the Administrador holds them and PUT /roles can assign them', async () => {
    const { rows } = await pool.query<{ code: string; description: string; assigned: boolean }>(
      `SELECT p.code, p.description,
         EXISTS (SELECT 1 FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
                 WHERE rp.permission_id = p.id AND r.is_system) AS assigned
       FROM permissions p WHERE p.module IN ('categories','products','inventories') ORDER BY p.code`,
    );
    expect(rows.map((r) => r.code)).toEqual([...ALL].sort());
    for (const row of rows) {
      expect(row.assigned, row.code).toBe(true);
      expect(row.description).toMatch(/^[A-ZÁÉÍÓÚ][a-záéíóúñ]+ /);
    }
  });
});

describe('authentication and live authorization per endpoint (CA-13)', () => {
  const E = (m: string, u: string, perm: string): [string, string, string] => [m, u, perm];
  const endpoints: [string, string, string][] = [
    E('POST', '/categories', 'categories.create'),
    E('GET', '/categories', 'categories.read'),
    E('GET', '/categories/changes', 'categories.read'),
    E('GET', `/categories/${ZERO}`, 'categories.read'),
    E('PATCH', `/categories/${ZERO}`, 'categories.update'),
    E('PATCH', `/categories/${ZERO}/status`, 'categories.deactivate'),
    E('POST', '/products', 'products.create'),
    E('GET', '/products', 'products.read'),
    E('GET', '/products/changes', 'products.read'),
    E('GET', `/products/${ZERO}`, 'products.read'),
    E('GET', `/products/${ZERO}/price-history`, 'products.read'),
    E('PATCH', `/products/${ZERO}`, 'products.update'),
    E('PATCH', `/products/${ZERO}/status`, 'products.deactivate'),
    E('POST', '/inventories', 'inventories.create'),
    E('GET', '/inventories', 'inventories.read'),
    E('GET', '/inventories/changes', 'inventories.read'),
    E('GET', `/inventories/${ZERO}`, 'inventories.read'),
    E('PATCH', `/inventories/${ZERO}`, 'inventories.update'),
    E('PATCH', `/inventories/${ZERO}/status`, 'inventories.deactivate'),
    E('POST', `/inventories/${ZERO}/lines`, 'inventories.update'),
    E('GET', `/inventories/${ZERO}/lines`, 'inventories.read'),
    E('GET', '/inventory-lines/changes', 'inventories.read'),
    E('GET', `/inventory-lines/${ZERO}`, 'inventories.read'),
    E('GET', `/inventory-lines/${ZERO}/history`, 'inventories.read'),
    E('PATCH', `/inventory-lines/${ZERO}`, 'inventories.update'),
    E('PATCH', `/inventory-lines/${ZERO}/status`, 'inventories.deactivate'),
  ];

  it('no token or a bad token -> 401 on every endpoint', async () => {
    for (const [method, url] of endpoints) {
      for (const token of [undefined, 'garbage']) {
        const res = await call(method as 'GET', url, { token, body: {} });
        expect(res.status, `${method} ${url}`).toBe(401);
      }
    }
  });

  it('each endpoint needs exactly its permission: 403 without it, passes the guard with it', async () => {
    const only = new Map<string, Awaited<ReturnType<typeof actor>>>();
    const allBut = new Map<string, Awaited<ReturnType<typeof actor>>>();
    for (const perm of ALL) {
      only.set(perm, await actor([perm]));
      allBut.set(perm, await actor(ALL.filter((p) => p !== perm)));
    }
    for (const [method, url, perm] of endpoints) {
      const denied = await call(method as 'GET', url, { token: allBut.get(perm)!.token, body: {} });
      expect(denied.status, `${method} ${url} without ${perm}`).toBe(403);
      const allowed = await call(method as 'GET', url, { token: only.get(perm)!.token, body: {} });
      expect([401, 403], `${method} ${url} with ${perm}`).not.toContain(allowed.status);
    }
  });

  it('revoking a permission or deactivating the user applies on the next request', async () => {
    const user = await actor(['categories.read', 'categories.create']);
    const create = () =>
      call('POST', '/categories', {
        token: user.token,
        body: { code: `P-${unique()}`.toUpperCase(), name: `Cat ${unique()}` },
      });
    expect((await create()).status).toBe(201);
    await pool.query(
      `DELETE FROM role_permissions WHERE role_id = $1
       AND permission_id = (SELECT id FROM permissions WHERE code = 'categories.create')`,
      [user.roleId],
    );
    expect((await create()).status).toBe(403);
    await pool.query('UPDATE users SET is_active = false WHERE id = $1', [user.userId]);
    expect((await call('GET', '/categories', { token: user.token })).status).toBe(401);
  });
});

describe('categories (CA-3)', () => {
  it('creates with the code in uppercase and trimmed texts; description empty -> null', async () => {
    const code = `herr-${unique()}`;
    const res = await post('/categories', {
      code: `  ${code} `,
      name: `  Manuales ${unique()} `,
      description: '  ',
    });
    expect(res.status).toBe(201);
    expect(res.body.code).toBe(code.toUpperCase());
    expect(res.body.name).not.toMatch(/^\s|\s$/);
    expect(res.body.description).toBeNull();
    expect(res.body).toMatchObject({ isActive: true, version: 1 });
    expect(Object.keys(res.body).sort()).toEqual(
      ['code', 'createdAt', 'description', 'id', 'isActive', 'name', 'updatedAt', 'version'].sort(),
    );
  });

  it('rejects invalid input with 400 listing the fields (trim before max length)', async () => {
    const bad = await post('/categories', { code: 'a b', name: '   ' });
    expect(bad.status).toBe(400);
    expect(fieldsOf(bad).sort()).toEqual(['code', 'name']);
    const long = await post('/categories', { code: `A${unique()}`, name: `${'x'.repeat(100)}  ` });
    expect(long.status).toBe(201);
    expect((await post('/categories', { code: 'OK1', name: 'x'.repeat(101) })).status).toBe(400);
    expect((await post('/categories', { code: 'A'.repeat(31), name: 'n' })).status).toBe(400);
    expect((await post('/categories', { code: 5, name: 'n' })).status).toBe(400);
  });

  it('a duplicate code or name (any case, even inactive) is 409 with its own code', async () => {
    const first = await mkCategory({ name: `Dup ${unique()}` });
    await setStatus('categories', first.id, false);
    const sameCode = await post('/categories', {
      code: first.code.toLowerCase(),
      name: `Otro ${unique()}`,
    });
    expect(sameCode.status).toBe(409);
    expect(sameCode.body.code).toBe('CATEGORY_CODE_TAKEN');
    const sameName = await post('/categories', {
      code: `N-${unique()}`,
      name: `  ${first.name.toUpperCase()} `,
    });
    expect(sameName.status).toBe(409);
    expect(sameName.body.code).toBe('CATEGORY_NAME_TAKEN');
    const other = await mkCategory();
    const edit = await patch(`/categories/${other.id}`, { code: first.code });
    expect(edit.body.code).toBe('CATEGORY_CODE_TAKEN');
    const own = await patch(`/categories/${other.id}`, { code: other.code, name: other.name });
    expect(own.status).toBe(200);
  });

  it('concurrent creations with the same code: one 201, the rest 409, never 500', async () => {
    const code = `RACE-${unique()}`.toUpperCase();
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        post('/categories', { code, name: `Race ${unique()} ${i}` }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    for (const r of results.filter((r) => r.status !== 201)) {
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('CATEGORY_CODE_TAKEN');
    }
  });

  it('lists with status, q (code or name, literal wildcards) and pagination; gets and edits', async () => {
    const tag = unique();
    const a = await mkCategory({ code: `AA-${tag}`.toUpperCase(), name: `Alfa ${tag}` });
    const b = await mkCategory({ code: `BB-${tag}`.toUpperCase(), name: `Beta ${tag}` });
    await setStatus('categories', b.id, false);
    const all = await get(`/categories?q=${tag}`);
    expect(all.body.total).toBe(2);
    expect(all.body).toMatchObject({ limit: 50, offset: 0 });
    expect(all.body.items.map((c: { id: string }) => c.id)).toEqual([a.id, b.id]);
    expect(
      (await get(`/categories?q=${tag}&status=inactive`)).body.items.map(
        (c: { id: string }) => c.id,
      ),
    ).toEqual([b.id]);
    expect((await get(`/categories?q=${tag}&status=active`)).body.total).toBe(1);
    expect((await get(`/categories?q=BB-${tag.toLowerCase()}`)).body.total).toBe(1);
    const page = await get(`/categories?q=${tag}&limit=1&offset=1`);
    expect(page.body.items.map((c: { id: string }) => c.id)).toEqual([b.id]);
    expect(page.body.total).toBe(2);
    expect((await get('/categories?q=%25')).body.total).toBe(0);
    for (const q of ['limit=0', 'limit=201', 'offset=-1', 'status=nope']) {
      expect((await get(`/categories?${q}`)).status, q).toBe(400);
    }
    expect((await get(`/categories/${a.id}`)).body.code).toBe(a.code);
    expect((await get(`/categories/${ZERO}`)).status).toBe(404);
    expect((await get('/categories/not-a-uuid')).status).toBe(400);
    const edited = await patch(`/categories/${a.id}`, { description: ' nueva ' });
    expect(edited.body).toMatchObject({ description: 'nueva', version: 2 });
    expect((await patch(`/categories/${a.id}`, { description: null })).body.description).toBeNull();
    expect((await patch(`/categories/${a.id}`, {})).status).toBe(400);
  });

  it('status is idempotent: the current state keeps the version', async () => {
    const c = await mkCategory();
    expect((await setStatus('categories', c.id, false)).body).toMatchObject({
      isActive: false,
      version: 2,
    });
    expect((await setStatus('categories', c.id, false)).body.version).toBe(2);
    expect((await setStatus('categories', c.id, true)).body).toMatchObject({
      isActive: true,
      version: 3,
    });
    expect((await setStatus('categories', ZERO, true)).status).toBe(404);
    expect((await patch(`/categories/${c.id}/status`, { isActive: 'yes' })).status).toBe(400);
  });
});

describe('products and prices (CA-4, CA-5, CA-6)', () => {
  it('creates in an active category; price text with 2 decimals; uppercase SKU; trimmed texts', async () => {
    const cat = await mkCategory();
    const res = await post('/products', {
      sku: `  sku-${unique()} `,
      name: ' Martillo ',
      description: ' ',
      brand: ' Stanley ',
      unit: 'kilogram',
      categoryId: cat.id,
      price: '12500.5',
    });
    expect(res.status).toBe(201);
    expect(res.body.sku).toMatch(/^SKU-[0-9A-F]{8}$/);
    expect(res.body).toMatchObject({
      name: 'Martillo',
      description: null,
      brand: 'Stanley',
      unit: 'kilogram',
      categoryId: cat.id,
      price: '12500.50',
      isActive: true,
      version: 1,
    });
    expect(Object.keys(res.body).sort()).toEqual(
      [
        'brand',
        'categoryId',
        'createdAt',
        'description',
        'id',
        'isActive',
        'name',
        'price',
        'sku',
        'unit',
        'updatedAt',
        'version',
      ].sort(),
    );
    expect((await mkProduct(cat.id, { price: '0' })).price).toBe('0.00');
    expect((await mkProduct(cat.id, { price: '999999999999.99' })).price).toBe('999999999999.99');
  });

  it('CA-5: only decimal text with <= 2 decimals and >= 0 is accepted for the price', async () => {
    const cat = await mkCategory();
    const attempt = (price: unknown) =>
      post('/products', {
        sku: `P-${unique()}`,
        name: 'p',
        unit: 'unit',
        categoryId: cat.id,
        price,
      });
    for (const price of [
      12500,
      -1,
      '-1',
      '1e3',
      '1.234',
      '1,000.00',
      '',
      'abc',
      '1000000000000',
      null,
      '.5',
      1.5,
    ]) {
      const res = await attempt(price);
      expect(res.status, JSON.stringify(price)).toBe(400);
      expect(fieldsOf(res)).toContain('price');
    }
    const product = await mkProduct(cat.id);
    for (const price of [50, '-0.01', '2.999']) {
      expect((await patch(`/products/${product.id}`, { price })).status).toBe(400);
    }
    expect((await get(`/products/${product.id}`)).body.price).toBe('12500.00');
  });

  it('rejects a unit outside the list, a duplicate SKU (any case, even inactive) and missing fields', async () => {
    const cat = await mkCategory();
    const bad = await post('/products', {
      sku: `U-${unique()}`,
      name: 'p',
      unit: 'pallet',
      categoryId: cat.id,
      price: '1',
    });
    expect(bad.status).toBe(400);
    expect(fieldsOf(bad)).toEqual(['unit']);
    for (const unit of ['unit', 'meter', 'kilogram', 'liter', 'box', 'package']) {
      await mkProduct(cat.id, { unit });
    }
    const first = await mkProduct(cat.id);
    await setStatus('products', first.id, false);
    const dup = await post('/products', {
      sku: first.sku.toLowerCase(),
      name: 'p',
      unit: 'unit',
      categoryId: cat.id,
      price: '1',
    });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('PRODUCT_SKU_TAKEN');
    const other = await mkProduct(cat.id);
    expect((await patch(`/products/${other.id}`, { sku: ` ${first.sku} ` })).body.code).toBe(
      'PRODUCT_SKU_TAKEN',
    );
    expect((await post('/products', { name: 'only name' })).status).toBe(400);
  });

  it('category must exist (404) and be active (409 CATEGORY_INACTIVE), also when editing the category', async () => {
    const active = await mkCategory();
    const inactive = await mkCategory();
    await setStatus('categories', inactive.id, false);
    const payload = (categoryId: string) => ({
      sku: `S-${unique()}`,
      name: 'p',
      unit: 'unit',
      categoryId,
      price: '1',
    });
    const toInactive = await post('/products', payload(inactive.id));
    expect(toInactive.status).toBe(409);
    expect(toInactive.body.code).toBe('CATEGORY_INACTIVE');
    const missing = await post('/products', payload(ZERO));
    expect(missing.status).toBe(404);
    expect(missing.body.message).toMatch(/[Cc]ategoría/);
    const product = await mkProduct(active.id);
    expect((await patch(`/products/${product.id}`, { categoryId: inactive.id })).body.code).toBe(
      'CATEGORY_INACTIVE',
    );
    expect((await patch(`/products/${product.id}`, { categoryId: ZERO })).status).toBe(404);
    const target = await mkCategory();
    const moved = await patch(`/products/${product.id}`, { categoryId: target.id });
    expect(moved.status).toBe(200);
    expect(moved.body.categoryId).toBe(target.id);
  });

  it('lists with categoryId, status and q; gets; status; unknown id 404', async () => {
    const tag = unique();
    const catA = await mkCategory();
    const catB = await mkCategory();
    const p1 = await mkProduct(catA.id, { sku: `L1-${tag}`, name: `Alfa ${tag}` });
    const p2 = await mkProduct(catB.id, { sku: `L2-${tag}`, name: `Beta ${tag}` });
    await setStatus('products', p2.id, false);
    const ids = (res: Res) => res.body.items.map((p: { id: string }) => p.id);
    expect(ids(await get(`/products?q=${tag}`))).toEqual([p1.id, p2.id]);
    expect(ids(await get(`/products?q=${tag}&categoryId=${catB.id}`))).toEqual([p2.id]);
    expect(ids(await get(`/products?q=${tag}&status=active`))).toEqual([p1.id]);
    expect(ids(await get(`/products?q=l2-${tag.toLowerCase()}&status=inactive`))).toEqual([p2.id]);
    expect((await get(`/products?q=${tag}&limit=1&offset=1`)).body.total).toBe(2);
    expect((await get('/products?categoryId=bad')).status).toBe(400);
    expect((await get(`/products/${ZERO}`)).status).toBe(404);
    expect((await patch(`/products/${p1.id}`, { name: ' Nuevo ' })).body).toMatchObject({
      name: 'Nuevo',
      version: 2,
    });
  });

  it('CA-6: price history: initial row, one row per real change, none for same price or other fields', async () => {
    const cat = await mkCategory();
    const product = await mkProduct(cat.id, { price: '100' });
    const history = async () => (await get(`/products/${product.id}/price-history`)).body;
    let h = await history();
    expect(h.total).toBe(1);
    expect(h.items[0]).toEqual({
      oldPrice: null,
      newPrice: '100.00',
      actorId: admin.userId,
      changedAt: expect.any(String),
    });
    await sleep(15);
    await patch(`/products/${product.id}`, { price: '150.5' });
    await sleep(15);
    await patch(`/products/${product.id}`, { name: 'Otro nombre' });
    await patch(`/products/${product.id}`, { price: '150.50' });
    await patch(`/products/${product.id}`, { price: '150.5', name: 'Otro nombre 2' });
    await sleep(15);
    const other = await actor(['products.update', 'products.read']);
    await call('PATCH', `/products/${product.id}`, { token: other.token, body: { price: '0' } });
    h = await history();
    expect(h.total).toBe(3);
    expect(
      h.items.map((i: { oldPrice: string | null; newPrice: string }) => [i.oldPrice, i.newPrice]),
    ).toEqual([
      ['150.50', '0.00'],
      ['100.00', '150.50'],
      [null, '100.00'],
    ]);
    expect(h.items[0].actorId).toBe(other.userId);
    const dates = h.items.map((i: { changedAt: string }) => Date.parse(i.changedAt));
    expect(dates[0]).toBeGreaterThan(dates[1]);
    expect(dates[1]).toBeGreaterThan(dates[2]);
    const page = (await get(`/products/${product.id}/price-history?limit=1&offset=1`)).body;
    expect(page).toMatchObject({ total: 3, limit: 1, offset: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0].newPrice).toBe('150.50');
    expect((await get(`/products/${ZERO}/price-history`)).status).toBe(404);
    expect((await get(`/products/${product.id}/price-history?limit=0`)).status).toBe(400);
  });

  it('a conflict or a rejected price does not write a history row', async () => {
    const cat = await mkCategory();
    const product = await mkProduct(cat.id, { price: '10' });
    await patch(`/products/${product.id}`, { price: '20' }, ifMatch(9));
    await patch(`/products/${product.id}`, { price: '20', categoryId: ZERO });
    expect((await get(`/products/${product.id}/price-history`)).body.total).toBe(1);
    expect((await get(`/products/${product.id}`)).body.price).toBe('10.00');
  });
});

describe('inventories (CA-7)', () => {
  it('creates in an active establishment; dates as YYYY-MM-DD; overlapping periods allowed', async () => {
    const est = await mkEstablishment();
    const a = await mkInventory(est, { name: `  Inv ${unique()} `, notes: '  ' });
    expect(a).toMatchObject({ establishmentId: est, version: 1 });
    const got = (await get(`/inventories/${a.id}`)).body;
    expect(got).toMatchObject({
      startDate: '2026-01-01',
      endDate: '2026-01-31',
      notes: null,
      isActive: true,
    });
    expect(got.name).not.toMatch(/^\s|\s$/);
    expect(Object.keys(got).sort()).toEqual(
      [
        'createdAt',
        'endDate',
        'establishmentId',
        'id',
        'isActive',
        'name',
        'notes',
        'origin',
        'startDate',
        'updatedAt',
        'version',
      ].sort(),
    );
    await mkInventory(est, { startDate: '2026-01-15', endDate: '2026-02-15' });
    await mkInventory(est, { startDate: '2026-01-01', endDate: '2026-01-01' });
  });

  it('400 for end before start, invalid or malformed dates and missing fields; 404/409 for the establishment', async () => {
    const est = await mkEstablishment();
    const attempt = (over: Record<string, unknown>) =>
      post('/inventories', {
        establishmentId: est,
        name: 'n',
        startDate: '2026-01-01',
        endDate: '2026-01-31',
        origin: 'o',
        ...over,
      });
    const before = await attempt({ endDate: '2025-12-31' });
    expect(before.status).toBe(400);
    expect(fieldsOf(before)).toEqual(['endDate']);
    for (const over of [
      { startDate: '2026-02-30' },
      { endDate: '31/01/2026' },
      { startDate: '2026-1-1' },
      { endDate: 20260131 },
      { origin: ' ' },
      { name: '' },
      { establishmentId: 'bad' },
    ]) {
      expect((await attempt(over)).status, JSON.stringify(over)).toBe(400);
    }
    expect((await post('/inventories', {})).status).toBe(400);
    const missing = await attempt({ establishmentId: ZERO });
    expect(missing.status).toBe(404);
    expect(missing.body.message).toMatch(/[Ee]stablecimiento/);
    const off = await mkEstablishment(false);
    const inactive = await attempt({ establishmentId: off });
    expect(inactive.status).toBe(409);
    expect(inactive.body.code).toBe('ESTABLISHMENT_INACTIVE');
  });

  it('edits check the dates against the stored ones and a new establishment must be active', async () => {
    const est = await mkEstablishment();
    const inv = await mkInventory(est);
    expect((await patch(`/inventories/${inv.id}`, { endDate: '2025-12-31' })).status).toBe(400);
    expect((await patch(`/inventories/${inv.id}`, { startDate: '2026-02-01' })).status).toBe(400);
    // Combination with the stored date is checked after 404 and VERSION_CONFLICT (H-2).
    expect((await patch(`/inventories/${ZERO}`, { endDate: '2025-12-31' })).status).toBe(404);
    expect(
      (await patch(`/inventories/${inv.id}`, { endDate: '2025-12-31' }, ifMatch(9))).body.code,
    ).toBe('VERSION_CONFLICT');
    expect((await patch(`/inventories/${inv.id}`, { endDate: 'bad' }, ifMatch(9))).status).toBe(
      400,
    );
    expect((await patch(`/inventories/${inv.id}`, { startDate: '2026-01-31' })).body.version).toBe(
      2,
    );
    const off = await mkEstablishment(false);
    expect((await patch(`/inventories/${inv.id}`, { establishmentId: off })).body.code).toBe(
      'ESTABLISHMENT_INACTIVE',
    );
    expect((await patch(`/inventories/${inv.id}`, { establishmentId: ZERO })).status).toBe(404);
    const other = await mkEstablishment();
    expect(
      (await patch(`/inventories/${inv.id}`, { establishmentId: other })).body.establishmentId,
    ).toBe(other);
    // an inventory of an establishment that later became inactive can still be edited
    await pool.query('UPDATE establishments SET is_active = false WHERE id = $1', [other]);
    const stay = await patch(`/inventories/${inv.id}`, {
      name: 'Sigue editable',
      establishmentId: other,
    });
    expect(stay.status).toBe(200);
  });

  it('lists with establishmentId, status and q; status toggles; unknown id 404', async () => {
    const tag = unique();
    const estA = await mkEstablishment();
    const estB = await mkEstablishment();
    const a = await mkInventory(estA, { name: `Alfa ${tag}` });
    const b = await mkInventory(estB, { name: `Beta ${tag}` });
    await setStatus('inventories', b.id, false);
    const ids = (res: Res) => res.body.items.map((i: { id: string }) => i.id).sort();
    expect(ids(await get(`/inventories?q=${tag}`))).toEqual([a.id, b.id].sort());
    expect(ids(await get(`/inventories?q=${tag}&establishmentId=${estB}`))).toEqual([b.id]);
    expect(ids(await get(`/inventories?q=${tag}&status=active`))).toEqual([a.id]);
    expect((await get(`/inventories?establishmentId=${estA}&status=inactive`)).body.total).toBe(0);
    expect((await get('/inventories?establishmentId=bad')).status).toBe(400);
    expect((await get(`/inventories/${ZERO}`)).status).toBe(404);
    expect((await setStatus('inventories', b.id, false)).body.version).toBe(2);
    expect((await setStatus('inventories', b.id, true)).body).toMatchObject({
      isActive: true,
      version: 3,
    });
  });
});

describe('inventory lines and quantities (CA-8, CA-9, CA-10)', () => {
  it('creates with current = initial, 3 decimals as text; dates; trimmed barcode', async () => {
    const { product, inventory } = await scenario();
    const res = await post(`/inventories/${inventory.id}/lines`, {
      productId: product.id,
      barcode: '  770123 ',
      expiresOn: '2027-03-31',
      quantityInitial: '10.5',
      quantityAlert: '2',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      inventoryId: inventory.id,
      productId: product.id,
      barcode: '770123',
      expiresOn: '2027-03-31',
      quantityInitial: '10.500',
      quantityAlert: '2.000',
      quantityCurrent: '10.500',
      isActive: true,
      version: 1,
    });
    expect(Object.keys(res.body).sort()).toEqual(
      [
        'barcode',
        'createdAt',
        'expiresOn',
        'id',
        'inventoryId',
        'isActive',
        'productId',
        'quantityAlert',
        'quantityCurrent',
        'quantityInitial',
        'updatedAt',
        'version',
      ].sort(),
    );
    const noExpiry = await mkLine(inventory.id, product.id);
    expect((await get(`/inventory-lines/${noExpiry.id}`)).body.expiresOn).toBeNull();
    const max = await mkLine(inventory.id, product.id, {
      quantityInitial: '99999999999.999',
      quantityAlert: '0',
    });
    expect(max.quantityCurrent).toBe('99999999999.999');
  });

  it('CA-8: uniqueness of (barcode, expiry) per inventory, including null expiry', async () => {
    const { product, inventory, establishmentId } = await scenario();
    const barcode = `U-${unique()}`;
    const line = (inv: string, over: Record<string, unknown> = {}) =>
      post(`/inventories/${inv}/lines`, {
        productId: product.id,
        barcode,
        quantityInitial: '1',
        quantityAlert: '0',
        ...over,
      });
    expect((await line(inventory.id)).status).toBe(201);
    const dupNull = await line(inventory.id);
    expect(dupNull.status).toBe(409);
    expect(dupNull.body.code).toBe('INVENTORY_LINE_DUPLICATE');
    expect((await line(inventory.id, { expiresOn: '2027-01-01' })).status).toBe(201);
    expect((await line(inventory.id, { expiresOn: '2027-02-01' })).status).toBe(201);
    expect((await line(inventory.id, { expiresOn: '2027-02-01' })).body.code).toBe(
      'INVENTORY_LINE_DUPLICATE',
    );
    expect((await line(inventory.id, { barcode: `${barcode}-2` })).status).toBe(201);
    const second = await mkInventory(establishmentId);
    expect((await line(second.id)).status).toBe(201);
    // inactive lines still hold the key; editing into an existing key is 409 too
    const a = await mkLine(inventory.id, product.id, { barcode: `E-${unique()}` });
    const b = await mkLine(inventory.id, product.id, { barcode: `F-${unique()}` });
    await setStatus('inventory-lines', a.id, false);
    expect((await line(inventory.id, { barcode: a.barcode })).body.code).toBe(
      'INVENTORY_LINE_DUPLICATE',
    );
    expect((await patch(`/inventory-lines/${b.id}`, { barcode: a.barcode })).body.code).toBe(
      'INVENTORY_LINE_DUPLICATE',
    );
  });

  it('concurrent creations of the same (barcode, expiry): one 201, the rest 409, never 500', async () => {
    const { product, inventory } = await scenario();
    const payload = {
      productId: product.id,
      barcode: `R-${unique()}`,
      quantityInitial: '1',
      quantityAlert: '0',
    };
    const results = await Promise.all(
      Array.from({ length: 6 }, () => post(`/inventories/${inventory.id}/lines`, payload)),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    for (const r of results.filter((r) => r.status !== 201)) {
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('INVENTORY_LINE_DUPLICATE');
    }
  });

  it('CA-9: only decimal text with <= 3 decimals and >= 0; quantityCurrent is never accepted', async () => {
    const { product, inventory } = await scenario();
    const attempt = (over: Record<string, unknown>) =>
      post(`/inventories/${inventory.id}/lines`, {
        productId: product.id,
        barcode: `Q-${unique()}`,
        quantityInitial: '1',
        quantityAlert: '0',
        ...over,
      });
    for (const over of [
      { quantityInitial: 5 },
      { quantityInitial: '-1' },
      { quantityInitial: '1.2345' },
      { quantityInitial: '1e2' },
      { quantityInitial: '100000000000' },
      { quantityAlert: '-0.001' },
      { quantityAlert: 3 },
      { quantityAlert: null },
      { barcode: '' },
      { barcode: 'x'.repeat(65) },
      { expiresOn: '2027-02-30' },
      { productId: 'bad' },
    ]) {
      expect((await attempt(over)).status, JSON.stringify(over)).toBe(400);
    }
    const sent = await attempt({ quantityCurrent: '5' });
    expect(sent.status).toBe(400);
    expect(fieldsOf(sent)).toContain('quantityCurrent');
    const line = await mkLine(inventory.id, product.id);
    const sentEdit = await patch(`/inventory-lines/${line.id}`, { quantityCurrent: '1' });
    expect(sentEdit.status).toBe(400);
    expect(fieldsOf(sentEdit)).toContain('quantityCurrent');
    expect((await patch(`/inventory-lines/${line.id}`, { quantityInitial: 5 })).status).toBe(400);
    expect((await get(`/inventory-lines/${line.id}`)).body.quantityCurrent).toBe('10.000');
    expect((await post(`/inventories/${inventory.id}/lines`, {})).status).toBe(400);
  });

  it('CA-9: editing the initial quantity moves the current one by the same exact difference', async () => {
    const { product, inventory } = await scenario();
    const line = await mkLine(inventory.id, product.id, {
      quantityInitial: '0.1',
      quantityAlert: '0.1',
    });
    const up = await patch(`/inventory-lines/${line.id}`, { quantityInitial: '0.3' });
    expect(up.status).toBe(200);
    expect(up.body).toMatchObject({
      quantityInitial: '0.300',
      quantityCurrent: '0.300',
      version: 2,
    });
    // simulate a sale: current drops independently of initial
    await pool.query(`UPDATE inventory_lines SET quantity_current = 0.150 WHERE id = $1`, [
      line.id,
    ]);
    const more = await patch(`/inventory-lines/${line.id}`, { quantityInitial: '0.5' });
    expect(more.body).toMatchObject({ quantityInitial: '0.500', quantityCurrent: '0.350' });
    const less = await patch(`/inventory-lines/${line.id}`, { quantityInitial: '0.35' });
    expect(less.body).toMatchObject({ quantityInitial: '0.350', quantityCurrent: '0.200' });
    const exactZero = await patch(`/inventory-lines/${line.id}`, { quantityInitial: '0.150' });
    expect(exactZero.body).toMatchObject({ quantityInitial: '0.150', quantityCurrent: '0.000' });
  });

  it('CA-9: if the current quantity would go negative -> 409 QUANTITY_BELOW_ZERO and nothing changes', async () => {
    const { product, inventory } = await scenario();
    const line = await mkLine(inventory.id, product.id, { quantityInitial: '10' });
    await pool.query(`UPDATE inventory_lines SET quantity_current = 2 WHERE id = $1`, [line.id]);
    const before = (await get(`/inventory-lines/${line.id}`)).body;
    const res = await patch(`/inventory-lines/${line.id}`, {
      quantityInitial: '7.999',
      barcode: 'CHANGED',
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('QUANTITY_BELOW_ZERO');
    expect((await get(`/inventory-lines/${line.id}`)).body).toEqual(before);
    expect((await get(`/inventory-lines/${line.id}/history`)).body.total).toBe(1);
    const ok = await patch(`/inventory-lines/${line.id}`, { quantityInitial: '8' });
    expect(ok.body).toMatchObject({ quantityInitial: '8.000', quantityCurrent: '0.000' });
  });

  it('CA-10: history: created row, one initial_adjusted row per change, none for other edits', async () => {
    const { product, inventory } = await scenario();
    const line = await mkLine(inventory.id, product.id, { quantityInitial: '10.5' });
    const history = async (query = '') =>
      (await get(`/inventory-lines/${line.id}/history${query}`)).body;
    let h = await history();
    expect(h.total).toBe(1);
    expect(h.items[0]).toEqual({
      reason: 'created',
      initialBefore: null,
      initialAfter: '10.500',
      currentBefore: null,
      currentAfter: '10.500',
      delta: null,
      actorId: admin.userId,
      changedAt: expect.any(String),
    });
    await sleep(15);
    const other = await actor(['inventories.update', 'inventories.read']);
    const adjust = await call('PATCH', `/inventory-lines/${line.id}`, {
      token: other.token,
      body: { quantityInitial: '15' },
    });
    expect(adjust.status).toBe(200);
    await sleep(15);
    await patch(`/inventory-lines/${line.id}`, { quantityAlert: '3' });
    await patch(`/inventory-lines/${line.id}`, { barcode: `NEW-${unique()}` });
    await patch(`/inventory-lines/${line.id}`, { quantityInitial: '15.000' });
    await patch(`/inventory-lines/${line.id}`, { quantityInitial: '9.25' }, ifMatch(1));
    await sleep(15);
    await patch(`/inventory-lines/${line.id}`, {
      quantityInitial: '9.25',
      expiresOn: '2027-01-01',
    });
    await sleep(15);
    await patch(`/inventory-lines/${line.id}`, { quantityInitial: '5' });
    h = await history();
    expect(h.total).toBe(4);
    expect(h.items[0]).toMatchObject({
      reason: 'initial_adjusted',
      initialBefore: '9.250',
      initialAfter: '5.000',
      currentBefore: '9.250',
      currentAfter: '5.000',
      delta: '-4.250',
      actorId: admin.userId,
    });
    expect(h.items[1]).toMatchObject({
      initialBefore: '15.000',
      initialAfter: '9.250',
      delta: '-5.750',
    });
    expect(h.items[2]).toMatchObject({
      reason: 'initial_adjusted',
      initialBefore: '10.500',
      initialAfter: '15.000',
      currentBefore: '10.500',
      currentAfter: '15.000',
      delta: '4.500',
      actorId: other.userId,
    });
    expect(h.items[3].reason).toBe('created');
    const dates = h.items.map((i: { changedAt: string }) => Date.parse(i.changedAt));
    for (let k = 1; k < dates.length; k++) expect(dates[k - 1]).toBeGreaterThan(dates[k]);
    const page = await history('?limit=1&offset=3');
    expect(page).toMatchObject({ total: 4, limit: 1, offset: 3 });
    expect(page.items[0].reason).toBe('created');
    expect((await get(`/inventory-lines/${ZERO}/history`)).status).toBe(404);
    expect((await get(`/inventory-lines/${line.id}/history?limit=201`)).status).toBe(400);
  });

  it('lists the lines of an inventory with productId, barcode and status; unknown inventory 404', async () => {
    const { category, product, inventory } = await scenario();
    const other = await mkProduct(category.id);
    const a = await mkLine(inventory.id, product.id, { barcode: `A-${unique()}` });
    const b = await mkLine(inventory.id, other.id, { barcode: `B-${unique()}` });
    await setStatus('inventory-lines', b.id, false);
    const ids = (res: Res) => res.body.items.map((l: { id: string }) => l.id).sort();
    const url = `/inventories/${inventory.id}/lines`;
    expect(ids(await get(url))).toEqual([a.id, b.id].sort());
    expect(ids(await get(`${url}?productId=${other.id}`))).toEqual([b.id]);
    expect(ids(await get(`${url}?barcode=${a.barcode}`))).toEqual([a.id]);
    expect(ids(await get(`${url}?status=inactive`))).toEqual([b.id]);
    expect((await get(`${url}?limit=1`)).body).toMatchObject({ total: 2, limit: 1, offset: 0 });
    expect((await get(`/inventories/${ZERO}/lines`)).status).toBe(404);
    expect(
      (
        await post(`/inventories/${ZERO}/lines`, {
          productId: product.id,
          barcode: 'x',
          quantityInitial: '1',
          quantityAlert: '0',
        })
      ).status,
    ).toBe(404);
    const noProduct = await post(url, {
      productId: ZERO,
      barcode: 'x',
      quantityInitial: '1',
      quantityAlert: '0',
    });
    expect(noProduct.status).toBe(404);
    expect(noProduct.body.message).toMatch(/[Pp]roducto/);
  });
});

describe('active dependencies R-8 (CA-11)', () => {
  it('a category with active products cannot be deactivated; it can once they are inactive', async () => {
    const cat = await mkCategory();
    const p1 = await mkProduct(cat.id);
    const blocked = await setStatus('categories', cat.id, false);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('CATEGORY_HAS_ACTIVE_PRODUCTS');
    expect((await get(`/categories/${cat.id}`)).body).toMatchObject({ isActive: true, version: 1 });
    await setStatus('products', p1.id, false);
    expect((await setStatus('categories', cat.id, false)).body.isActive).toBe(false);
  });

  it('a product in an active line of an active inventory cannot be deactivated', async () => {
    const { product, inventory } = await scenario();
    const line = await mkLine(inventory.id, product.id);
    const blocked = await setStatus('products', product.id, false);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('PRODUCT_IN_ACTIVE_INVENTORY');
    // allowed when the line is inactive...
    await setStatus('inventory-lines', line.id, false);
    expect((await setStatus('products', product.id, false)).status).toBe(200);
    await setStatus('products', product.id, true);
    // ...or when the inventory is inactive (the line stays active)
    await setStatus('inventory-lines', line.id, true);
    expect((await setStatus('products', product.id, false)).status).toBe(409);
    await setStatus('inventories', inventory.id, false);
    expect((await get(`/inventory-lines/${line.id}`)).body.isActive).toBe(true);
    expect((await setStatus('products', product.id, false)).status).toBe(200);
  });

  it('lines of an inactive inventory or with an inactive product are rejected; deactivating one is allowed', async () => {
    const { category, product, inventory } = await scenario();
    const line = await mkLine(inventory.id, product.id);
    const payload = (productId: string) => ({
      productId,
      barcode: `D-${unique()}`,
      quantityInitial: '1',
      quantityAlert: '0',
    });
    await setStatus('inventories', inventory.id, false);
    const create = await post(`/inventories/${inventory.id}/lines`, payload(product.id));
    expect(create.status).toBe(409);
    expect(create.body.code).toBe('INVENTORY_INACTIVE');
    expect((await patch(`/inventory-lines/${line.id}`, { quantityAlert: '1' })).body.code).toBe(
      'INVENTORY_INACTIVE',
    );
    expect((await setStatus('inventory-lines', line.id, false)).status).toBe(200);
    const activate = await setStatus('inventory-lines', line.id, true);
    expect(activate.status).toBe(409);
    expect(activate.body.code).toBe('INVENTORY_INACTIVE');
    await setStatus('inventories', inventory.id, true);
    const off = await mkProduct(category.id);
    await setStatus('products', off.id, false);
    const inactiveProduct = await post(`/inventories/${inventory.id}/lines`, payload(off.id));
    expect(inactiveProduct.status).toBe(409);
    expect(inactiveProduct.body.code).toBe('PRODUCT_INACTIVE');
    // a line left active with an inactive product (inventory was inactive when it happened)
    await pool.query('UPDATE products SET is_active = false WHERE id = $1', [product.id]);
    expect((await patch(`/inventory-lines/${line.id}`, { quantityAlert: '1' })).body.code).toBe(
      'PRODUCT_INACTIVE',
    );
    expect((await setStatus('inventory-lines', line.id, true)).body.code).toBe('PRODUCT_INACTIVE');
    await pool.query('UPDATE products SET is_active = true WHERE id = $1', [product.id]);
    expect((await setStatus('inventory-lines', line.id, true)).status).toBe(200);
  });

  it('an inactive product cannot be activated while its category is inactive', async () => {
    const cat = await mkCategory();
    const product = await mkProduct(cat.id);
    await setStatus('products', product.id, false);
    await setStatus('categories', cat.id, false);
    const res = await setStatus('products', product.id, true);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CATEGORY_INACTIVE');
    await setStatus('categories', cat.id, true);
    expect((await setStatus('products', product.id, true)).status).toBe(200);
  });

  it('deactivating an establishment is not restricted by its inventories (sprint 003 unchanged)', async () => {
    const est = await mkEstablishment();
    await mkInventory(est);
    const user = await actor(['establishments.deactivate']);
    const res = await call('PATCH', `/establishments/${est}/status`, {
      token: user.token,
      body: { isActive: false },
    });
    expect(res.status).toBe(200);
  });
});

describe('R-8 races (CA-12)', () => {
  it('deactivating a category in parallel with creating a product never leaves an active product in an inactive category', async () => {
    for (let i = 0; i < 12; i++) {
      const cat = await mkCategory();
      const [create, deactivate] = await Promise.all([
        post('/products', {
          sku: `RC-${unique()}`,
          name: 'p',
          unit: 'unit',
          categoryId: cat.id,
          price: '1',
        }),
        setStatus('categories', cat.id, false),
      ]);
      expect([201, 409], create.raw).toContain(create.status);
      expect([200, 409], deactivate.raw).toContain(deactivate.status);
      const { rows } = await pool.query(
        `SELECT 1 FROM products p JOIN categories c ON c.id = p.category_id
         WHERE c.id = $1 AND p.is_active AND NOT c.is_active`,
        [cat.id],
      );
      expect(rows, `round ${i}`).toHaveLength(0);
      if (create.status === 201) expect(deactivate.status).toBe(409);
    }
  });

  it('moving a product to a category being deactivated never leaves it active in an inactive category', async () => {
    for (let i = 0; i < 8; i++) {
      const from = await mkCategory();
      const to = await mkCategory();
      const product = await mkProduct(from.id);
      const [move, deactivate] = await Promise.all([
        patch(`/products/${product.id}`, { categoryId: to.id }),
        setStatus('categories', to.id, false),
      ]);
      expect([200, 409], move.raw).toContain(move.status);
      expect([200, 409], deactivate.raw).toContain(deactivate.status);
      const { rows } = await pool.query(
        `SELECT 1 FROM products p JOIN categories c ON c.id = p.category_id
         WHERE p.id = $1 AND p.is_active AND NOT c.is_active`,
        [product.id],
      );
      expect(rows, `round ${i}`).toHaveLength(0);
    }
  });

  it('deactivating a product in parallel with adding a line never leaves an active line of an active inventory with an inactive product', async () => {
    for (let i = 0; i < 12; i++) {
      const { product, inventory } = await scenario();
      const [create, deactivate] = await Promise.all([
        post(`/inventories/${inventory.id}/lines`, {
          productId: product.id,
          barcode: `RL-${unique()}`,
          quantityInitial: '1',
          quantityAlert: '0',
        }),
        setStatus('products', product.id, false),
      ]);
      expect([201, 409], create.raw).toContain(create.status);
      expect([200, 409], deactivate.raw).toContain(deactivate.status);
      const { rows } = await pool.query(
        `SELECT 1 FROM inventory_lines l JOIN inventories i ON i.id = l.inventory_id
         JOIN products p ON p.id = l.product_id
         WHERE l.inventory_id = $1 AND l.is_active AND i.is_active AND NOT p.is_active`,
        [inventory.id],
      );
      expect(rows, `round ${i}`).toHaveLength(0);
      if (create.status === 201) expect(deactivate.status).toBe(409);
    }
  });

  it('concurrent edits of the initial quantity apply each difference exactly once (current never negative)', async () => {
    const { product, inventory } = await scenario();
    const line = await mkLine(inventory.id, product.id, { quantityInitial: '100' });
    const targets = ['110', '120', '130', '140', '150'];
    const results = await Promise.all(
      targets.map((q) => patch(`/inventory-lines/${line.id}`, { quantityInitial: q })),
    );
    for (const r of results) expect(r.status, r.raw).toBe(200);
    const { rows } = await pool.query(
      'SELECT quantity_initial::text AS i, quantity_current::text AS c, version FROM inventory_lines WHERE id = $1',
      [line.id],
    );
    expect(rows[0].c).toBe(rows[0].i);
    expect(rows[0].version).toBe(6);
    const history = await pool.query(
      'SELECT count(*) FROM inventory_line_history WHERE line_id = $1',
      [line.id],
    );
    expect(Number(history.rows[0].count)).toBe(6);
  });
});

describe('offline protocol in the 4 resources (CA-14)', () => {
  const makers: [
    string,
    string,
    () => Promise<{ id: string; version: number }>,
    Record<string, unknown>,
    string,
  ][] = [
    ['categories', 'CATEGORY_ID_TAKEN', () => mkCategory(), { name: 'Editada' }, 'name'],
    [
      'products',
      'PRODUCT_ID_TAKEN',
      async () => mkProduct((await mkCategory()).id),
      { name: 'Editado' },
      'name',
    ],
    [
      'inventories',
      'INVENTORY_ID_TAKEN',
      async () => mkInventory(await mkEstablishment()),
      { name: 'Editado' },
      'name',
    ],
    [
      'inventory-lines',
      'INVENTORY_LINE_ID_TAKEN',
      async () => {
        const { product, inventory } = await scenario();
        return mkLine(inventory.id, product.id);
      },
      { quantityAlert: '9' },
      'quantityAlert',
    ],
  ];

  it.each(makers)(
    '%s: stale If-Match is VERSION_CONFLICT with the public copy; version +1 per write',
    async (path, _taken, make, edit, field) => {
      const item = await make();
      expect(item.version).toBe(1);
      const stale = await patch(`/${path}/${item.id}`, edit, ifMatch(5));
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('VERSION_CONFLICT');
      expect(stale.body.current).toMatchObject({ id: item.id, version: 1 });
      expect(stale.body.current).not.toHaveProperty('change_xid');
      const ok = await patch(`/${path}/${item.id}`, edit, ifMatch(1));
      expect(ok.status).toBe(200);
      expect(ok.body.version).toBe(2);
      expect(String(ok.body[field])).toMatch(/Editad|9/);
      const staleStatus = await setStatus(path, item.id, false, ifMatch(1));
      expect(staleStatus.status).toBe(409);
      expect(staleStatus.body.code).toBe('VERSION_CONFLICT');
      expect(staleStatus.body.current.version).toBe(2);
      expect((await setStatus(path, item.id, false, ifMatch(2))).body.version).toBe(3);
      expect((await patch(`/${path}/${item.id}`, edit, { 'If-Match': 'abc' })).status).toBe(400);
      expect((await get(`/${path}/${item.id}`)).body.version).toBe(3);
    },
  );

  it('client ids: used id is 409 <RECURSO>_ID_TAKEN, bad id is 400, the id is kept', async () => {
    const cat = await mkCategory();
    const est = await mkEstablishment();
    const inv = await mkInventory(est);
    const prod = await mkProduct(cat.id);
    const creators: [string, string, string, () => unknown][] = [
      [
        '/categories',
        'CATEGORY_ID_TAKEN',
        'categories',
        () => ({ code: `I-${unique()}`.toUpperCase(), name: `Cat ${unique()}` }),
      ],
      [
        '/products',
        'PRODUCT_ID_TAKEN',
        'products',
        () => ({ sku: `I-${unique()}`, name: 'p', unit: 'unit', categoryId: cat.id, price: '1' }),
      ],
      [
        '/inventories',
        'INVENTORY_ID_TAKEN',
        'inventories',
        () => ({
          establishmentId: est,
          name: 'n',
          startDate: '2026-01-01',
          endDate: '2026-01-02',
          origin: 'o',
        }),
      ],
      [
        `/inventories/${inv.id}/lines`,
        'INVENTORY_LINE_ID_TAKEN',
        'inventory-lines',
        () => ({
          productId: prod.id,
          barcode: `I-${unique()}`,
          quantityInitial: '1',
          quantityAlert: '0',
        }),
      ],
    ];
    for (const [url, code, path, payload] of creators) {
      const id = uuid();
      const res = await post(url, { ...(payload() as object), id });
      expect(res.status, url).toBe(201);
      expect(res.body.id).toBe(id);
      expect((await get(`/${path}/${id}`)).status).toBe(200);
      const again = await post(url, { ...(payload() as object), id });
      expect(again.status, url).toBe(409);
      expect(again.body.code).toBe(code);
      const bad = await post(url, { ...(payload() as object), id: 'nope' });
      expect(bad.status).toBe(400);
      expect(fieldsOf(bad)).toContain('id');
      // concurrent creations with the same id: one wins, never 500
      const raceId = uuid();
      const race = await Promise.all(
        Array.from({ length: 4 }, () => post(url, { ...(payload() as object), id: raceId })),
      );
      expect(race.filter((r) => r.status === 201)).toHaveLength(1);
      for (const r of race.filter((r) => r.status !== 201)) {
        expect(r.status, r.raw).toBe(409);
        expect(code).toBe(r.body.code);
      }
    }
  });

  it('Idempotency-Key: replays answer the same body without duplicating rows, history rows or events', async () => {
    const cat = await mkCategory();
    const est = await mkEstablishment();
    const inv = await mkInventory(est);
    const prod = await mkProduct(cat.id, { price: '10' });

    const productKey = uuid();
    const productBody = {
      sku: `K-${unique()}`,
      name: 'p',
      unit: 'unit',
      categoryId: cat.id,
      price: '5',
    };
    const p1 = await post('/products', productBody, withKey(productKey));
    const p2 = await post('/products', productBody, withKey(productKey));
    expect(p2.status).toBe(201);
    expect(p2.body).toEqual(p1.body);
    const priceRows = await pool.query(
      'SELECT count(*) FROM product_price_history WHERE product_id = $1',
      [p1.body.id],
    );
    expect(Number(priceRows.rows[0].count)).toBe(1);

    const priceKey = uuid();
    const e1 = await patch(`/products/${prod.id}`, { price: '20' }, withKey(priceKey));
    const e2 = await patch(`/products/${prod.id}`, { price: '20' }, withKey(priceKey));
    expect(e2.body).toEqual(e1.body);
    expect(e2.body.version).toBe(2);
    expect((await get(`/products/${prod.id}/price-history`)).body.total).toBe(2);
    expect(eventNames(prod.id).filter((e) => e === 'product.price_changed')).toHaveLength(1);

    const lineKey = uuid();
    const lineBody = {
      productId: prod.id,
      barcode: `K-${unique()}`,
      quantityInitial: '4',
      quantityAlert: '1',
    };
    const l1 = await post(`/inventories/${inv.id}/lines`, lineBody, withKey(lineKey));
    const l2 = await post(`/inventories/${inv.id}/lines`, lineBody, withKey(lineKey));
    expect(l2.status).toBe(201);
    expect(l2.body).toEqual(l1.body);
    const adjustKey = uuid();
    const a1 = await patch(
      `/inventory-lines/${l1.body.id}`,
      { quantityInitial: '6' },
      withKey(adjustKey),
    );
    const a2 = await patch(
      `/inventory-lines/${l1.body.id}`,
      { quantityInitial: '6' },
      withKey(adjustKey),
    );
    expect(a2.body).toEqual(a1.body);
    expect(a2.body.version).toBe(2);
    expect((await get(`/inventory-lines/${l1.body.id}/history`)).body.total).toBe(2);
    const count = await pool.query('SELECT count(*) FROM inventory_lines WHERE barcode = $1', [
      lineBody.barcode,
    ]);
    expect(Number(count.rows[0].count)).toBe(1);
    expect(eventNames(l1.body.id).filter((e) => String(e).startsWith('inventory_line.'))).toEqual([
      'inventory_line.created',
      'inventory_line.updated',
      'inventory_line.quantity_adjusted',
    ]);
    // the same key with another body is rejected, not applied
    const mismatch = await post(
      '/products',
      { ...productBody, sku: `K-${unique()}` },
      withKey(productKey),
    );
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});

describe('change feeds (CA-15)', () => {
  type Item = { id: string };
  const feeds: [string, string, () => Promise<string>, (id: string) => Promise<unknown>][] = [
    [
      'categories',
      'categories',
      async () => (await mkCategory()).id,
      (id) => patch(`/categories/${id}`, { name: `Feed ${unique()}` }),
    ],
    [
      'products',
      'products',
      async () => (await mkProduct((await mkCategory()).id)).id,
      (id) => patch(`/products/${id}`, { name: `Feed ${unique()}` }),
    ],
    [
      'inventories',
      'inventories',
      async () => (await mkInventory(await mkEstablishment())).id,
      (id) => patch(`/inventories/${id}`, { name: `Feed ${unique()}` }),
    ],
    [
      'inventory-lines',
      'inventory_lines',
      async () => {
        const { product, inventory } = await scenario();
        return (await mkLine(inventory.id, product.id)).id;
      },
      (id) => patch(`/inventory-lines/${id}`, { quantityAlert: '7' }),
    ],
  ];

  async function drain(path: string, cursor?: string, limit = 3) {
    const items: Item[] = [];
    let next = cursor;
    for (let guard = 0; guard < 1000; guard++) {
      const res = await get(`/${path}/changes?limit=${limit}${next ? `&cursor=${next}` : ''}`);
      expect(res.status).toBe(200);
      items.push(...(res.body.items as Item[]));
      next = res.body.nextCursor ?? undefined;
      if (!res.body.hasMore) return { items, cursor: next };
    }
    throw new Error('feed does not terminate');
  }

  /** Wait for the feed to show what was written (ADR-0002: another open write transaction in the cluster delays it). */
  const FEED_WAIT_MS = 60_000;
  /** Vitest timeout for the tests that wait on the feed; above `FEED_WAIT_MS` so the clear message wins. */
  const FEED_TEST_TIMEOUT_MS = 90_000;

  /** Re-reads with `read` every 250 ms until `ready` accepts the result; fails with a clear message at the deadline. */
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

  /** `drain` repeated until the feed from `cursor` contains every id in `ids`. */
  const drainUntilSeen = (path: string, ids: string[], cursor?: string) =>
    eventually(
      `${ids.length} expected change(s) in ${path}`,
      () => drain(path, cursor),
      (r) => ids.every((id) => r.items.some((i) => i.id === id)),
    );

  it.each(feeds)(
    '%s: complete without repeats, incremental from a cursor, idle cursor is stable',
    async (path, table, make, edit) => {
      const created: string[] = [];
      for (let i = 0; i < 4; i++) created.push(await make());
      const all = await pool.query<{ id: string }>(`SELECT id FROM ${table}`);
      const full = await eventually(
        `every row of ${table}`,
        () => drain(path, undefined, 3),
        (r) => all.rows.every((row) => r.items.some((i) => i.id === row.id)),
      );
      const ids = full.items.map((i) => i.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect([...ids].sort()).toEqual(all.rows.map((r) => r.id).sort());
      const page = await eventually(
        'a full first page',
        () => get(`/${path}/changes?limit=2`),
        (r) => r.status !== 200 || (r.body.items as Item[]).length === 2,
      );
      expect(Object.keys(page.body).sort()).toEqual(['hasMore', 'items', 'nextCursor']);
      expect(page.body).toMatchObject({ hasMore: true });

      const cursor = full.cursor!;
      const idle = await get(`/${path}/changes?cursor=${cursor}`);
      expect(idle.body).toEqual({ items: [], nextCursor: cursor, hasMore: false });
      const newOne = await make();
      await edit(created[0]!);
      await setStatus(path, created[1]!, false);
      const next = await drainUntilSeen(path, [created[0]!, created[1]!, newOne], cursor);
      expect(next.items.map((i) => i.id).sort()).toEqual([created[0]!, created[1]!, newOne].sort());
      expect((await drain(path, next.cursor)).items).toEqual([]);
      // a conflict or an idempotent replay produces no feed entry
      await patch(`/${path}/${created[2]!}`, {}, ifMatch(9));
      await setStatus(path, created[1]!, false);
      expect((await drain(path, next.cursor)).items).toEqual([]);
    },
    FEED_TEST_TIMEOUT_MS,
  );

  it.each(feeds)(
    '%s: a change in a transaction still open while reading is not lost',
    async (path, table, make) => {
      const open = await make();
      const { cursor: start } = await drainUntilSeen(path, [open]);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `UPDATE ${table} SET version = version + 1, change_xid = pg_current_xact_id() WHERE id = $1`,
          [open],
        );
        const later = await make();
        const during = await get(`/${path}/changes?cursor=${start}`);
        expect(during.status).toBe(200);
        const seen = (during.body.items as Item[]).map((i) => i.id);
        expect(seen).not.toContain(open);
        expect(seen).not.toContain(later);
        expect(during.body.nextCursor).toBe(start);
        await client.query('COMMIT');
        const ids = (await drainUntilSeen(path, [open, later], during.body.nextCursor)).items.map(
          (i) => i.id,
        );
        expect(ids).toContain(open);
        expect(ids).toContain(later);
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    },
    FEED_TEST_TIMEOUT_MS,
  );

  it.each(feeds)(
    '%s: invalid cursor or limit is 400 and "changes" is not read as an id',
    async (path) => {
      const bad = [
        'cursor=***',
        `cursor=${Buffer.from('{oops').toString('base64url')}`,
        `cursor=${Buffer.from(JSON.stringify({ x: '12a', i: uuid() })).toString('base64url')}`,
        `cursor=${Buffer.from(JSON.stringify({ x: '1', i: 'nope' })).toString('base64url')}`,
        'limit=0',
        'limit=501',
      ];
      for (const query of bad) {
        const res = await get(`/${path}/changes?${query}`);
        expect(res.status, query).toBe(400);
        expect(res.body.code).toBe('VALIDATION_ERROR');
      }
      expect((await get(`/${path}/changes?limit=500`)).status).toBe(200);
      expect((await get(`/${path}/changes`)).body).toHaveProperty('items');
    },
  );

  it('the history routes are not read as ids and the histories have no feed', async () => {
    const { product, inventory } = await scenario();
    const line = await mkLine(inventory.id, product.id);
    expect((await get(`/products/${product.id}/price-history`)).status).toBe(200);
    expect((await get(`/inventory-lines/${line.id}/history`)).status).toBe(200);
    expect((await get(`/inventory-lines/${line.id}/history/changes`)).status).toBe(404);
  });
});

describe('error order (CA-18) and audit (CA-16)', () => {
  it('400 before 404, 404 before VERSION_CONFLICT, VERSION_CONFLICT before business and uniqueness errors', async () => {
    expect((await patch(`/products/${ZERO}`, { price: '-1' })).status).toBe(400);
    expect((await patch(`/products/${ZERO}`, { price: '1' }, ifMatch(9))).status).toBe(404);
    const cat = await mkCategory();
    const a = await mkProduct(cat.id);
    const b = await mkProduct(cat.id);
    const staleDup = await patch(`/products/${b.id}`, { sku: a.sku }, ifMatch(7));
    expect(staleDup.body.code).toBe('VERSION_CONFLICT');
    expect((await patch(`/products/${b.id}`, { sku: a.sku }, ifMatch(1))).body.code).toBe(
      'PRODUCT_SKU_TAKEN',
    );
    const { product, inventory } = await scenario();
    const line = await mkLine(inventory.id, product.id);
    await pool.query('UPDATE inventory_lines SET quantity_current = 0 WHERE id = $1', [line.id]);
    const staleNegative = await patch(
      `/inventory-lines/${line.id}`,
      { quantityInitial: '1' },
      ifMatch(4),
    );
    expect(staleNegative.body.code).toBe('VERSION_CONFLICT');
    expect(
      (await patch(`/inventory-lines/${line.id}`, { quantityInitial: '1' }, ifMatch(1))).body.code,
    ).toBe('QUANTITY_BELOW_ZERO');
    const blockedCat = await mkCategory();
    await mkProduct(blockedCat.id);
    expect((await setStatus('categories', blockedCat.id, false, ifMatch(4))).body.code).toBe(
      'VERSION_CONFLICT',
    );
    expect((await setStatus('categories', blockedCat.id, false, ifMatch(1))).body.code).toBe(
      'CATEGORY_HAS_ACTIVE_PRODUCTS',
    );
  });

  it('CA-16: every write records its event with the resource id and the actor, without secrets', async () => {
    const cat = await mkCategory();
    await patch(`/categories/${cat.id}`, { name: `Audit ${unique()}` });
    const product = await mkProduct(cat.id, { price: '1' });
    await patch(`/products/${product.id}`, { price: '2' });
    await setStatus('products', product.id, false);
    await setStatus('products', product.id, true);
    const est = await mkEstablishment();
    const inv = await mkInventory(est);
    await patch(`/inventories/${inv.id}`, { origin: 'Otro' });
    await setStatus('inventories', inv.id, false);
    await setStatus('inventories', inv.id, true);
    const line = await mkLine(inv.id, product.id);
    await patch(`/inventory-lines/${line.id}`, { quantityInitial: '12' });
    await setStatus('inventory-lines', line.id, false);
    await setStatus('inventory-lines', line.id, false);
    await setStatus('inventory-lines', line.id, true);
    await setStatus('categories', cat.id, false);

    expect(eventNames(cat.id)).toEqual(['category.created', 'category.updated']);
    expect(eventNames(product.id).filter((e) => String(e).startsWith('product.'))).toEqual([
      'product.created',
      'product.updated',
      'product.price_changed',
      'product.deactivated',
      'product.activated',
    ]);
    expect(eventNames(inv.id).filter((e) => String(e).startsWith('inventory.'))).toEqual([
      'inventory.created',
      'inventory.updated',
      'inventory.deactivated',
      'inventory.activated',
    ]);
    expect(eventNames(line.id)).toEqual([
      'inventory_line.created',
      'inventory_line.updated',
      'inventory_line.quantity_adjusted',
      'inventory_line.deactivated',
      'inventory_line.activated',
    ]);
    for (const [id, key] of [
      [cat.id, 'categoryId'],
      [product.id, 'productId'],
      [inv.id, 'inventoryId'],
      [line.id, 'lineId'],
    ] as const) {
      for (const event of eventsOf(id)) {
        expect(event[key]).toBe(id);
        expect(event.actorId).toBe(admin.userId);
      }
    }
    const adjusted = eventsOf(line.id).find((e) => e.event === 'inventory_line.quantity_adjusted')!;
    expect(adjusted.delta).toBe('2.000');
    for (const line of logs) expect(line).not.toContain(admin.token);
  });
});

describe('error order: business before uniqueness in every resource (CA-18, DEF-1)', () => {
  it('products: 404 category, then CATEGORY_INACTIVE, then PRODUCT_SKU_TAKEN / PRODUCT_ID_TAKEN', async () => {
    const live = await mkCategory();
    const off = await mkCategory();
    const taken = await mkProduct(live.id);
    const other = await mkProduct(live.id);
    await setStatus('categories', off.id, false);
    const body = (categoryId: string, extra: Record<string, unknown> = {}) => ({
      sku: taken.sku,
      name: 'dup',
      unit: 'unit',
      categoryId,
      price: '1',
      ...extra,
    });
    // POST with a duplicate SKU
    const missing = await post('/products', body(uuid()));
    expect(missing.status).toBe(404);
    expect(missing.body.message).toContain('ategor');
    expect((await post('/products', body(off.id))).body.code).toBe('CATEGORY_INACTIVE');
    expect((await post('/products', body(live.id))).body.code).toBe('PRODUCT_SKU_TAKEN');
    // POST with a used id
    const idBody = (categoryId: string) =>
      body(categoryId, { sku: `SKU-${unique()}`, id: taken.id });
    expect((await post('/products', idBody(uuid()))).status).toBe(404);
    expect((await post('/products', idBody(off.id))).body.code).toBe('CATEGORY_INACTIVE');
    expect((await post('/products', idBody(live.id))).body.code).toBe('PRODUCT_ID_TAKEN');
    // PATCH with a duplicate SKU
    const edit = (categoryId: string, headers?: Record<string, string>) =>
      patch(`/products/${other.id}`, { sku: taken.sku, categoryId }, headers);
    expect((await edit(uuid())).status).toBe(404);
    expect((await edit(off.id)).body.code).toBe('CATEGORY_INACTIVE');
    expect((await edit(off.id, ifMatch(9))).body.code).toBe('VERSION_CONFLICT');
    expect((await edit(live.id, ifMatch(9))).body.code).toBe('VERSION_CONFLICT');
    expect((await edit(live.id)).body.code).toBe('PRODUCT_SKU_TAKEN');
    expect((await get(`/products/${other.id}`)).body.version).toBe(1);
  });

  it('inventories and lines: parents are checked before a used id or a duplicate line', async () => {
    const { category, product, inventory } = await scenario();
    const offEstablishment = await mkEstablishment(false);
    const onEstablishment = inventoryEstablishment(inventory);
    const invBody = (establishmentId: string) => ({
      id: inventory.id,
      establishmentId,
      name: 'dup',
      startDate: '2026-01-01',
      endDate: '2026-01-31',
      origin: 'X',
    });
    expect((await post('/inventories', invBody(uuid()))).status).toBe(404);
    expect((await post('/inventories', invBody(offEstablishment))).body.code).toBe(
      'ESTABLISHMENT_INACTIVE',
    );
    expect((await post('/inventories', invBody(onEstablishment))).body.code).toBe(
      'INVENTORY_ID_TAKEN',
    );

    const line = await mkLine(inventory.id, product.id, { barcode: 'DUP-1' });
    const offProduct = await mkProduct(category.id);
    await setStatus('products', offProduct.id, false);
    const lineBody = (productId: string, extra: Record<string, unknown> = {}) => ({
      productId,
      barcode: 'DUP-1',
      quantityInitial: '1',
      quantityAlert: '0',
      ...extra,
    });
    const url = `/inventories/${inventory.id}/lines`;
    expect((await post(url, lineBody(uuid()))).status).toBe(404);
    expect((await post(url, lineBody(offProduct.id))).body.code).toBe('PRODUCT_INACTIVE');
    expect((await post(url, lineBody(product.id))).body.code).toBe('INVENTORY_LINE_DUPLICATE');
    expect((await post(url, lineBody(offProduct.id, { id: line.id }))).body.code).toBe(
      'PRODUCT_INACTIVE',
    );
    expect(
      (await post(url, lineBody(product.id, { id: line.id, barcode: 'DUP-2' }))).body.code,
    ).toBe('INVENTORY_LINE_ID_TAKEN');
    await setStatus('inventories', inventory.id, false);
    expect((await post(url, lineBody(product.id))).body.code).toBe('INVENTORY_INACTIVE');
    expect((await post(url, lineBody(product.id, { id: line.id }))).body.code).toBe(
      'INVENTORY_INACTIVE',
    );
  });
});

function inventoryEstablishment(inventory: { establishmentId: string }): string {
  return inventory.establishmentId;
}

describe('history clock: the database clock, ordered by changed_at DESC, id DESC (CA-6, CA-10)', () => {
  it('price history takes changed_at from the database even when the application passes another time', async () => {
    const cat = await mkCategory();
    const product = await mkProduct(cat.id, { price: '10' });
    const repository = new PostgresProductRepository(pool);
    const past = new Date('2000-01-01T00:00:00Z');
    const before = (await pool.query<{ t: Date }>('SELECT clock_timestamp() AS t')).rows[0]!.t;
    const outcome = await repository.update(product.id, { price: '20.00' }, admin.userId, past);
    expect(outcome.status).toBe('updated');
    const after = (await pool.query<{ t: Date }>('SELECT clock_timestamp() AS t')).rows[0]!.t;
    const { rows } = await pool.query<{ changed_at: Date }>(
      'SELECT changed_at FROM product_price_history WHERE product_id = $1 ORDER BY id',
      [product.id],
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.changed_at.getFullYear()).toBeGreaterThan(2000);
    const edited = rows.find((row) => row.changed_at >= new Date(before.getTime() - 1000))!;
    expect(edited.changed_at.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(edited.changed_at.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it('line history takes changed_at from the database on edits too', async () => {
    const { product, inventory } = await scenario();
    const line = await mkLine(inventory.id, product.id, { quantityInitial: '5' });
    const repository = new PostgresInventoryLineRepository(pool);
    const outcome = await repository.update(
      line.id,
      { quantityInitial: '7' },
      admin.userId,
      new Date('2000-01-01T00:00:00Z'),
    );
    expect(outcome.status).toBe('updated');
    const { rows } = await pool.query<{ changed_at: Date }>(
      'SELECT changed_at FROM inventory_line_history WHERE line_id = $1',
      [line.id],
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.changed_at.getFullYear()).toBeGreaterThan(2000);
  });

  it('rows with the same changed_at come out by id descending in both history endpoints', async () => {
    const { product, inventory } = await scenario();
    const line = await mkLine(inventory.id, product.id);
    const at = '2030-01-01T00:00:00Z';
    const ids = [uuid(), uuid(), uuid()].sort();
    for (const [n, id] of ids.entries()) {
      // the ascending id carries the value n + 1, so the expected order is 3, 2, 1
      await pool.query(
        `INSERT INTO product_price_history (id, product_id, old_price, new_price, actor_id, changed_at)
         VALUES ($1, $2, 1, $5, $3, $4)`,
        [id, product.id, admin.userId, at, n + 1],
      );
      await pool.query(
        `INSERT INTO inventory_line_history (id, line_id, reason, initial_before, initial_after,
           current_before, current_after, delta, actor_id, changed_at)
         VALUES ($1, $2, 'initial_adjusted', 1, $5, 1, $5, 1, $3, $4)`,
        [id, line.id, admin.userId, at, n + 1],
      );
    }
    const prices = (await get(`/products/${product.id}/price-history?limit=10`)).body.items;
    expect(prices.slice(0, 3).map((i: { newPrice: string }) => i.newPrice)).toEqual([
      '3.00',
      '2.00',
      '1.00',
    ]);
    const lines = (await get(`/inventory-lines/${line.id}/history?limit=10`)).body.items;
    expect(lines.slice(0, 3).map((i: { initialAfter: string }) => i.initialAfter)).toEqual([
      '3.000',
      '2.000',
      '1.000',
    ]);
  });
});

describe('reactivating an inventory with inactive products (CA-21)', () => {
  /** Inventory with one active line per product, then the inventory is deactivated. */
  async function inactiveInventoryWithLines(count: number) {
    const { category, inventory } = await scenario();
    const lines: { id: string; productId: string }[] = [];
    for (let i = 0; i < count; i++) {
      const product = await mkProduct(category.id);
      lines.push({ id: (await mkLine(inventory.id, product.id)).id, productId: product.id });
    }
    await setStatus('inventories', inventory.id, false);
    return { inventory, lines };
  }

  it('409 INVENTORY_HAS_INACTIVE_PRODUCTS with every affected line, without changes', async () => {
    const { inventory, lines } = await inactiveInventoryWithLines(3);
    const before = (await get(`/inventories/${inventory.id}`)).body;
    await setStatus('products', lines[0]!.productId, false);
    await setStatus('products', lines[2]!.productId, false);
    const blocked = await setStatus('inventories', inventory.id, true);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('INVENTORY_HAS_INACTIVE_PRODUCTS');
    expect(blocked.body.details).toEqual(
      [lines[0]!, lines[2]!]
        .map((l) => ({ lineId: l.id, productId: l.productId }))
        .sort((a, b) => a.lineId.localeCompare(b.lineId)),
    );
    expect((await get(`/inventories/${inventory.id}`)).body).toEqual(before);
    expect(eventNames(inventory.id)).not.toContain('inventory.activated');
  });

  it('is allowed once the products are active again or the lines are inactive; inactive lines never block', async () => {
    const { inventory, lines } = await inactiveInventoryWithLines(2);
    await setStatus('products', lines[0]!.productId, false);
    await setStatus('products', lines[1]!.productId, false);
    expect((await setStatus('inventories', inventory.id, true)).status).toBe(409);
    await setStatus('products', lines[0]!.productId, true);
    await setStatus('inventory-lines', lines[1]!.id, false);
    const ok = await setStatus('inventories', inventory.id, true);
    expect(ok.status).toBe(200);
    expect(ok.body.isActive).toBe(true);
    expect((await get(`/inventory-lines/${lines[1]!.id}`)).body.isActive).toBe(false);
  });

  it('VERSION_CONFLICT is answered before the rule; an inventory without lines activates', async () => {
    const { inventory, lines } = await inactiveInventoryWithLines(1);
    await setStatus('products', lines[0]!.productId, false);
    const stale = await setStatus('inventories', inventory.id, true, ifMatch(99));
    expect(stale.body.code).toBe('VERSION_CONFLICT');
    expect((await setStatus('inventories', ZERO, true)).status).toBe(404);
    const empty = await mkInventory(inventory.establishmentId);
    await setStatus('inventories', empty.id, false);
    expect((await setStatus('inventories', empty.id, true)).status).toBe(200);
  });

  it('inactive establishment: 409 ESTABLISHMENT_INACTIVE without changes; it wins over inactive products; reactivating the establishment allows it', async () => {
    const { inventory, lines } = await inactiveInventoryWithLines(1);
    await setStatus('products', lines[0]!.productId, false);
    await pool.query('UPDATE establishments SET is_active = false WHERE id = $1', [
      inventory.establishmentId,
    ]);
    const before = (await get(`/inventories/${inventory.id}`)).body;
    const both = await setStatus('inventories', inventory.id, true);
    expect(both.status).toBe(409);
    expect(both.body.code).toBe('ESTABLISHMENT_INACTIVE');
    expect(both.body.details).toBeUndefined();
    expect((await setStatus('inventories', inventory.id, true, ifMatch(99))).body.code).toBe(
      'VERSION_CONFLICT',
    );
    expect((await get(`/inventories/${inventory.id}`)).body).toEqual(before);
    expect(eventNames(inventory.id)).not.toContain('inventory.activated');
    await pool.query('UPDATE establishments SET is_active = true WHERE id = $1', [
      inventory.establishmentId,
    ]);
    expect((await setStatus('inventories', inventory.id, true)).body.code).toBe(
      'INVENTORY_HAS_INACTIVE_PRODUCTS',
    );
    await setStatus('products', lines[0]!.productId, true);
    expect((await setStatus('inventories', inventory.id, true)).status).toBe(200);
  });

  it('race: activating the inventory in parallel with deactivating its establishment never leaves both', async () => {
    let activated = 0;
    for (let i = 0; i < 16; i++) {
      const { inventory } = await inactiveInventoryWithLines(1);
      const [activate] = await Promise.all([
        sleep((i % 4) * 2).then(() => setStatus('inventories', inventory.id, true)),
        sleep(((i >> 1) % 4) * 2).then(() =>
          pool.query('UPDATE establishments SET is_active = false WHERE id = $1', [
            inventory.establishmentId,
          ]),
        ),
      ]);
      expect([200, 409], activate.raw).toContain(activate.status);
      if (activate.status === 200) activated++;
      else expect(activate.body.code).toBe('ESTABLISHMENT_INACTIVE');
      // activation that won saw the establishment active: it was committed before the deactivation
      const { rows } = await pool.query<{ i: boolean; e: boolean }>(
        `SELECT i.is_active AS i, e.is_active AS e FROM inventories i
         JOIN establishments e ON e.id = i.establishment_id WHERE i.id = $1`,
        [inventory.id],
      );
      expect(rows[0]!.e, `round ${i}`).toBe(false);
      expect(rows[0]!.i, `round ${i}`).toBe(activate.status === 200);
    }
    expect(activated).toBeGreaterThanOrEqual(0);
  });

  it('race: activating the inventory in parallel with deactivating a product never leaves both', async () => {
    let activated = 0;
    let deactivated = 0;
    for (let i = 0; i < 24; i++) {
      const { inventory, lines } = await inactiveInventoryWithLines(1);
      const delay = (ms: number) => sleep(ms);
      const [activate, deactivate] = await Promise.all([
        delay((i % 4) * 2).then(() => setStatus('inventories', inventory.id, true)),
        delay(((i >> 1) % 4) * 2).then(() => setStatus('products', lines[0]!.productId, false)),
      ]);
      expect([200, 409], activate.raw).toContain(activate.status);
      expect([200, 409], deactivate.raw).toContain(deactivate.status);
      // exactly one of the two wins
      expect(activate.status === 200 ? deactivate.status : 200, `round ${i}`).toBe(
        activate.status === 200 ? 409 : 200,
      );
      if (activate.status === 200) activated++;
      else {
        deactivated++;
        expect(activate.body.code).toBe('INVENTORY_HAS_INACTIVE_PRODUCTS');
      }
      const { rows } = await pool.query(
        `SELECT 1 FROM inventory_lines l JOIN inventories i ON i.id = l.inventory_id
         JOIN products p ON p.id = l.product_id
         WHERE l.inventory_id = $1 AND l.is_active AND i.is_active AND NOT p.is_active`,
        [inventory.id],
      );
      expect(rows, `round ${i}`).toHaveLength(0);
    }
    expect(activated + deactivated).toBe(24);
  });
});
