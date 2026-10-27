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
 * Integration tests (sprint 007) over HTTP against a real PostgreSQL TEST database: carts and
 * their items, totals in SQL, access rules, live scope, races and offline feeds. Users and roles
 * are inserted with SQL (identity owns those tables). Everything created here is removed at the end.
 */
const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const testDb = process.env.POSTGRES_TEST_DB ?? 'inventory_test';
const unique = () => randomBytes(4).toString('hex');
const uuid = () => crypto.randomUUID();
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

type Actor = Awaited<ReturnType<typeof actor>>;

/** Creates a role with the given permissions and an active user in it. */
async function actor(codes: readonly string[]) {
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
     VALUES ($1, 'x', 'Usuario de prueba', $2, true) RETURNING id`,
    [`cart-${unique()}@example.test`, roleId],
  );
  const userId = user.rows[0]!.id;
  userIds.push(userId);
  return { userId, roleId, token: await sign(userId) };
}

const CATALOG = [...CATEGORY_PERMISSIONS, ...PRODUCT_PERMISSIONS, ...INVENTORY_PERMISSIONS];
let builder: Actor;

const as = (
  who: Actor,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  body?: unknown,
  headers?: Record<string, string>,
) => call(method, url, { token: who.token, body, headers });
const build = (method: 'POST' | 'PATCH', url: string, body: unknown) =>
  as(builder, method, url, body);
const ifMatch = (version: number) => ({ 'If-Match': `"${version}"` });
const key = (value = uuid()) => ({ 'Idempotency-Key': value });

async function mkEstablishment(isActive = true): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO establishments (name, address, city, department, latitude, longitude, is_active)
     VALUES ($1, 'Cra 1', 'Medellín', 'Antioquia', 6.25, -75.56, $2) RETURNING id`,
    [`Sede ${unique()}`, isActive],
  );
  establishmentIds.push(rows[0]!.id);
  return rows[0]!.id;
}

async function assignTo(who: Actor, establishmentId: string): Promise<void> {
  await pool.query(
    `INSERT INTO establishment_users (establishment_id, user_id, assigned_by) VALUES ($1, $2, $2)`,
    [establishmentId, who.userId],
  );
}

/** A user with `carts.use` assigned to a new establishment. */
async function mkUser(extra: readonly string[] = []) {
  const est = await mkEstablishment();
  const who = await actor(['carts.use', ...extra]);
  await assignTo(who, est);
  return { who, est };
}

/** Product + inventory + line in the establishment (price and stock as text). */
async function mkLot(establishmentId: string, price = '10.00', stock = '10') {
  const category = await build('POST', '/categories', {
    code: `C-${unique()}`.toUpperCase(),
    name: `Categoría ${unique()}`,
  });
  const product = await build('POST', '/products', {
    sku: `SKU-${unique()}`,
    name: `Producto ${unique()}`,
    unit: 'unit',
    categoryId: category.body.id,
    price,
  });
  expect(product.status, product.raw).toBe(201);
  const inventory = await build('POST', '/inventories', {
    establishmentId,
    name: `Inventario ${unique()}`,
    startDate: '2026-01-01',
    endDate: '2026-01-31',
    origin: 'Proveedor X',
  });
  expect(inventory.status, inventory.raw).toBe(201);
  const line = await build('POST', `/inventories/${inventory.body.id}/lines`, {
    productId: product.body.id,
    barcode: `BC-${unique()}`,
    quantityInitial: stock,
    quantityAlert: '1',
  });
  expect(line.status, line.raw).toBe(201);
  return {
    productId: product.body.id as string,
    inventoryId: inventory.body.id as string,
    lineId: line.body.id as string,
  };
}

const mkCart = async (who: Actor, establishmentId: string, body: object = {}) => {
  const res = await as(who, 'POST', '/carts', { establishmentId, ...body });
  expect(res.status, res.raw).toBe(201);
  return res.body as { id: string; version: number };
};

const addItem = (
  who: Actor,
  cartId: string,
  inventoryLineId: string,
  quantity: unknown,
  extra = {},
) => as(who, 'POST', `/carts/${cartId}/items`, { inventoryLineId, quantity, ...extra });

/** Parsed JSON audit events of the given name. */
function events(name: string): Record<string, unknown>[] {
  return logs
    .filter((line) => line.includes(`"event":"${name}"`) && /^\{.*\}/.test(line))
    .map((line) => JSON.parse(/^\{.*\}/.exec(line)![0]) as Record<string, unknown>);
}

async function clean() {
  await pool.query('DELETE FROM cart_items');
  await pool.query('DELETE FROM carts');
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
});

afterAll(async () => {
  await clean();
  await app?.close();
  await pool?.end();
});

// ---------------------------------------------------------------------------------------------

describe('schema (CA-1) and permissions (CA-2)', () => {
  it('carts and cart_items have the columns, FK RESTRICT, CHECK, unique and indexes of the spec', async () => {
    const columns = async (table: string) =>
      (
        await pool.query<{ column_name: string; is_nullable: string }>(
          `SELECT column_name, is_nullable FROM information_schema.columns
           WHERE table_name = $1 ORDER BY column_name`,
          [table],
        )
      ).rows;
    const carts = await columns('carts');
    expect(carts.map((r) => r.column_name)).toEqual([
      'cancelled_at',
      'cancelled_by',
      'change_xid',
      'created_at',
      'created_by',
      'establishment_id',
      'id',
      'status',
      'updated_at',
      'version',
    ]);
    expect(
      carts
        .filter((r) => r.is_nullable === 'YES')
        .map((r) => r.column_name)
        .sort(),
    ).toEqual(['cancelled_at', 'cancelled_by']);
    const items = await columns('cart_items');
    expect(items.map((r) => r.column_name)).toEqual([
      'cart_id',
      'change_xid',
      'created_at',
      'id',
      'inventory_line_id',
      'is_active',
      'quantity',
      'updated_at',
      'version',
    ]);
    const constraints = async (table: string) =>
      (
        await pool.query<{ conname: string; def: string }>(
          `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
           WHERE conrelid = $1::regclass`,
          [table],
        )
      ).rows;
    const cartConstraints = await constraints('carts');
    const cartFks = cartConstraints.filter((r) => r.def.startsWith('FOREIGN KEY'));
    expect(cartFks).toHaveLength(1);
    expect(cartFks[0]!.def).toMatch(/\(establishment_id\) REFERENCES establishments\(id\)/);
    expect(cartFks[0]!.def).toMatch(/ON DELETE RESTRICT/);
    expect(cartConstraints.find((r) => r.conname === 'carts_status_check')?.def).toMatch(/open/);
    expect(cartConstraints.find((r) => r.conname === 'carts_cancelled_check')?.def).toMatch(
      /cancelled_at/,
    );
    const itemConstraints = await constraints('cart_items');
    const itemFks = itemConstraints.filter((r) => r.def.startsWith('FOREIGN KEY'));
    expect(itemFks.map((r) => r.def).join('\n')).toMatch(/REFERENCES carts\(id\)/);
    expect(itemFks.map((r) => r.def).join('\n')).toMatch(/REFERENCES inventory_lines\(id\)/);
    expect(itemFks.every((r) => /ON DELETE RESTRICT/.test(r.def))).toBe(true);
    expect(itemConstraints.find((r) => r.conname === 'cart_items_quantity_check')?.def).toMatch(
      /quantity > \(?0/,
    );
    expect(itemConstraints.find((r) => r.conname === 'cart_items_cart_line_key')?.def).toMatch(
      /UNIQUE \(cart_id, inventory_line_id\)/,
    );
    const indexes = async (table: string) =>
      (
        await pool.query<{ indexdef: string }>(
          'SELECT indexdef FROM pg_indexes WHERE tablename = $1',
          [table],
        )
      ).rows
        .map((r) => r.indexdef)
        .join('\n');
    const cartIndexes = await indexes('carts');
    expect(cartIndexes).toMatch(/\(created_by, status\)/);
    expect(cartIndexes).toMatch(/\(establishment_id\)/);
    expect(cartIndexes).toMatch(/\(change_xid, id\)/);
    const itemIndexes = await indexes('cart_items');
    expect(itemIndexes).toMatch(/\(cart_id\)/);
    expect(itemIndexes).toMatch(/\(inventory_line_id\)/);
    expect(itemIndexes).toMatch(/\(change_xid, id\)/);
  });

  it('the CHECKs, the unique pair and the RESTRICT FKs reject invalid rows', async () => {
    const { who, est } = await mkUser();
    const lot = await mkLot(est);
    const cart = await mkCart(who, est);
    const insertCart = (status: string, at: string | null, by: string | null) =>
      pool.query(
        `INSERT INTO carts (establishment_id, created_by, status, cancelled_at, cancelled_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [est, who.userId, status, at, by],
      );
    await expect(insertCart('other', null, null)).rejects.toMatchObject({ code: '23514' });
    await expect(insertCart('cancelled', null, null)).rejects.toMatchObject({ code: '23514' });
    await expect(insertCart('open', new Date().toISOString(), null)).rejects.toMatchObject({
      code: '23514',
    });
    await expect(
      insertCart('cancelled', new Date().toISOString(), who.userId),
    ).resolves.toBeDefined();
    const insertItem = (quantity: string) =>
      pool.query(
        `INSERT INTO cart_items (cart_id, inventory_line_id, quantity) VALUES ($1, $2, $3)`,
        [cart.id, lot.lineId, quantity],
      );
    await expect(insertItem('0')).rejects.toMatchObject({ code: '23514' });
    await insertItem('1');
    await expect(insertItem('2')).rejects.toMatchObject({ code: '23505' });
    await expect(pool.query('DELETE FROM carts WHERE id = $1', [cart.id])).rejects.toMatchObject({
      code: '23503',
    });
    await expect(
      pool.query('DELETE FROM inventory_lines WHERE id = $1', [lot.lineId]),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      pool.query('DELETE FROM establishments WHERE id = $1', [est]),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('carts.use and carts.read exist with Spanish descriptions and the Administrador holds them', async () => {
    const { rows } = await pool.query<{ code: string; description: string; assigned: boolean }>(
      `SELECT p.code, p.description,
         EXISTS (SELECT 1 FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
                 WHERE rp.permission_id = p.id AND r.is_system) AS assigned
       FROM permissions p WHERE p.code IN ('carts.use', 'carts.read') ORDER BY p.code`,
    );
    expect(rows).toEqual([
      {
        code: 'carts.read',
        description: 'Consultar carritos de otros usuarios',
        assigned: true,
      },
      { code: 'carts.use', description: 'Crear y gestionar sus carritos', assigned: true },
    ]);
  });
});

describe('create cart (CA-3)', () => {
  it('201 open with createdBy and dates; 403 outside the scope; 409 inactive; 404 unknown; 403 without carts.use', async () => {
    const { who, est } = await mkUser();
    const res = await as(who, 'POST', '/carts', { establishmentId: est });
    expect(res.status, res.raw).toBe(201);
    expect(res.body).toMatchObject({
      establishmentId: est,
      createdBy: who.userId,
      status: 'open',
      cancelledBy: null,
      cancelledAt: null,
      version: 1,
    });
    expect(Date.parse(res.body.createdAt)).not.toBeNaN();
    expect(Object.keys(res.body).sort()).toEqual([
      'cancelledAt',
      'cancelledBy',
      'createdAt',
      'createdBy',
      'establishmentId',
      'id',
      'status',
      'updatedAt',
      'version',
    ]);
    const other = await mkEstablishment();
    expect(await as(who, 'POST', '/carts', { establishmentId: other })).toMatchObject({
      status: 403,
      body: { code: 'ESTABLISHMENT_NOT_IN_SCOPE' },
    });
    const inactive = await mkEstablishment(false);
    await assignTo(who, inactive);
    expect(await as(who, 'POST', '/carts', { establishmentId: inactive })).toMatchObject({
      status: 409,
      body: { code: 'ESTABLISHMENT_INACTIVE' },
    });
    expect((await as(who, 'POST', '/carts', { establishmentId: uuid() })).status).toBe(404);
    expect((await as(who, 'POST', '/carts', { establishmentId: 'no-uuid' })).status).toBe(400);
    expect((await as(who, 'POST', '/carts', {})).status).toBe(400);
    const nobody = await actor([]);
    expect((await as(nobody, 'POST', '/carts', { establishmentId: est })).status).toBe(403);
    expect((await call('POST', '/carts', { body: { establishmentId: est } })).status).toBe(401);
  });

  it('establishments.all allows any active establishment', async () => {
    const all = await actor(['carts.use', 'establishments.all']);
    const est = await mkEstablishment();
    expect((await as(all, 'POST', '/carts', { establishmentId: est })).status).toBe(201);
  });
});

describe('add item (CA-4)', () => {
  it('201 new, 200 summed; other local, inactive line/inventory/product and stock are 409', async () => {
    const { who, est } = await mkUser();
    const lot = await mkLot(est, '10.00', '10');
    const cart = await mkCart(who, est);
    const first = await addItem(who, cart.id, lot.lineId, '3');
    expect(first.status, first.raw).toBe(201);
    expect(first.body).toMatchObject({
      cartId: cart.id,
      inventoryLineId: lot.lineId,
      quantity: '3.000',
      isActive: true,
      version: 1,
    });
    const again = await addItem(who, cart.id, lot.lineId, '2.5');
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ id: first.body.id, quantity: '5.500', version: 2 });
    const rows = await pool.query('SELECT 1 FROM cart_items WHERE cart_id = $1', [cart.id]);
    expect(rows.rowCount).toBe(1);

    // stock, including the sum: nothing changes
    const tooMuch = await addItem(who, cart.id, lot.lineId, '4.501');
    expect(tooMuch).toMatchObject({ status: 409, body: { code: 'INSUFFICIENT_STOCK' } });
    expect(tooMuch.body.details[0]).toMatchObject({
      inventoryLineId: lot.lineId,
      available: '10.000',
    });
    expect((await addItem(who, cart.id, lot.lineId, '4.5')).body.quantity).toBe('10.000');
    const alone = await mkLot(est, '1.00', '1');
    expect((await addItem(who, cart.id, alone.lineId, '1.001')).body.code).toBe(
      'INSUFFICIENT_STOCK',
    );

    // other establishment
    const otherEst = await mkEstablishment();
    const foreign = await mkLot(otherEst);
    expect(await addItem(who, cart.id, foreign.lineId, '1')).toMatchObject({
      status: 409,
      body: { code: 'CART_LINE_OTHER_ESTABLISHMENT' },
    });

    // inactive line, inventory, product
    const cases: [string, string, string][] = [
      ['INVENTORY_LINE_INACTIVE', 'inventory_lines', 'id'],
      ['INVENTORY_INACTIVE', 'inventories', 'inventory_id'],
      ['PRODUCT_INACTIVE', 'products', 'product_id'],
    ];
    for (const [code, table, column] of cases) {
      const l = await mkLot(est);
      const target =
        table === 'inventory_lines'
          ? l.lineId
          : table === 'inventories'
            ? l.inventoryId
            : l.productId;
      void column;
      await pool.query(`UPDATE ${table} SET is_active = false WHERE id = $1`, [target]);
      expect(await addItem(who, cart.id, l.lineId, '1')).toMatchObject({
        status: 409,
        body: { code },
      });
    }
    expect((await addItem(who, cart.id, uuid(), '1')).status).toBe(404);
  });

  it('400 for quantity <= 0, more than 3 decimals, JSON number, missing or malformed fields', async () => {
    const { who, est } = await mkUser();
    const lot = await mkLot(est);
    const cart = await mkCart(who, est);
    for (const quantity of ['0', '0.000', '-1', '1.2345', 'abc', '1e3', 3, null, '1\u0000']) {
      const res = await addItem(who, cart.id, lot.lineId, quantity);
      expect(res.status, `quantity ${String(quantity)}: ${res.raw}`).toBe(400);
    }
    expect((await as(who, 'POST', `/carts/${cart.id}/items`, { quantity: '1' })).status).toBe(400);
    expect((await addItem(who, cart.id, 'no-uuid', '1')).status).toBe(400);
    expect((await addItem(who, 'no-uuid', lot.lineId, '1')).status).toBe(400);
    // 400 comes before 404 and 403
    expect((await addItem(who, uuid(), lot.lineId, '0')).status).toBe(400);
  });
});

describe('change and remove items (CA-5, CA-6)', () => {
  it('PATCH sets the quantity; status false removes, true reactivates with validation; POST reactivates', async () => {
    const { who, est } = await mkUser();
    const lot = await mkLot(est, '10.00', '10');
    const cart = await mkCart(who, est);
    const item = (await addItem(who, cart.id, lot.lineId, '5')).body;
    const set = await as(who, 'PATCH', `/cart-items/${item.id}`, { quantity: '2' });
    expect(set.status, set.raw).toBe(200);
    expect(set.body).toMatchObject({ quantity: '2.000', version: 2 });
    expect(
      (await as(who, 'PATCH', `/cart-items/${item.id}`, { quantity: '10.001' })).body.code,
    ).toBe('INSUFFICIENT_STOCK');
    for (const quantity of ['0', '-1', '1.2345', 2, undefined]) {
      expect((await as(who, 'PATCH', `/cart-items/${item.id}`, { quantity })).status).toBe(400);
    }
    expect((await as(who, 'PATCH', `/cart-items/${item.id}`, { quantity: '10' })).status).toBe(200);

    const removed = await as(who, 'PATCH', `/cart-items/${item.id}/status`, { isActive: false });
    expect(removed.body).toMatchObject({ isActive: false, version: 4 });
    let detail = await as(who, 'GET', `/carts/${cart.id}`);
    expect(detail.body.items).toEqual([]);
    expect(detail.body.total).toBe('0.00');
    // removing again is idempotent
    const again = await as(who, 'PATCH', `/cart-items/${item.id}/status`, { isActive: false });
    expect(again.body.version).toBe(4);
    // reactivating validates the stock
    await pool.query('UPDATE inventory_lines SET quantity_current = 3 WHERE id = $1', [lot.lineId]);
    expect(
      (await as(who, 'PATCH', `/cart-items/${item.id}/status`, { isActive: true })).body.code,
    ).toBe('INSUFFICIENT_STOCK');
    await pool.query('UPDATE inventory_lines SET quantity_current = 10 WHERE id = $1', [
      lot.lineId,
    ]);
    const back = await as(who, 'PATCH', `/cart-items/${item.id}/status`, { isActive: true });
    expect(back.body).toMatchObject({ isActive: true, quantity: '10.000' });

    // adding the line of a removed item reactivates it with the NEW quantity
    await as(who, 'PATCH', `/cart-items/${item.id}/status`, { isActive: false });
    const reactivated = await addItem(who, cart.id, lot.lineId, '1.5');
    expect(reactivated.status).toBe(200);
    expect(reactivated.body).toMatchObject({ id: item.id, isActive: true, quantity: '1.500' });
    detail = await as(who, 'GET', `/carts/${cart.id}`);
    expect(detail.body.items).toHaveLength(1);
    expect((await as(who, 'PATCH', `/cart-items/${uuid()}`, { quantity: '1' })).body.code).toBe(
      'CART_ITEM_NOT_FOUND',
    );
  });

  it('CA-6: no reservation, two carts can hold the whole stock and quantity_current does not move', async () => {
    const a = await mkUser();
    const lot = await mkLot(a.est, '1.00', '10');
    const b = await actor(['carts.use']);
    await assignTo(b, a.est);
    const cartA = await mkCart(a.who, a.est);
    const cartB = await mkCart(b, a.est);
    expect((await addItem(a.who, cartA.id, lot.lineId, '10')).status).toBe(201);
    expect((await addItem(b, cartB.id, lot.lineId, '10')).status).toBe(201);
    const { rows } = await pool.query<{ quantity_current: string }>(
      'SELECT quantity_current::text FROM inventory_lines WHERE id = $1',
      [lot.lineId],
    );
    expect(rows[0]!.quantity_current).toBe('10.000');
  });
});

describe('detail and totals in SQL (CA-7)', () => {
  it('subtotal is round(quantity x price, 2) half-up; total sums only the available items; texts only', async () => {
    const { who, est } = await mkUser();
    const cart = await mkCart(who, est);
    const make = async (price: string, quantity: string) => {
      const lot = await mkLot(est, price, '100');
      const item = await addItem(who, cart.id, lot.lineId, quantity);
      expect(item.status, item.raw).toBe(201);
      return { lot, item: item.body };
    };
    const a = await make('0.10', '0.333'); // 0.0333 -> 0.03
    const b = await make('0.01', '0.5'); // 0.005 -> 0.01 (half-up)
    const c = await make('0.10', '3'); // 0.30
    const d = await make('0.01', '1.5'); // 0.015 -> 0.02
    const e = await make('12500.50', '2'); // 25001.00
    const detail = await as(who, 'GET', `/carts/${cart.id}`);
    expect(detail.status, detail.raw).toBe(200);
    const bySku = (lineId: string) =>
      detail.body.items.find((i: { line: { id: string } }) => i.line.id === lineId);
    expect(bySku(a.lot.lineId).subtotal).toBe('0.03');
    expect(bySku(b.lot.lineId).subtotal).toBe('0.01');
    expect(bySku(c.lot.lineId).subtotal).toBe('0.30');
    expect(bySku(d.lot.lineId).subtotal).toBe('0.02');
    expect(bySku(e.lot.lineId).subtotal).toBe('25001.00');
    expect(detail.body.total).toBe('25001.36');
    expect(detail.body.unavailableCount).toBe(0);
    const first = bySku(a.lot.lineId);
    expect(first).toMatchObject({
      id: a.item.id,
      version: 1,
      quantity: '0.333',
      available: true,
      unavailableReason: null,
      product: { id: a.lot.productId, unit: 'unit', price: '0.10' },
      line: { id: a.lot.lineId, expiresOn: null, quantityCurrent: '100.000' },
    });
    expect(detail.body).toMatchObject({ id: cart.id, status: 'open', createdBy: who.userId });
    expect(detail.raw).not.toMatch(/"(subtotal|total|price|quantity)":\s*[0-9]/);
  });

  it('DEF-2: totals of 10^12 or more are exact (200, no numeric overflow)', async () => {
    const { who, est } = await mkUser();
    const totalOf = async (lines: [string, string][]) => {
      const cart = await mkCart(who, est);
      for (const [price, quantity] of lines) {
        const lot = await mkLot(est, price, '1000');
        const item = await addItem(who, cart.id, lot.lineId, quantity);
        expect(item.status, item.raw).toBe(201);
      }
      const detail = await as(who, 'GET', `/carts/${cart.id}`);
      expect(detail.status, detail.raw).toBe(200);
      return detail.body.total as string;
    };
    expect(await totalOf([['999999999999.99', '2']])).toBe('1999999999999.98');
    expect(await totalOf([['1000000000.00', '1000']])).toBe('1000000000000.00');
  });

  it('a cart without items has total 0.00', async () => {
    const { who, est } = await mkUser();
    const cart = await mkCart(who, est);
    const detail = await as(who, 'GET', `/carts/${cart.id}`);
    expect(detail.body).toMatchObject({ items: [], total: '0.00', unavailableCount: 0 });
  });
});

describe('later validity of the lot (CA-8)', () => {
  it('unavailable items show the reason, do not add to the total and cannot be increased', async () => {
    const { who, est } = await mkUser();
    const cart = await mkCart(who, est);
    const mk = async () => {
      const lot = await mkLot(est, '2.00', '10');
      const item = (await addItem(who, cart.id, lot.lineId, '4')).body;
      return { lot, item };
    };
    const ok = await mk();
    const line = await mk();
    const inventory = await mk();
    const product = await mk();
    const stock = await mk();
    await pool.query('UPDATE inventory_lines SET is_active = false WHERE id = $1', [
      line.lot.lineId,
    ]);
    await pool.query('UPDATE inventories SET is_active = false WHERE id = $1', [
      inventory.lot.inventoryId,
    ]);
    await pool.query('UPDATE products SET is_active = false WHERE id = $1', [
      product.lot.productId,
    ]);
    await pool.query('UPDATE inventory_lines SET quantity_current = 3 WHERE id = $1', [
      stock.lot.lineId,
    ]);
    const detail = await as(who, 'GET', `/carts/${cart.id}`);
    const reason = (item: { id: string }) =>
      detail.body.items.find((i: { id: string }) => i.id === item.id);
    expect(reason(ok.item)).toMatchObject({ available: true, unavailableReason: null });
    expect(reason(line.item)).toMatchObject({
      available: false,
      unavailableReason: 'LINE_INACTIVE',
    });
    expect(reason(inventory.item)).toMatchObject({
      available: false,
      unavailableReason: 'INVENTORY_INACTIVE',
    });
    expect(reason(product.item)).toMatchObject({
      available: false,
      unavailableReason: 'PRODUCT_INACTIVE',
    });
    expect(reason(stock.item)).toMatchObject({
      available: false,
      unavailableReason: 'INSUFFICIENT_STOCK',
    });
    expect(detail.body.total).toBe('8.00');
    expect(detail.body.unavailableCount).toBe(4);
    // cannot be increased (409 with the reason)
    const patch = (id: string, quantity: string) =>
      as(who, 'PATCH', `/cart-items/${id}`, { quantity });
    expect((await patch(line.item.id, '5')).body.code).toBe('INVENTORY_LINE_INACTIVE');
    expect((await patch(inventory.item.id, '5')).body.code).toBe('INVENTORY_INACTIVE');
    expect((await patch(product.item.id, '5')).body.code).toBe('PRODUCT_INACTIVE');
    expect((await patch(stock.item.id, '5')).body.code).toBe('INSUFFICIENT_STOCK');
    expect((await addItem(who, cart.id, stock.lot.lineId, '1')).body.code).toBe(
      'INSUFFICIENT_STOCK',
    );
    // R-8: lowering or keeping the quantity is allowed whatever the reason; only raising is rejected
    for (const unavailable of [line, inventory, product, stock]) {
      expect((await patch(unavailable.item.id, '4')).status).toBe(200);
      const lowered = await patch(unavailable.item.id, '3');
      expect(lowered.status, lowered.raw).toBe(200);
      expect(lowered.body.quantity).toBe('3.000');
      expect((await patch(unavailable.item.id, '3')).status).toBe(200);
      expect((await patch(unavailable.item.id, '3.001')).status).toBe(409);
    }
    // lowering within the stock is allowed and makes it available again
    expect((await patch(stock.item.id, '3')).status).toBe(200);
    // removing an unavailable item is always allowed
    const removed = await as(who, 'PATCH', `/cart-items/${line.item.id}/status`, {
      isActive: false,
    });
    expect(removed.status).toBe(200);
  });

  it('H-4: with active items but none available the total is "0.00" and subtotals keep 2 decimals', async () => {
    const { who, est } = await mkUser();
    const cart = await mkCart(who, est);
    const first = await mkLot(est, '2.50', '10');
    const second = await mkLot(est, '3', '10');
    await addItem(who, cart.id, first.lineId, '2');
    await addItem(who, cart.id, second.lineId, '1');
    await pool.query('UPDATE inventory_lines SET is_active = false WHERE id = ANY($1)', [
      [first.lineId, second.lineId],
    ]);
    const detail = await as(who, 'GET', `/carts/${cart.id}`);
    expect(detail.body.total).toBe('0.00');
    expect(detail.body.unavailableCount).toBe(2);
    expect(detail.body.items.map((i: { subtotal: string }) => i.subtotal).sort()).toEqual([
      '3.00',
      '5.00',
    ]);
    expect(detail.raw).toContain('"total":"0.00"');
  });
});

describe('access to carts of other users (CA-9)', () => {
  it('404 without carts.read + establishments.all; read-only GET and 403 CART_READ_ONLY with both', async () => {
    const owner = await mkUser();
    const lot = await mkLot(owner.est);
    const cart = await mkCart(owner.who, owner.est);
    const item = (await addItem(owner.who, cart.id, lot.lineId, '1')).body;

    const stranger = (await mkUser()).who;
    const onlyRead = await actor(['carts.use', 'carts.read']);
    const onlyAll = await actor(['carts.use', 'establishments.all']);
    for (const who of [stranger, onlyRead, onlyAll]) {
      expect(await as(who, 'GET', `/carts/${cart.id}`)).toMatchObject({
        status: 404,
        body: { code: 'CART_NOT_FOUND' },
      });
      expect(
        await as(who, 'PATCH', `/carts/${cart.id}/status`, { status: 'cancelled' }),
      ).toMatchObject({ status: 404, body: { code: 'CART_NOT_FOUND' } });
      expect(await addItem(who, cart.id, lot.lineId, '1')).toMatchObject({
        status: 404,
        body: { code: 'CART_NOT_FOUND' },
      });
      expect(await as(who, 'PATCH', `/cart-items/${item.id}`, { quantity: '2' })).toMatchObject({
        status: 404,
        body: { code: 'CART_ITEM_NOT_FOUND' },
      });
      expect(
        await as(who, 'PATCH', `/cart-items/${item.id}/status`, { isActive: false }),
      ).toMatchObject({ status: 404, body: { code: 'CART_ITEM_NOT_FOUND' } });
    }
    expect((await as(stranger, 'GET', `/carts?userId=${owner.who.userId}`)).status).toBe(403);
    expect((await as(onlyRead, 'GET', `/carts?userId=${owner.who.userId}`)).status).toBe(403);
    expect((await as(onlyAll, 'GET', `/carts?userId=${owner.who.userId}`)).status).toBe(403);

    const auditor = await actor(['carts.read', 'establishments.all']);
    const full = await actor(['carts.use', 'carts.read', 'establishments.all']);
    for (const who of [auditor, full]) {
      const detail = await as(who, 'GET', `/carts/${cart.id}`);
      expect(detail.status, detail.raw).toBe(200);
      expect(detail.body.items).toHaveLength(1);
      const readOnly = { status: 403, body: { code: 'CART_READ_ONLY' } };
      expect(
        await as(who, 'PATCH', `/carts/${cart.id}/status`, { status: 'cancelled' }),
      ).toMatchObject(readOnly);
      expect(await addItem(who, cart.id, lot.lineId, '1')).toMatchObject(readOnly);
      expect(await as(who, 'PATCH', `/cart-items/${item.id}`, { quantity: '2' })).toMatchObject(
        readOnly,
      );
      expect(
        await as(who, 'PATCH', `/cart-items/${item.id}/status`, { isActive: false }),
      ).toMatchObject(readOnly);
      const list = await as(who, 'GET', `/carts?userId=${owner.who.userId}`);
      expect(list.status, list.raw).toBe(200);
      expect(list.body.items.map((c: { id: string }) => c.id)).toContain(cart.id);
    }
    // the cart did not change
    const row = await pool.query('SELECT status, version FROM carts WHERE id = $1', [cart.id]);
    expect(row.rows[0]).toMatchObject({ status: 'open', version: 2 });
    // a reader who is not the owner cannot list without a filter either: own list is empty
    const own = await as(full, 'GET', '/carts');
    expect(own.body.total).toBe(0);
    expect((await as(auditor, 'GET', '/carts')).status).toBe(403);
  });

  it('GET /carts lists only own carts with status and establishment filters, paginated', async () => {
    const a = await mkUser();
    const b = await mkUser();
    const open = await mkCart(a.who, a.est);
    const cancelled = await mkCart(a.who, a.est);
    await as(a.who, 'PATCH', `/carts/${cancelled.id}/status`, { status: 'cancelled' });
    await mkCart(b.who, b.est);
    const all = await as(a.who, 'GET', '/carts');
    expect(all.body.total).toBe(2);
    expect(all.body).toMatchObject({ limit: 50, offset: 0 });
    expect(
      (await as(a.who, 'GET', '/carts?status=open')).body.items.map((c: { id: string }) => c.id),
    ).toEqual([open.id]);
    expect((await as(a.who, 'GET', '/carts?status=cancelled')).body.total).toBe(1);
    expect((await as(a.who, 'GET', `/carts?establishmentId=${b.est}`)).body.total).toBe(0);
    expect((await as(a.who, 'GET', '/carts?limit=1&offset=1')).body.items).toHaveLength(1);
    expect((await as(a.who, 'GET', '/carts?status=bad')).status).toBe(400);
    expect((await as(a.who, 'GET', '/carts?userId=bad')).status).toBe(400);
    const nobody = await actor([]);
    expect((await as(nobody, 'GET', '/carts')).status).toBe(403);
    expect((await as(nobody, 'GET', `/carts/${open.id}`)).status).toBe(404);
  });
});

describe('live scope (CA-10)', () => {
  it('losing the establishment or its deactivation blocks writes with the same token', async () => {
    const { who, est } = await mkUser();
    const lot = await mkLot(est);
    const cart = await mkCart(who, est);
    const item = (await addItem(who, cart.id, lot.lineId, '1')).body;
    await pool.query(
      `UPDATE establishment_users SET removed_at = now(), removed_by = user_id
       WHERE establishment_id = $1 AND user_id = $2`,
      [est, who.userId],
    );
    const lost = { status: 403, body: { code: 'ESTABLISHMENT_NOT_IN_SCOPE' } };
    expect(await addItem(who, cart.id, lot.lineId, '1')).toMatchObject(lost);
    expect(await as(who, 'PATCH', `/cart-items/${item.id}`, { quantity: '2' })).toMatchObject(lost);
    expect(
      await as(who, 'PATCH', `/cart-items/${item.id}/status`, { isActive: false }),
    ).toMatchObject(lost);
    expect(
      await as(who, 'PATCH', `/carts/${cart.id}/status`, { status: 'cancelled' }),
    ).toMatchObject(lost);
    // reading the own cart does not depend on the scope
    expect((await as(who, 'GET', `/carts/${cart.id}`)).status).toBe(200);
    await assignTo(who, est);
    expect((await addItem(who, cart.id, lot.lineId, '1')).status).toBe(200);
    await pool.query('UPDATE establishments SET is_active = false WHERE id = $1', [est]);
    const inactive = { status: 409, body: { code: 'ESTABLISHMENT_INACTIVE' } };
    expect(await addItem(who, cart.id, lot.lineId, '1')).toMatchObject(inactive);
    expect(await as(who, 'PATCH', `/cart-items/${item.id}`, { quantity: '2' })).toMatchObject(
      inactive,
    );
  });
});

describe('owner without carts.use', () => {
  it('writes are 403 FORBIDDEN, not a reader error', async () => {
    const { who, est } = await mkUser();
    const lot = await mkLot(est);
    const cart = await mkCart(who, est);
    const item = (await addItem(who, cart.id, lot.lineId, '1')).body;
    await pool.query(
      `DELETE FROM role_permissions WHERE role_id = $1
       AND permission_id = (SELECT id FROM permissions WHERE code = 'carts.use')`,
      [who.roleId],
    );
    expect((await addItem(who, cart.id, lot.lineId, '1')).status).toBe(403);
    expect((await as(who, 'PATCH', `/cart-items/${item.id}`, { quantity: '2' })).status).toBe(403);
    expect(
      (await as(who, 'PATCH', `/carts/${cart.id}/status`, { status: 'cancelled' })).status,
    ).toBe(403);
    expect((await as(who, 'GET', `/carts/${cart.id}`)).status).toBe(403);
  });
});

describe('owner who only reads (R-1)', () => {
  it('carts.read + establishments.all without carts.use reads the own cart but cannot write', async () => {
    const { who, est } = await mkUser();
    const lot = await mkLot(est);
    const cart = await mkCart(who, est);
    const item = (await addItem(who, cart.id, lot.lineId, '1')).body;
    await pool.query(
      `INSERT INTO role_permissions (role_id, permission_id)
       SELECT $1, id FROM permissions WHERE code IN ('carts.read', 'establishments.all')`,
      [who.roleId],
    );
    await pool.query(
      `DELETE FROM role_permissions WHERE role_id = $1
       AND permission_id = (SELECT id FROM permissions WHERE code = 'carts.use')`,
      [who.roleId],
    );
    const detail = await as(who, 'GET', `/carts/${cart.id}`);
    expect(detail.status, detail.raw).toBe(200);
    expect(detail.body.items).toHaveLength(1);
    const forbidden = { status: 403, body: { code: 'FORBIDDEN' } };
    expect(await addItem(who, cart.id, lot.lineId, '1')).toMatchObject(forbidden);
    expect(await as(who, 'PATCH', `/cart-items/${item.id}`, { quantity: '2' })).toMatchObject(
      forbidden,
    );
    expect(
      await as(who, 'PATCH', `/cart-items/${item.id}/status`, { isActive: false }),
    ).toMatchObject(forbidden);
    expect(
      await as(who, 'PATCH', `/carts/${cart.id}/status`, { status: 'cancelled' }),
    ).toMatchObject(forbidden);
  });
});

describe('replay of an Idempotency-Key goes through the live authorization (DEF-1)', () => {
  /** Performs the idempotent cart writes once with keys, so that their replays are stored. */
  async function stored() {
    const { who, est } = await mkUser();
    const lot = await mkLot(est, '10.00', '10');
    const cart = await mkCart(who, est);
    const item = (await addItem(who, cart.id, lot.lineId, '1')).body;
    const keys = { add: uuid(), upd: uuid(), st: uuid(), cancel: uuid() };
    const calls: Record<string, () => Promise<Res>> = {
      add: () =>
        as(
          who,
          'POST',
          `/carts/${cart.id}/items`,
          { inventoryLineId: lot.lineId, quantity: '1' },
          key(keys.add),
        ),
      upd: () => as(who, 'PATCH', `/cart-items/${item.id}`, { quantity: '2' }, key(keys.upd)),
      st: () =>
        as(who, 'PATCH', `/cart-items/${item.id}/status`, { isActive: false }, key(keys.st)),
      cancel: () =>
        as(who, 'PATCH', `/carts/${cart.id}/status`, { status: 'cancelled' }, key(keys.cancel)),
    };
    // in this order all of them succeed once (the cart is cancelled last)
    for (const [name, call] of Object.entries(calls)) {
      const res = await call();
      expect(res.status, `${name}: ${res.raw}`).toBe(200);
    }
    return { who, est, calls };
  }

  const replays = async (calls: Record<string, () => Promise<Res>>) => {
    const out: Record<string, Res> = {};
    for (const [name, call] of Object.entries(calls)) out[name] = await call();
    return out;
  };

  it('replays are answered with the stored response while the authorization holds', async () => {
    const { calls } = await stored();
    const again = await replays(calls);
    for (const res of Object.values(again)) expect(res.status, res.raw).toBeLessThan(300);
  });

  it('a replay after losing carts.use is 403 FORBIDDEN, not the stored response', async () => {
    const { who, calls } = await stored();
    await pool.query(
      `DELETE FROM role_permissions WHERE role_id = $1
       AND permission_id = (SELECT id FROM permissions WHERE code = 'carts.use')`,
      [who.roleId],
    );
    for (const [name, res] of Object.entries(await replays(calls))) {
      expect(res, name).toMatchObject({ status: 403, body: { code: 'FORBIDDEN' } });
    }
  });

  it('a replay after losing the assignment is 403 ESTABLISHMENT_NOT_IN_SCOPE', async () => {
    const { who, est, calls } = await stored();
    await pool.query(
      `UPDATE establishment_users SET removed_at = now(), removed_by = user_id
       WHERE establishment_id = $1 AND user_id = $2`,
      [est, who.userId],
    );
    for (const [name, res] of Object.entries(await replays(calls))) {
      expect(res, name).toMatchObject({
        status: 403,
        body: { code: 'ESTABLISHMENT_NOT_IN_SCOPE' },
      });
    }
    // regaining the assignment gives the stored responses back
    await assignTo(who, est);
    for (const res of Object.values(await replays(calls))) expect(res.status).toBeLessThan(300);
  });

  it('a replay with the establishment inactive is 409 ESTABLISHMENT_INACTIVE', async () => {
    const { est, calls } = await stored();
    await pool.query('UPDATE establishments SET is_active = false WHERE id = $1', [est]);
    for (const [name, res] of Object.entries(await replays(calls))) {
      expect(res, name).toMatchObject({ status: 409, body: { code: 'ESTABLISHMENT_INACTIVE' } });
    }
  });

  it('a replay whose cart no longer exists is 404, as a new request', async () => {
    const { est, calls } = await stored();
    await pool.query('DELETE FROM cart_items');
    await pool.query('DELETE FROM carts WHERE establishment_id = $1', [est]);
    const res = await replays(calls);
    expect(res.add).toMatchObject({ status: 404, body: { code: 'CART_NOT_FOUND' } });
    expect(res.upd).toMatchObject({ status: 404, body: { code: 'CART_ITEM_NOT_FOUND' } });
    expect(res.cancel).toMatchObject({ status: 404, body: { code: 'CART_NOT_FOUND' } });
  });
});

describe('cancel (CA-11)', () => {
  it('cancels once, repeats answer the same state and item writes are CART_NOT_OPEN', async () => {
    const { who, est } = await mkUser();
    const lot = await mkLot(est);
    const cart = await mkCart(who, est);
    const item = (await addItem(who, cart.id, lot.lineId, '1')).body;
    const res = await as(who, 'PATCH', `/carts/${cart.id}/status`, { status: 'cancelled' });
    expect(res.status, res.raw).toBe(200);
    expect(res.body).toMatchObject({ status: 'cancelled', cancelledBy: who.userId, version: 3 });
    expect(Date.parse(res.body.cancelledAt)).not.toBeNaN();
    const again = await as(who, 'PATCH', `/carts/${cart.id}/status`, { status: 'cancelled' });
    expect(again.status).toBe(200);
    expect(again.body).toEqual(res.body);
    expect(events('cart.cancelled').filter((e) => e.cartId === cart.id)).toHaveLength(1);
    const notOpen = { status: 409, body: { code: 'CART_NOT_OPEN' } };
    expect(await addItem(who, cart.id, lot.lineId, '1')).toMatchObject(notOpen);
    expect(await as(who, 'PATCH', `/cart-items/${item.id}`, { quantity: '2' })).toMatchObject(
      notOpen,
    );
    expect(
      await as(who, 'PATCH', `/cart-items/${item.id}/status`, { isActive: false }),
    ).toMatchObject(notOpen);
    // the cancelled cart is still readable
    expect((await as(who, 'GET', `/carts/${cart.id}`)).body.status).toBe('cancelled');
    for (const body of [{}, { status: 'open' }, { status: 'x' }]) {
      expect((await as(who, 'PATCH', `/carts/${cart.id}/status`, body)).status).toBe(400);
    }
  });
});

describe('races (CA-12)', () => {
  it('two simultaneous adds of the same line give one item with the exact sum, never above the stock', async () => {
    const { who, est } = await mkUser();
    for (let round = 0; round < 5; round++) {
      const lot = await mkLot(est, '1.00', '10');
      const cart = await mkCart(who, est);
      const [x, y] = await Promise.all([
        addItem(who, cart.id, lot.lineId, '4'),
        addItem(who, cart.id, lot.lineId, '4'),
      ]);
      expect([x.status, y.status].sort(), `${x.raw} ${y.raw}`).toEqual([200, 201]);
      const [z, w] = await Promise.all([
        addItem(who, cart.id, lot.lineId, '2'),
        addItem(who, cart.id, lot.lineId, '2'),
      ]);
      // 8 + 2 = 10 fits, + 2 more does not
      expect([z.status, w.status].sort(), `${z.raw} ${w.raw}`).toEqual([200, 409]);
      const { rows } = await pool.query<{ quantity: string }>(
        'SELECT quantity::text FROM cart_items WHERE cart_id = $1',
        [cart.id],
      );
      expect(rows).toEqual([{ quantity: '10.000' }]);
    }
  });

  it('adding while cancelling never leaves an item in a cancelled cart out of order, nor a 500', async () => {
    const { who, est } = await mkUser();
    for (let round = 0; round < 8; round++) {
      const lot = await mkLot(est, '1.00', '10');
      const cart = await mkCart(who, est);
      const [add, cancel] = await Promise.all([
        addItem(who, cart.id, lot.lineId, '1'),
        as(who, 'PATCH', `/carts/${cart.id}/status`, { status: 'cancelled' }),
      ]);
      expect(cancel.status, cancel.raw).toBe(200);
      expect([201, 409]).toContain(add.status);
      if (add.status === 409) expect(add.body.code).toBe('CART_NOT_OPEN');
      const { rows } = await pool.query('SELECT 1 FROM cart_items WHERE cart_id = $1', [cart.id]);
      expect(rows.length).toBe(add.status === 201 ? 1 : 0);
      // after the cancellation nothing can be added
      expect((await addItem(who, cart.id, lot.lineId, '1')).status).toBe(409);
    }
  });

  it('simultaneous item edits and removals answer 200/409 and never 500', async () => {
    const { who, est } = await mkUser();
    const lot = await mkLot(est, '1.00', '10');
    const cart = await mkCart(who, est);
    const item = (await addItem(who, cart.id, lot.lineId, '1')).body;
    const results = await Promise.all([
      as(who, 'PATCH', `/cart-items/${item.id}`, { quantity: '3' }),
      as(who, 'PATCH', `/cart-items/${item.id}`, { quantity: '4' }),
      as(who, 'PATCH', `/cart-items/${item.id}/status`, { isActive: false }),
      as(who, 'PATCH', `/carts/${cart.id}/status`, { status: 'cancelled' }),
    ]);
    for (const r of results) expect([200, 409], r.raw).toContain(r.status);
  });
});

describe('offline protocol (CA-13)', () => {
  it('client ids, duplicates, Idempotency-Key, If-Match and versions', async () => {
    const { who, est } = await mkUser();
    const lot = await mkLot(est, '1.00', '10');
    const cartId = uuid();
    const created = await as(who, 'POST', '/carts', {
      id: cartId.toUpperCase(),
      establishmentId: est,
    });
    expect(created.status, created.raw).toBe(201);
    expect(created.body.id).toBe(cartId);
    expect(await as(who, 'POST', '/carts', { id: cartId, establishmentId: est })).toMatchObject({
      status: 409,
      body: { code: 'CART_ID_TAKEN' },
    });

    const itemId = uuid();
    const added = await addItem(who, cartId, lot.lineId, '2', { id: itemId });
    expect(added.status).toBe(201);
    expect(added.body.id).toBe(itemId);
    // the same client id again: taken, even if it points at the same line
    expect(await addItem(who, cartId, lot.lineId, '1', { id: itemId })).toMatchObject({
      status: 409,
      body: { code: 'CART_ITEM_ID_TAKEN' },
    });
    const other = await mkCart(who, est);
    const otherLot = await mkLot(est);
    expect(await addItem(who, other.id, otherLot.lineId, '1', { id: itemId })).toMatchObject({
      status: 409,
      body: { code: 'CART_ITEM_ID_TAKEN' },
    });

    // the cart changes version when its items change
    expect(
      (await pool.query('SELECT version FROM carts WHERE id = $1', [cartId])).rows[0].version,
    ).toBe(2);

    // Idempotency-Key: a replay answers the same and does not add twice
    const k = key();
    const body = { inventoryLineId: otherLot.lineId, quantity: '3' };
    const first = await as(who, 'POST', `/carts/${cartId}/items`, body, k);
    const replay = await as(who, 'POST', `/carts/${cartId}/items`, body, k);
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);
    expect(first.body.quantity).toBe('3.000');
    expect(
      events('cart_item.added').filter((e) => e.cartId === cartId && e.itemId === first.body.id),
    ).toHaveLength(1);
    expect(
      (await as(who, 'POST', `/carts/${cartId}/items`, { ...body, quantity: '4' }, k)).body.code,
    ).toBe('IDEMPOTENCY_KEY_REUSED');

    // If-Match: stale -> VERSION_CONFLICT with the public copy; fresh -> version +1
    const stale = await as(who, 'PATCH', `/cart-items/${itemId}`, { quantity: '5' }, ifMatch(9));
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('VERSION_CONFLICT');
    expect(stale.body.current).toMatchObject({ id: itemId, cartId, quantity: '2.000', version: 1 });
    expect(Object.keys(stale.body.current).sort()).toEqual([
      'cartId',
      'createdAt',
      'id',
      'inventoryLineId',
      'isActive',
      'quantity',
      'updatedAt',
      'version',
    ]);
    const fresh = await as(who, 'PATCH', `/cart-items/${itemId}`, { quantity: '5' }, ifMatch(1));
    expect(fresh.body).toMatchObject({ quantity: '5.000', version: 2 });
    // unchanged values are not an effective write
    const noop = await as(who, 'PATCH', `/cart-items/${itemId}`, { quantity: '5' });
    expect(noop.body.version).toBe(2);
    const cartStale = await as(
      who,
      'PATCH',
      `/carts/${cartId}/status`,
      { status: 'cancelled' },
      ifMatch(1),
    );
    expect(cartStale).toMatchObject({ status: 409, body: { code: 'VERSION_CONFLICT' } });
    expect(cartStale.body.current).toMatchObject({ id: cartId, status: 'open' });
    expect(
      (await as(who, 'PATCH', `/cart-items/${itemId}`, { quantity: '5' }, { 'If-Match': 'abc' }))
        .status,
    ).toBe(400);
    expect(
      (
        await as(
          who,
          'PATCH',
          `/cart-items/${itemId}/status`,
          { isActive: false },
          { 'Idempotency-Key': 'x' },
        )
      ).status,
    ).toBe(400);
    const cancel = await as(
      who,
      'PATCH',
      `/carts/${cartId}/status`,
      { status: 'cancelled' },
      ifMatch(cartStale.body.current.version),
    );
    expect(cancel.body.status).toBe('cancelled');
  });
});

describe('feeds (CA-14)', () => {
  const FEED_WAIT_MS = 60_000;
  const FEED_TEST_TIMEOUT_MS = 90_000;

  async function eventually<T>(what: string, read: () => Promise<T>, ready: (v: T) => boolean) {
    const deadline = Date.now() + FEED_WAIT_MS;
    for (;;) {
      const value = await read();
      if (ready(value)) return value;
      if (Date.now() >= deadline) {
        throw new Error(`the feed did not show ${what} within ${FEED_WAIT_MS / 1000} s (ADR-0002)`);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  async function drain(who: Actor, path: string, cursor?: string, limit = 2) {
    const items: { id: string }[] = [];
    let next = cursor;
    for (let guard = 0; guard < 1000; guard++) {
      const res = await as(
        who,
        'GET',
        `/${path}/changes?limit=${limit}${next ? `&cursor=${next}` : ''}`,
      );
      expect(res.status, res.raw).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(['hasMore', 'items', 'nextCursor']);
      items.push(...res.body.items);
      next = res.body.nextCursor ?? undefined;
      if (!res.body.hasMore) return { items, cursor: next };
    }
    throw new Error('feed does not terminate');
  }

  it(
    'carts and items: only the actor data, complete, incremental, no repeats; foreign users get nothing',
    async () => {
      const mine = await mkUser();
      const theirs = await mkUser();
      const reader = await actor(['carts.use', 'carts.read', 'establishments.all']);
      const lot = await mkLot(mine.est);
      const otherLot = await mkLot(theirs.est);
      const cartIds: string[] = [];
      const itemIds: string[] = [];
      for (let i = 0; i < 3; i++) {
        const cart = await mkCart(mine.who, mine.est);
        cartIds.push(cart.id);
        itemIds.push((await addItem(mine.who, cart.id, lot.lineId, '1')).body.id);
      }
      const foreignCart = await mkCart(theirs.who, theirs.est);
      const foreignItem = (await addItem(theirs.who, foreignCart.id, otherLot.lineId, '1')).body;

      const full = await eventually(
        'every cart of the actor',
        () => drain(mine.who, 'carts'),
        (r) => cartIds.every((id) => r.items.some((i) => i.id === id)),
      );
      const ids = full.items.map((i) => i.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect([...ids].sort()).toEqual([...cartIds].sort());
      const items = await eventually(
        'every item of the actor',
        () => drain(mine.who, 'cart-items'),
        (r) => itemIds.every((id) => r.items.some((i) => i.id === id)),
      );
      expect(items.items.map((i) => i.id).sort()).toEqual([...itemIds].sort());
      expect(items.items.map((i) => i.id)).not.toContain(foreignItem.id);

      // other users see only their own data
      const theirCarts = await eventually(
        'the cart of the other user',
        () => drain(theirs.who, 'carts'),
        (r) => r.items.some((i) => i.id === foreignCart.id),
      );
      expect(theirCarts.items.map((i) => i.id)).toEqual([foreignCart.id]);
      expect((await drain(reader, 'carts')).items).toEqual([]);
      expect((await drain(reader, 'cart-items')).items).toEqual([]);

      // incremental: an item change moves its cart and the item; cancelled carts are included
      const cursor = full.cursor!;
      const itemCursor = items.cursor!;
      expect((await drain(mine.who, 'carts', cursor)).items).toEqual([]);
      await as(mine.who, 'PATCH', `/cart-items/${itemIds[0]!}`, { quantity: '2' });
      await as(mine.who, 'PATCH', `/carts/${cartIds[1]!}/status`, { status: 'cancelled' });
      const next = await eventually(
        'the changed carts',
        () => drain(mine.who, 'carts', cursor),
        (r) => [cartIds[0]!, cartIds[1]!].every((id) => r.items.some((i) => i.id === id)),
      );
      expect(next.items.map((i) => i.id).sort()).toEqual([cartIds[0]!, cartIds[1]!].sort());
      const nextItems = await eventually(
        'the changed item',
        () => drain(mine.who, 'cart-items', itemCursor),
        (r) => r.items.some((i) => i.id === itemIds[0]),
      );
      expect(nextItems.items.map((i) => i.id)).toEqual([itemIds[0]!]);
      const cancelled = await as(mine.who, 'GET', `/carts/changes?cursor=${cursor}&limit=100`);
      expect(cancelled.body.items.find((c: { id: string }) => c.id === cartIds[1])?.status).toBe(
        'cancelled',
      );
      // a conflict or an idempotent replay writes nothing
      await as(mine.who, 'PATCH', `/cart-items/${itemIds[2]!}`, { quantity: '2' }, ifMatch(9));
      expect((await drain(mine.who, 'carts', next.cursor)).items).toEqual([]);
    },
    FEED_TEST_TIMEOUT_MS,
  );

  it('invalid cursor is 400, `changes` is not an id and the feed needs carts.use', async () => {
    const { who } = await mkUser();
    for (const path of ['carts', 'cart-items']) {
      expect((await as(who, 'GET', `/${path}/changes?cursor=***`)).status).toBe(400);
      expect((await as(who, 'GET', `/${path}/changes?cursor=abc`)).status).toBe(400);
      expect((await as(who, 'GET', `/${path}/changes?cursor=a\u0000b`)).status).toBe(400);
      expect((await as(who, 'GET', `/${path}/changes?limit=0`)).status).toBe(400);
      const ok = await as(who, 'GET', `/${path}/changes`);
      expect(ok.status).toBe(200);
      expect(ok.body).toHaveProperty('items');
      const reader = await actor(['carts.read', 'establishments.all']);
      expect((await as(reader, 'GET', `/${path}/changes`)).status).toBe(403);
      expect((await call('GET', `/${path}/changes`)).status).toBe(401);
    }
  });
});

describe('audit (CA-15)', () => {
  it('every effective write records its event with cartId, itemId and actorId', async () => {
    const { who, est } = await mkUser();
    const lot = await mkLot(est);
    const cart = await mkCart(who, est);
    const item = (await addItem(who, cart.id, lot.lineId, '2')).body;
    await addItem(who, cart.id, lot.lineId, '1');
    await as(who, 'PATCH', `/cart-items/${item.id}`, { quantity: '1' });
    await as(who, 'PATCH', `/cart-items/${item.id}/status`, { isActive: false });
    await as(who, 'PATCH', `/cart-items/${item.id}/status`, { isActive: true });
    await as(who, 'PATCH', `/carts/${cart.id}/status`, { status: 'cancelled' });
    const mine = (name: string) =>
      events(name).filter((e) => e.cartId === cart.id && e.actorId === who.userId);
    expect(mine('cart.created')).toHaveLength(1);
    expect(mine('cart_item.added').every((e) => e.itemId === item.id)).toBe(true);
    expect(mine('cart_item.added')).toHaveLength(2);
    expect(mine('cart_item.updated')).toHaveLength(1);
    expect(mine('cart_item.removed')).toHaveLength(1);
    expect(mine('cart_item.reactivated')).toHaveLength(1);
    expect(mine('cart.cancelled')).toHaveLength(1);
    // failures and no-ops write no event
    await as(who, 'PATCH', `/cart-items/${item.id}`, { quantity: '1' });
    expect(mine('cart_item.updated')).toHaveLength(1);
  });
});

describe('errors, order and compatibility (CA-16)', () => {
  it('uppercase ids work, NUL is 400 and the documented order holds', async () => {
    const { who, est } = await mkUser();
    const lot = await mkLot(est);
    const cart = await mkCart(who, est);
    const upper = (id: string) => id.toUpperCase();
    expect((await as(who, 'GET', `/carts/${upper(cart.id)}`)).status).toBe(200);
    const item = await addItem(who, upper(cart.id), upper(lot.lineId), '1');
    expect(item.status, item.raw).toBe(201);
    expect(item.body.inventoryLineId).toBe(lot.lineId);
    expect(
      (await as(who, 'PATCH', `/cart-items/${upper(item.body.id)}`, { quantity: '2' })).status,
    ).toBe(200);
    expect((await as(who, 'GET', `/carts?establishmentId=${upper(est)}`)).status).toBe(200);
    expect((await as(who, 'GET', `/carts/${ZERO}`)).body.code).toBe('CART_NOT_FOUND');
    expect((await as(who, 'GET', '/carts?establishmentId=a%00b')).status).toBe(400);
    // 400 -> 404 -> 403 -> VERSION_CONFLICT -> 409 state
    expect((await as(who, 'PATCH', `/cart-items/${uuid()}`, { quantity: '0' })).status).toBe(400);
    expect((await as(who, 'PATCH', `/cart-items/${uuid()}`, { quantity: '1' })).status).toBe(404);
    await pool.query('DELETE FROM establishment_users WHERE user_id = $1', [who.userId]);
    expect(
      (await as(who, 'PATCH', `/cart-items/${item.body.id}`, { quantity: '1' }, ifMatch(99)))
        .status,
    ).toBe(403);
    await assignTo(who, est);
    const conflict = await as(
      who,
      'PATCH',
      `/cart-items/${item.body.id}`,
      { quantity: '1' },
      ifMatch(99),
    );
    expect(conflict.body.code).toBe('VERSION_CONFLICT');
    await as(who, 'PATCH', `/carts/${cart.id}/status`, { status: 'cancelled' });
    expect(
      (await as(who, 'PATCH', `/cart-items/${item.body.id}`, { quantity: '1' }, ifMatch(99))).body
        .code,
    ).toBe('VERSION_CONFLICT');
    expect(
      (await as(who, 'PATCH', `/cart-items/${item.body.id}`, { quantity: '1' })).body.code,
    ).toBe('CART_NOT_OPEN');
  });

  it('core does not write in the identity tables', async () => {
    const { who, est } = await mkUser();
    const snapshot = () =>
      pool.query(`SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM roles) AS roles,
         (SELECT count(*) FROM role_permissions) AS grants`);
    const before = await snapshot();
    const cart = await mkCart(who, est);
    await as(who, 'PATCH', `/carts/${cart.id}/status`, { status: 'cancelled' });
    expect((await snapshot()).rows[0]).toEqual(before.rows[0]);
  });
});
