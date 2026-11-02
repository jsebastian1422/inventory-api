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
 * Integration tests (sprint 008) over HTTP against a real PostgreSQL TEST database: checkout of a
 * cart, invoice numbering per establishment, stock and history, access rules, races, idempotency
 * and the offline feed. Users and roles
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
  await pool.query('TRUNCATE inventory_line_history, sale_items, sales, sale_counters');
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

const sell = (who: Actor, cartId: string, body?: unknown, headers?: Record<string, string>) =>
  as(who, 'POST', `/carts/${cartId}/checkout`, body, headers);

/** A seller (`carts.use` + `sales.create`) assigned to a new establishment. */
const mkSeller = (extra: readonly string[] = []) => mkUser(['sales.create', ...extra]);

/** Cart of `who` with one active item per `[lineId, quantity]`. */
async function cartWith(who: Actor, est: string, items: [string, string][]) {
  const cart = await mkCart(who, est);
  const added: { id: string }[] = [];
  for (const [lineId, quantity] of items) {
    const item = await addItem(who, cart.id, lineId, quantity);
    expect(item.status, item.raw).toBe(201);
    added.push(item.body);
  }
  return { cart, items: added };
}

const lineRow = async (lineId: string) =>
  (
    await pool.query<{ initial: string; current: string; version: number }>(
      `SELECT quantity_initial::text AS initial, quantity_current::text AS current, version
       FROM inventory_lines WHERE id = $1`,
      [lineId],
    )
  ).rows[0]!;
const historyCount = async (lineId: string) =>
  Number(
    (
      await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM inventory_line_history WHERE line_id = $1`,
        [lineId],
      )
    ).rows[0]!.n,
  );
const counterOf = async (est: string) =>
  (
    await pool.query<{ last_number: number }>(
      'SELECT last_number FROM sale_counters WHERE establishment_id = $1',
      [est],
    )
  ).rows[0]?.last_number ?? 0;
const salesCount = async () =>
  Number((await pool.query<{ n: string }>('SELECT count(*) AS n FROM sales')).rows[0]!.n);
const cartStatus = async (cartId: string) =>
  (await pool.query<{ status: string }>('SELECT status FROM carts WHERE id = $1', [cartId]))
    .rows[0]!.status;

describe('schema (CA-1) and permissions (CA-2)', () => {
  it('sales, sale_items and sale_counters have the columns, FKs, CHECKs, uniques and indexes of the spec', async () => {
    const columns = async (table: string) =>
      (
        await pool.query<{ column_name: string; type: string; is_nullable: string }>(
          `SELECT column_name, format_type(a.atttypid, a.atttypmod) AS type, is_nullable
           FROM information_schema.columns c
           JOIN pg_attribute a ON a.attrelid = c.table_name::regclass AND a.attname = c.column_name
           WHERE c.table_name = $1 ORDER BY column_name`,
          [table],
        )
      ).rows;
    const types = (rows: Awaited<ReturnType<typeof columns>>) =>
      Object.fromEntries(rows.map((r) => [r.column_name, r.type]));
    expect(types(await columns('sales'))).toEqual({
      cart_id: 'uuid',
      change_xid: 'xid8',
      created_at: 'timestamp with time zone',
      customer_doc_number: 'character varying(20)',
      customer_doc_type: 'character varying(4)',
      customer_email: 'character varying(254)',
      customer_name: 'character varying(150)',
      customer_phone: 'character varying(30)',
      establishment_id: 'uuid',
      id: 'uuid',
      number: 'integer',
      seller_id: 'uuid',
      total: 'numeric(18,2)',
      version: 'integer',
    });
    expect(types(await columns('sale_items'))).toEqual({
      barcode: 'character varying(64)',
      cart_item_id: 'uuid',
      expires_on: 'date',
      id: 'uuid',
      inventory_line_id: 'uuid',
      product_id: 'uuid',
      product_name: 'character varying(150)',
      quantity: 'numeric(14,3)',
      sale_id: 'uuid',
      sku: 'character varying(50)',
      subtotal: 'numeric(18,2)',
      unit: 'character varying(16)',
      unit_price: 'numeric(14,2)',
    });
    expect(types(await columns('sale_counters'))).toEqual({
      establishment_id: 'uuid',
      last_number: 'integer',
    });
    const constraints = async (table: string) =>
      (
        await pool.query<{ conname: string; def: string }>(
          `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
           WHERE conrelid = $1::regclass`,
          [table],
        )
      ).rows;
    const sales = await constraints('sales');
    const fks = (rows: typeof sales) => rows.filter((r) => r.def.startsWith('FOREIGN KEY'));
    expect(fks(sales).map((r) => r.def)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/\(cart_id\) REFERENCES carts\(id\) ON DELETE RESTRICT/),
        expect.stringMatching(
          /\(establishment_id\) REFERENCES establishments\(id\) ON DELETE RESTRICT/,
        ),
      ]),
    );
    // ADR-0001: the seller is an identity user and has no FK
    expect(fks(sales)).toHaveLength(2);
    expect(sales.find((r) => r.conname === 'sales_cart_id_key')?.def).toBe('UNIQUE (cart_id)');
    expect(sales.find((r) => r.conname === 'sales_establishment_number_key')?.def).toBe(
      'UNIQUE (establishment_id, number)',
    );
    expect(sales.map((r) => r.def).join('\n')).toMatch(/number > 0/);
    expect(sales.map((r) => r.def).join('\n')).toMatch(/total >= \(?0/);
    const items = await constraints('sale_items');
    expect(
      fks(items)
        .map((r) => r.def)
        .join('\n'),
    ).toMatch(/REFERENCES sales\(id\)/);
    expect(
      fks(items)
        .map((r) => r.def)
        .join('\n'),
    ).toMatch(/REFERENCES cart_items\(id\)/);
    expect(
      fks(items)
        .map((r) => r.def)
        .join('\n'),
    ).toMatch(/REFERENCES inventory_lines\(id\)/);
    expect(
      fks(items)
        .map((r) => r.def)
        .join('\n'),
    ).toMatch(/REFERENCES products\(id\)/);
    expect(fks(items).every((r) => /ON DELETE RESTRICT/.test(r.def))).toBe(true);
    const counters = await constraints('sale_counters');
    expect(fks(counters)).toHaveLength(1);
    expect(counters.map((r) => r.def).join('\n')).toMatch(/last_number > 0/);
    const indexes = (
      await pool.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE tablename IN ('sales', 'sale_items')`,
      )
    ).rows
      .map((r) => r.indexdef)
      .join('\n');
    expect(indexes).toMatch(/\(seller_id, created_at\)/);
    expect(indexes).toMatch(/\(establishment_id, created_at\)/);
    expect(indexes).toMatch(/\(change_xid, id\)/);
    expect(indexes).toMatch(/sale_items \(sale_id\)|sale_items.*\(sale_id\)/);
  });

  it('the CHECKs reject invalid sales, sold carts and history rows', async () => {
    const { who, est } = await mkSeller();
    const lot = await mkLot(est);
    const { cart } = await cartWith(who, est, [[lot.lineId, '1']]);
    const insertSale = (over: Record<string, unknown>) => {
      const row = {
        number: 1,
        total: '1.00',
        customer_doc_type: null,
        customer_doc_number: null,
        customer_name: null,
        customer_email: null,
        ...over,
      };
      return pool.query(
        `INSERT INTO sales (cart_id, establishment_id, seller_id, number, total, customer_doc_type,
           customer_doc_number, customer_name, customer_email)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          cart.id,
          est,
          who.userId,
          row.number,
          row.total,
          row.customer_doc_type,
          row.customer_doc_number,
          row.customer_name,
          row.customer_email,
        ],
      );
    };
    const check = { code: '23514' };
    await expect(insertSale({ number: 0 })).rejects.toMatchObject(check);
    await expect(insertSale({ total: '-1' })).rejects.toMatchObject(check);
    await expect(insertSale({ customer_doc_type: 'CC' })).rejects.toMatchObject(check);
    await expect(
      insertSale({ customer_doc_type: 'XX', customer_doc_number: '1', customer_name: 'A' }),
    ).rejects.toMatchObject(check);
    await expect(
      insertSale({ customer_doc_type: 'CC', customer_doc_number: '1' }),
    ).rejects.toMatchObject(check);
    await expect(insertSale({ customer_email: 'a@b.co' })).rejects.toMatchObject(check);
    await expect(insertSale({ total: '10000000000000000' })).rejects.toMatchObject({
      code: '22003',
    });
    await expect(
      insertSale({ customer_doc_type: 'NIT', customer_doc_number: '9', customer_name: 'B' }),
    ).resolves.toBeDefined();
    await expect(insertSale({ number: 2 })).rejects.toMatchObject({ code: '23505' });
    await expect(
      pool.query(`UPDATE carts SET status = 'sold' WHERE id = $1`, [cart.id]),
    ).rejects.toMatchObject(check);
    await expect(
      pool.query(`UPDATE carts SET status = 'open', sold_at = now(), sold_by = $2 WHERE id = $1`, [
        cart.id,
        who.userId,
      ]),
    ).rejects.toMatchObject(check);
    await expect(
      pool.query(
        `UPDATE carts SET status = 'sold', sold_at = now(), sold_by = $2, cancelled_at = now(),
           cancelled_by = $2 WHERE id = $1`,
        [cart.id, who.userId],
      ),
    ).rejects.toMatchObject(check);
    await expect(
      pool.query(`UPDATE carts SET status = 'sold', sold_at = now(), sold_by = $2 WHERE id = $1`, [
        cart.id,
        who.userId,
      ]),
    ).resolves.toBeDefined();
    const sale = (
      await pool.query<{ id: string }>('SELECT id FROM sales WHERE cart_id = $1', [cart.id])
    ).rows[0]!.id;
    const insertHistory = (reason: string, saleId: string | null) =>
      pool.query(
        `INSERT INTO inventory_line_history (line_id, reason, initial_after, current_after, actor_id, sale_id)
         VALUES ($1, $2, 1, 1, $3, $4)`,
        [lot.lineId, reason, who.userId, saleId],
      );
    await expect(insertHistory('sale', null)).rejects.toMatchObject(check);
    await expect(insertHistory('created', sale)).rejects.toMatchObject(check);
    await expect(insertHistory('other', null)).rejects.toMatchObject(check);
    await expect(insertHistory('sale', sale)).resolves.toBeDefined();
    await expect(pool.query('DELETE FROM sales WHERE id = $1', [sale])).rejects.toMatchObject({
      code: 'P0V01',
    });
    await pool.query(
      `UPDATE carts SET status = 'open', sold_at = NULL, sold_by = NULL WHERE id = $1`,
      [cart.id],
    );
  });

  it('sales.create and sales.read exist in Spanish and the system role holds them', async () => {
    const { rows } = await pool.query<{ code: string; module: string; description: string }>(
      `SELECT code, module, description FROM permissions WHERE code IN ('sales.create', 'sales.read')
       ORDER BY code`,
    );
    expect(rows).toEqual([
      {
        code: 'sales.create',
        module: 'sales',
        description: 'Vender sus carritos y consultar sus ventas',
      },
      { code: 'sales.read', module: 'sales', description: 'Consultar ventas de sus locales' },
    ]);
    const held = await pool.query<{ code: string }>(
      `SELECT p.code FROM roles r
       JOIN role_permissions rp ON rp.role_id = r.id JOIN permissions p ON p.id = rp.permission_id
       WHERE r.is_system AND p.code IN ('sales.create', 'sales.read')`,
    );
    expect(held.rows.map((r) => r.code).sort()).toEqual(['sales.create', 'sales.read']);
  });
});

describe('checkout (CA-3, CA-4)', () => {
  it('201 with number 1, frozen items, stock discounted, sold cart and history', async () => {
    const { who, est } = await mkSeller();
    const a = await mkLot(est, '10.50', '10');
    const b = await mkLot(est, '3.00', '5');
    const { cart, items } = await cartWith(who, est, [
      [a.lineId, '2'],
      [b.lineId, '1.500'],
    ]);
    const res = await sell(who, cart.id);
    expect(res.status, res.raw).toBe(201);
    expect(res.body).toMatchObject({
      number: 1,
      establishmentId: est,
      cartId: cart.id,
      sellerId: who.userId,
      customer: null,
      customerLabel: 'Consumidor final',
      total: '25.50',
      version: 1,
    });
    expect(Object.keys(res.body).sort()).toEqual([
      'cartId',
      'createdAt',
      'customer',
      'customerLabel',
      'establishmentId',
      'id',
      'items',
      'number',
      'sellerId',
      'total',
      'version',
    ]);
    expect(Date.parse(res.body.createdAt)).not.toBeNaN();
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0]).toMatchObject({
      inventoryLineId: a.lineId,
      productId: a.productId,
      unit: 'unit',
      unitPrice: '10.50',
      quantity: '2.000',
      subtotal: '21.00',
      expiresOn: null,
    });
    expect(Object.keys(res.body.items[0]).sort()).toEqual([
      'barcode',
      'expiresOn',
      'id',
      'inventoryLineId',
      'productId',
      'productName',
      'quantity',
      'sku',
      'subtotal',
      'unit',
      'unitPrice',
    ]);
    expect(res.body.items[1]).toMatchObject({
      inventoryLineId: b.lineId,
      unitPrice: '3.00',
      quantity: '1.500',
      subtotal: '4.50',
    });
    expect(res.raw).not.toMatch(/"(total|subtotal|unitPrice|quantity)":\s*[0-9]/);
    expect(await lineRow(a.lineId)).toMatchObject({ initial: '10.000', current: '8.000' });
    expect(await lineRow(b.lineId)).toMatchObject({ initial: '5.000', current: '3.500' });
    expect(await counterOf(est)).toBe(1);

    const detail = await as(who, 'GET', `/carts/${cart.id}`);
    expect(detail.body).toMatchObject({
      status: 'sold',
      soldBy: who.userId,
      saleId: res.body.id,
      cancelledAt: null,
    });
    expect(Date.parse(detail.body.soldAt)).not.toBeNaN();
    expect(detail.body.version).toBeGreaterThan(items.length);

    // the sale is readable afterwards and equals the answer
    const read = await as(who, 'GET', `/sales/${res.body.id}`);
    expect(read.body).toEqual(res.body);
  });

  it('CA-3: numbers are consecutive per establishment and independent between them', async () => {
    const { who, est } = await mkSeller();
    const other = await mkEstablishment();
    await assignTo(who, other);
    const numbers: number[] = [];
    for (let i = 0; i < 3; i++) {
      const lot = await mkLot(est, '1.00', '5');
      const { cart } = await cartWith(who, est, [[lot.lineId, '1']]);
      const res = await sell(who, cart.id);
      expect(res.status, res.raw).toBe(201);
      numbers.push(res.body.number);
    }
    expect(numbers).toEqual([1, 2, 3]);
    const lot = await mkLot(other, '1.00', '5');
    const { cart } = await cartWith(who, other, [[lot.lineId, '1']]);
    expect((await sell(who, cart.id)).body.number).toBe(1);
    expect(await counterOf(est)).toBe(3);
    expect(await counterOf(other)).toBe(1);
  });

  it('CA-4: history has one `sale` row per item with before/after, negative delta, sale, actor and date', async () => {
    const { who, est } = await mkSeller();
    const a = await mkLot(est, '1.00', '10');
    const b = await mkLot(est, '1.00', '4');
    const { cart } = await cartWith(who, est, [
      [a.lineId, '2.500'],
      [b.lineId, '4'],
    ]);
    const sale = await sell(who, cart.id);
    expect(sale.status, sale.raw).toBe(201);
    const history = await as(builder, 'GET', `/inventory-lines/${a.lineId}/history`);
    expect(history.status, history.raw).toBe(200);
    expect(history.body.total).toBe(2);
    expect(history.body.items[0]).toEqual({
      reason: 'sale',
      initialBefore: '10.000',
      initialAfter: '10.000',
      currentBefore: '10.000',
      currentAfter: '7.500',
      delta: '-2.500',
      saleId: sale.body.id,
      actorId: who.userId,
      changedAt: expect.any(String),
    });
    expect(history.body.items[1]).toMatchObject({ reason: 'created', saleId: null });
    const empty = await as(builder, 'GET', `/inventory-lines/${b.lineId}/history`);
    expect(empty.body.items[0]).toMatchObject({
      reason: 'sale',
      currentBefore: '4.000',
      currentAfter: '0.000',
      delta: '-4.000',
    });
    expect(await lineRow(b.lineId)).toMatchObject({ initial: '4.000', current: '0.000' });
  });
});

describe('all or nothing (CA-5)', () => {
  /** Applies `break` to the lot of an item and expects the 409 with that reason and no change at all. */
  const unavailable = async (
    reason: string,
    breakLot: (lot: Awaited<ReturnType<typeof mkLot>>, est: string) => Promise<void>,
  ) => {
    const { who, est } = await mkSeller();
    const good = await mkLot(est, '2.00', '10');
    const bad = await mkLot(est, '2.00', '10');
    const { cart, items } = await cartWith(who, est, [
      [good.lineId, '3'],
      [bad.lineId, '4'],
    ]);
    await breakLot(bad, est);
    const before = {
      good: await lineRow(good.lineId),
      bad: await lineRow(bad.lineId),
      counter: await counterOf(est),
      version: (await as(who, 'GET', `/carts/${cart.id}`)).body.version,
      sales: await salesCount(),
    };
    const res = await sell(who, cart.id);
    expect(res.status, res.raw).toBe(409);
    expect(res.body.code).toBe('SALE_ITEMS_UNAVAILABLE');
    expect(res.body.details).toEqual([
      expect.objectContaining({
        itemId: items[1]!.id,
        inventoryLineId: bad.lineId,
        reason,
        available: expect.any(String),
      }),
    ]);
    expect(await lineRow(good.lineId)).toEqual(before.good);
    expect(await lineRow(bad.lineId)).toEqual(before.bad);
    expect(await counterOf(est)).toBe(before.counter);
    expect(await salesCount()).toBe(before.sales);
    expect(await historyCount(good.lineId)).toBe(1);
    expect(await cartStatus(cart.id)).toBe('open');
    expect((await as(who, 'GET', `/carts/${cart.id}`)).body.version).toBe(before.version);
    return { who, est, cart, good, bad };
  };

  it('inactive line', async () => {
    await unavailable('LINE_INACTIVE', async (lot) => {
      await pool.query('UPDATE inventory_lines SET is_active = false WHERE id = $1', [lot.lineId]);
    });
  });

  it('inactive inventory', async () => {
    await unavailable('INVENTORY_INACTIVE', async (lot) => {
      await pool.query('UPDATE inventories SET is_active = false WHERE id = $1', [lot.inventoryId]);
    });
  });

  it('inactive product', async () => {
    await unavailable('PRODUCT_INACTIVE', async (lot) => {
      await pool.query('UPDATE products SET is_active = false WHERE id = $1', [lot.productId]);
    });
  });

  it('lot moved to another establishment', async () => {
    await unavailable('LINE_OTHER_ESTABLISHMENT', async (lot) => {
      const other = await mkEstablishment();
      await pool.query('UPDATE inventories SET establishment_id = $2 WHERE id = $1', [
        lot.inventoryId,
        other,
      ]);
    });
  });

  it('insufficient stock, also after the first item was fine', async () => {
    const { who, est, cart, bad } = await unavailable('INSUFFICIENT_STOCK', async (lot) => {
      await pool.query('UPDATE inventory_lines SET quantity_current = 3 WHERE id = $1', [
        lot.lineId,
      ]);
    });
    // once the lot is replenished the same cart sells
    await pool.query('UPDATE inventory_lines SET quantity_current = 4 WHERE id = $1', [bad.lineId]);
    expect((await sell(who, cart.id)).status).toBe(201);
    expect((await lineRow(bad.lineId)).current).toBe('0.000');
    expect(await counterOf(est)).toBe(1);
  });

  it('lists every unavailable item', async () => {
    const { who, est } = await mkSeller();
    const lots = [await mkLot(est), await mkLot(est), await mkLot(est)];
    const { cart } = await cartWith(
      who,
      est,
      lots.map((lot) => [lot.lineId, '1'] as [string, string]),
    );
    await pool.query('UPDATE inventory_lines SET is_active = false WHERE id = $1', [
      lots[0]!.lineId,
    ]);
    await pool.query('UPDATE products SET is_active = false WHERE id = $1', [lots[2]!.productId]);
    const res = await sell(who, cart.id);
    expect(res.body.code).toBe('SALE_ITEMS_UNAVAILABLE');
    expect(res.body.details.map((d: { reason: string }) => d.reason).sort()).toEqual([
      'LINE_INACTIVE',
      'PRODUCT_INACTIVE',
    ]);
  });

  it('a cart without active items is 409 CART_EMPTY; removed items are ignored', async () => {
    const { who, est } = await mkSeller();
    const empty = await mkCart(who, est);
    const before = await counterOf(est);
    expect(await sell(who, empty.id)).toMatchObject({ status: 409, body: { code: 'CART_EMPTY' } });
    const lot = await mkLot(est, '5.00', '10');
    const broken = await mkLot(est, '5.00', '10');
    const { cart, items } = await cartWith(who, est, [
      [lot.lineId, '1'],
      [broken.lineId, '1'],
    ]);
    await as(who, 'PATCH', `/cart-items/${items[1]!.id}/status`, { isActive: false });
    await pool.query('UPDATE inventory_lines SET is_active = false WHERE id = $1', [broken.lineId]);
    const res = await sell(who, cart.id);
    expect(res.status, res.raw).toBe(201);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.total).toBe('5.00');
    expect(await lineRow(broken.lineId)).toMatchObject({ current: '10.000' });
    expect(await counterOf(est)).toBe(before + 1);
    const onlyRemoved = await cartWith(who, est, [[lot.lineId, '1']]);
    await as(who, 'PATCH', `/cart-items/${onlyRemoved.items[0]!.id}/status`, { isActive: false });
    expect((await sell(who, onlyRemoved.cart.id)).body.code).toBe('CART_EMPTY');
  });
});

describe('frozen invoice and exact amounts (CA-6)', () => {
  it('later changes of price, name, SKU and activation do not change the sale', async () => {
    const { who, est } = await mkSeller();
    const lot = await mkLot(est, '12.34', '10');
    const { cart } = await cartWith(who, est, [[lot.lineId, '3']]);
    const sale = await sell(who, cart.id);
    expect(sale.status, sale.raw).toBe(201);
    const frozen = await as(who, 'GET', `/sales/${sale.body.id}`);
    const patch = await build('PATCH', `/products/${lot.productId}`, {
      price: '99.00',
      name: 'Otro nombre',
      sku: `NEW-${unique()}`,
    });
    expect(patch.status, patch.raw).toBe(200);
    await pool.query('UPDATE products SET is_active = false WHERE id = $1', [lot.productId]);
    await pool.query('UPDATE inventory_lines SET barcode = $2, is_active = false WHERE id = $1', [
      lot.lineId,
      `NEW-${unique()}`,
    ]);
    const after = await as(who, 'GET', `/sales/${sale.body.id}`);
    expect(after.body).toEqual(frozen.body);
    expect(after.body.items[0]).toMatchObject({ unitPrice: '12.34', subtotal: '37.02' });
    expect(after.body.items[0].productName).not.toBe('Otro nombre');
    expect(after.body.total).toBe('37.02');
  });

  it('rounding half up per item and the total is the sum of the rounded subtotals', async () => {
    const { who, est } = await mkSeller();
    const cases: [string, string, string][] = [
      ['0.01', '0.500', '0.01'],
      ['0.15', '2.500', '0.38'],
      ['0.10', '0.333', '0.03'],
      ['3.33', '3', '9.99'],
      ['0.01', '0.499', '0.00'],
    ];
    const lots = [];
    for (const [price] of cases) lots.push(await mkLot(est, price, '10'));
    const { cart } = await cartWith(
      who,
      est,
      lots.map((lot, i) => [lot.lineId, cases[i]![1]] as [string, string]),
    );
    const sale = await sell(who, cart.id);
    expect(sale.status, sale.raw).toBe(201);
    expect(sale.body.items.map((i: { subtotal: string }) => i.subtotal)).toEqual(
      cases.map((c) => c[2]),
    );
    expect(sale.body.total).toBe('10.41');
    const stored = await pool.query<{ total: string }>(
      'SELECT total::text FROM sales WHERE id = $1',
      [sale.body.id],
    );
    expect(stored.rows[0]!.total).toBe('10.41');
  });

  it('totals of 10^12 or more are exact; beyond numeric(18,2) it is 409 and consumes no number', async () => {
    const { who, est } = await mkSeller();
    const big = await mkLot(est, '999999999999.99', '1000');
    const { cart } = await cartWith(who, est, [[big.lineId, '2']]);
    const sale = await sell(who, cart.id);
    expect(sale.status, sale.raw).toBe(201);
    expect(sale.body.total).toBe('1999999999999.98');
    expect(sale.body.items[0].subtotal).toBe('1999999999999.98');

    const huge = await mkLot(est, '999999999999.99', '99999999999');
    const over = await cartWith(who, est, [[huge.lineId, '99999999999']]);
    const counter = await counterOf(est);
    const res = await sell(who, over.cart.id);
    expect(res).toMatchObject({ status: 409, body: { code: 'SALE_AMOUNT_OUT_OF_RANGE' } });
    expect(await counterOf(est)).toBe(counter);
    expect(await cartStatus(over.cart.id)).toBe('open');
    expect((await lineRow(huge.lineId)).current).toBe('99999999999.000');
  });
});

describe('buyer (CA-7)', () => {
  it('stores the buyer data; without buyer it is Consumidor final', async () => {
    const { who, est } = await mkSeller();
    const lot = await mkLot(est, '1.00', '10');
    const full = await sell(who, (await cartWith(who, est, [[lot.lineId, '1']])).cart.id, {
      customer: {
        docType: 'NIT',
        docNumber: '9001234567',
        name: '  Ferretería Sur SAS ',
        email: 'compras@sur.example',
        phone: '+57 (604) 123-4567',
      },
    });
    expect(full.status, full.raw).toBe(201);
    expect(full.body.customer).toEqual({
      docType: 'NIT',
      docNumber: '9001234567',
      name: 'Ferretería Sur SAS',
      email: 'compras@sur.example',
      phone: '+57 (604) 123-4567',
    });
    expect(full.body.customerLabel).toBe('Ferretería Sur SAS');
    const minimal = await sell(who, (await cartWith(who, est, [[lot.lineId, '1']])).cart.id, {
      customer: { docType: 'CC', docNumber: '123', name: 'Ana' },
    });
    expect(minimal.body.customer).toEqual({
      docType: 'CC',
      docNumber: '123',
      name: 'Ana',
      email: null,
      phone: null,
    });
    const nit = await sell(who, (await cartWith(who, est, [[lot.lineId, '1']])).cart.id, {
      customer: { docType: 'NIT', docNumber: '900123456-7', name: 'Ana' },
    });
    expect(nit.status, nit.raw).toBe(201);
    expect(nit.body.customer.docNumber).toBe('900123456-7');
    const none = await sell(who, (await cartWith(who, est, [[lot.lineId, '1']])).cart.id, {
      customer: null,
    });
    expect(none.body).toMatchObject({ customer: null, customerLabel: 'Consumidor final' });
    const read = await as(who, 'GET', `/sales/${full.body.id}`);
    expect(read.body.customer.name).toBe('Ferretería Sur SAS');
  });

  it('invalid buyer data is 400 and nothing is sold', async () => {
    const { who, est } = await mkSeller();
    const lot = await mkLot(est, '1.00', '10');
    const { cart } = await cartWith(who, est, [[lot.lineId, '1']]);
    const base = { docType: 'CC', docNumber: '123', name: 'Ana' };
    const bad: unknown[] = [
      { customer: { docType: 'CC', name: 'Ana' } },
      { customer: { docType: 'CC', docNumber: '123' } },
      { customer: { docNumber: '123', name: 'Ana' } },
      { customer: { ...base, docType: 'XX' } },
      { customer: { ...base, docType: 'cc' } },
      { customer: { ...base, email: 'no-es-correo' } },
      { customer: { ...base, phone: 'abc' } },
      { customer: { ...base, name: 'A\u0000B' } },
      { customer: { ...base, email: 'a\u0000@b.co' } },
      { customer: { ...base, docNumber: '12 34' } },
      { customer: { ...base, docNumber: '-123' } },
      { customer: { ...base, docNumber: '123-' } },
      { customer: { ...base, docNumber: '12--3' } },
      { customer: { ...base, docNumber: '---' } },
      { customer: { ...base, name: 'x'.repeat(151) } },
      { customer: { ...base, docNumber: 123 } },
      { customer: 'Ana' },
      { id: 'no-uuid' },
    ];
    for (const body of bad) {
      const res = await sell(who, cart.id, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    }
    expect(await cartStatus(cart.id)).toBe('open');
    expect(await counterOf(est)).toBe(0);
  });
});

describe('access (CA-8) and the sold cart (CA-9)', () => {
  it('foreign cart is 404, unknown 404, without sales.create 403, invalid id 400', async () => {
    const { who, est } = await mkSeller();
    const lot = await mkLot(est, '1.00', '10');
    const { cart } = await cartWith(who, est, [[lot.lineId, '1']]);
    const stranger = await actor(['carts.use', 'sales.create']);
    await assignTo(stranger, est);
    expect(await sell(stranger, cart.id)).toMatchObject({
      status: 404,
      body: { code: 'CART_NOT_FOUND' },
    });
    expect(await sell(who, ZERO)).toMatchObject({ status: 404, body: { code: 'CART_NOT_FOUND' } });
    const noPermission = await actor(['carts.use']);
    await assignTo(noPermission, est);
    const own = await cartWith(noPermission, est, [[lot.lineId, '1']]);
    expect((await sell(noPermission, own.cart.id)).status).toBe(403);
    expect((await call('POST', `/carts/${cart.id}/checkout`)).status).toBe(401);
    expect((await sell(who, 'no-uuid')).status).toBe(400);
    expect(await cartStatus(cart.id)).toBe('open');
    expect((await lineRow(lot.lineId)).current).toBe('10.000');
  });

  it('a reader of foreign carts (carts.read + establishments.all) cannot sell them', async () => {
    const { who, est } = await mkSeller();
    const lot = await mkLot(est, '1.00', '10');
    const { cart } = await cartWith(who, est, [[lot.lineId, '1']]);
    const reader = await actor(['carts.read', 'establishments.all', 'sales.create']);
    expect((await sell(reader, cart.id)).status).toBe(404);
  });

  it('sold and cancelled carts are 409 CART_NOT_OPEN', async () => {
    const { who, est } = await mkSeller();
    const lot = await mkLot(est, '1.00', '10');
    const sold = await cartWith(who, est, [[lot.lineId, '1']]);
    expect((await sell(who, sold.cart.id)).status).toBe(201);
    expect(await sell(who, sold.cart.id)).toMatchObject({
      status: 409,
      body: { code: 'CART_NOT_OPEN' },
    });
    const cancelled = await cartWith(who, est, [[lot.lineId, '1']]);
    await as(who, 'PATCH', `/carts/${cancelled.cart.id}/status`, { status: 'cancelled' });
    expect(await sell(who, cancelled.cart.id)).toMatchObject({
      status: 409,
      body: { code: 'CART_NOT_OPEN' },
    });
    expect((await lineRow(lot.lineId)).current).toBe('9.000');
    expect(await counterOf(est)).toBe(1);
  });

  it('local out of the live scope is 403, inactive is 409; both before the cart state', async () => {
    const { who, est } = await mkSeller();
    const lot = await mkLot(est, '1.00', '10');
    const { cart } = await cartWith(who, est, [[lot.lineId, '1']]);
    await pool.query(
      'UPDATE establishment_users SET removed_at = now(), removed_by = user_id WHERE user_id = $1',
      [who.userId],
    );
    expect(await sell(who, cart.id)).toMatchObject({
      status: 403,
      body: { code: 'ESTABLISHMENT_NOT_IN_SCOPE' },
    });
    await pool.query(
      'UPDATE establishment_users SET removed_at = NULL, removed_by = NULL WHERE user_id = $1',
      [who.userId],
    );
    await pool.query('UPDATE establishments SET is_active = false WHERE id = $1', [est]);
    expect(await sell(who, cart.id)).toMatchObject({
      status: 409,
      body: { code: 'ESTABLISHMENT_INACTIVE' },
    });
    await pool.query('UPDATE establishments SET is_active = true WHERE id = $1', [est]);
    expect((await sell(who, cart.id)).status).toBe(201);
  });

  it('If-Match: a stale version is VERSION_CONFLICT with the cart; the current one sells', async () => {
    const { who, est } = await mkSeller();
    const lot = await mkLot(est, '1.00', '10');
    const { cart } = await cartWith(who, est, [[lot.lineId, '1']]);
    const current = (await as(who, 'GET', `/carts/${cart.id}`)).body.version as number;
    const stale = await sell(who, cart.id, undefined, ifMatch(current - 1));
    expect(stale.status, stale.raw).toBe(409);
    expect(stale.body.code).toBe('VERSION_CONFLICT');
    expect(stale.body.current).toMatchObject({ id: cart.id, status: 'open', version: current });
    expect((await lineRow(lot.lineId)).current).toBe('10.000');
    const ok = await sell(who, cart.id, undefined, ifMatch(current));
    expect(ok.status, ok.raw).toBe(201);
    // after the sale the version moved: the old one conflicts before the state of the cart
    expect((await sell(who, cart.id, undefined, ifMatch(current))).body.code).toBe(
      'VERSION_CONFLICT',
    );
  });

  it('errors are ordered: 400 -> 404 -> scope -> version -> state -> empty -> items', async () => {
    const { who, est } = await mkSeller();
    expect((await sell(who, ZERO, { customer: { docType: 'CC' } })).status).toBe(400);
    expect((await sell(who, ZERO, {})).status).toBe(404);
    const empty = await mkCart(who, est);
    expect((await sell(who, empty.id, undefined, ifMatch(99))).body.code).toBe('VERSION_CONFLICT');
    expect((await sell(who, empty.id)).body.code).toBe('CART_EMPTY');
    await as(who, 'PATCH', `/carts/${empty.id}/status`, { status: 'cancelled' });
    expect((await sell(who, empty.id)).body.code).toBe('CART_NOT_OPEN');
  });

  it('CA-9: a sold cart rejects every write; a sale has no edit endpoints', async () => {
    const { who, est } = await mkSeller();
    const lot = await mkLot(est, '1.00', '10');
    const other = await mkLot(est, '1.00', '10');
    const { cart, items } = await cartWith(who, est, [[lot.lineId, '1']]);
    const sale = await sell(who, cart.id);
    expect(sale.status, sale.raw).toBe(201);
    const notOpen = { status: 409, body: { code: 'CART_NOT_OPEN' } };
    expect(await addItem(who, cart.id, other.lineId, '1')).toMatchObject(notOpen);
    expect(await addItem(who, cart.id, lot.lineId, '1')).toMatchObject(notOpen);
    expect(await as(who, 'PATCH', `/cart-items/${items[0]!.id}`, { quantity: '2' })).toMatchObject(
      notOpen,
    );
    expect(
      await as(who, 'PATCH', `/cart-items/${items[0]!.id}/status`, { isActive: false }),
    ).toMatchObject(notOpen);
    expect(
      await as(who, 'PATCH', `/carts/${cart.id}/status`, { status: 'cancelled' }),
    ).toMatchObject(notOpen);
    expect(await cartStatus(cart.id)).toBe('sold');
    for (const method of ['PATCH', 'PUT', 'DELETE', 'POST'] as const) {
      expect((await as(who, method, `/sales/${sale.body.id}`, {})).status).toBe(404);
    }
    expect((await as(who, 'DELETE', `/carts/${cart.id}`)).status).toBe(404);
    const listed = await as(who, 'GET', '/carts?status=sold');
    expect(listed.body.items.map((c: { id: string }) => c.id)).toContain(cart.id);
  });
});

describe('races (CA-10, CA-11)', () => {
  it('CA-10: simultaneous checkouts of one establishment get 1..N without gaps or repeats', async () => {
    const { who, est } = await mkSeller();
    const other = await mkEstablishment();
    await assignTo(who, other);
    const n = 6;
    const carts: string[] = [];
    for (let i = 0; i < n; i++) {
      const lot = await mkLot(est, '1.00', '5');
      carts.push((await cartWith(who, est, [[lot.lineId, '1']])).cart.id);
    }
    const lotOther = await mkLot(other, '1.00', '5');
    const otherCart = (await cartWith(who, other, [[lotOther.lineId, '1']])).cart.id;
    const empty = (await mkCart(who, est)).id;
    const results = await Promise.all([
      ...carts.map((id) => sell(who, id)),
      sell(who, otherCart),
      sell(who, empty),
    ]);
    expect(results.slice(0, n).map((r) => r.status)).toEqual(Array(n).fill(201));
    expect(
      results
        .slice(0, n)
        .map((r) => r.body.number)
        .sort((a, b) => a - b),
    ).toEqual([1, 2, 3, 4, 5, 6]);
    expect(results[n]!.body.number).toBe(1);
    expect(results[n + 1]).toMatchObject({ status: 409, body: { code: 'CART_EMPTY' } });
    expect(await counterOf(est)).toBe(n);
    expect(await counterOf(other)).toBe(1);
    const numbers = await pool.query<{ number: number }>(
      'SELECT number FROM sales WHERE establishment_id = $1 ORDER BY number',
      [est],
    );
    expect(numbers.rows.map((r) => r.number)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('CA-10: a failed checkout does not consume a number', async () => {
    const { who, est } = await mkSeller();
    const lot = await mkLot(est, '1.00', '5');
    const first = await cartWith(who, est, [[lot.lineId, '1']]);
    expect((await sell(who, first.cart.id)).body.number).toBe(1);
    const broken = await mkLot(est, '1.00', '5');
    const failing = await cartWith(who, est, [[broken.lineId, '1']]);
    await pool.query('UPDATE inventory_lines SET quantity_current = 0 WHERE id = $1', [
      broken.lineId,
    ]);
    expect((await sell(who, failing.cart.id)).body.code).toBe('SALE_ITEMS_UNAVAILABLE');
    expect((await sell(who, (await mkCart(who, est)).id)).body.code).toBe('CART_EMPTY');
    const second = await cartWith(who, est, [[lot.lineId, '1']]);
    expect((await sell(who, second.cart.id)).body.number).toBe(2);
  });

  it('CA-11: double checkout of the same cart sells once and the other is 409 CART_NOT_OPEN', async () => {
    const { who, est } = await mkSeller();
    for (let round = 0; round < 3; round++) {
      const lot = await mkLot(est, '1.00', '10');
      const { cart } = await cartWith(who, est, [[lot.lineId, '3']]);
      const results = await Promise.all([
        sell(who, cart.id),
        sell(who, cart.id),
        sell(who, cart.id),
      ]);
      const statuses = results.map((r) => r.status).sort();
      expect(statuses, JSON.stringify(results.map((r) => r.body))).toEqual([201, 409, 409]);
      for (const res of results.filter((r) => r.status === 409)) {
        expect(res.body.code).toBe('CART_NOT_OPEN');
      }
      expect((await lineRow(lot.lineId)).current).toBe('7.000');
      expect(await historyCount(lot.lineId)).toBe(2);
    }
  });

  it('CA-11: two carts on a lot with stock for one sell once; stock is never negative', async () => {
    const a = await mkSeller();
    const b = await mkUser(['sales.create']);
    for (let round = 0; round < 3; round++) {
      const lot = await mkLot(a.est, '1.00', '5');
      await assignTo(b.who, a.est);
      const first = await cartWith(a.who, a.est, [[lot.lineId, '5']]);
      const second = await cartWith(b.who, a.est, [[lot.lineId, '5']]);
      const results = await Promise.all([sell(a.who, first.cart.id), sell(b.who, second.cart.id)]);
      expect(
        results.map((r) => r.status).sort(),
        JSON.stringify(results.map((r) => r.body)),
      ).toEqual([201, 409]);
      expect(results.find((r) => r.status === 409)!.body.code).toBe('SALE_ITEMS_UNAVAILABLE');
      expect((await lineRow(lot.lineId)).current).toBe('0.000');
      await pool.query(
        'DELETE FROM establishment_users WHERE user_id = $1 AND establishment_id = $2',
        [b.who.userId, a.est],
      );
    }
  });

  it('CA-11: carts sharing lots in opposite order do not deadlock', async () => {
    const { who, est } = await mkSeller();
    const other = await actor(['carts.use', 'sales.create']);
    await assignTo(other, est);
    for (let round = 0; round < 3; round++) {
      const l1 = await mkLot(est, '1.00', '10');
      const l2 = await mkLot(est, '1.00', '10');
      const first = await cartWith(who, est, [
        [l1.lineId, '1'],
        [l2.lineId, '1'],
      ]);
      const second = await cartWith(other, est, [
        [l2.lineId, '2'],
        [l1.lineId, '2'],
      ]);
      const results = await Promise.all([sell(who, first.cart.id), sell(other, second.cart.id)]);
      expect(
        results.map((r) => r.status),
        JSON.stringify(results.map((r) => r.body)),
      ).toEqual([201, 201]);
      expect((await lineRow(l1.lineId)).current).toBe('7.000');
      expect((await lineRow(l2.lineId)).current).toBe('7.000');
    }
  });

  it('a checkout racing with a product deactivation is all or nothing', async () => {
    const { who, est } = await mkSeller();
    const lot = await mkLot(est, '1.00', '10');
    const { cart } = await cartWith(who, est, [[lot.lineId, '2']]);
    const [res, off] = await Promise.all([
      sell(who, cart.id),
      build('PATCH', `/products/${lot.productId}/status`, { isActive: false }),
    ]);
    expect([200, 409]).toContain(off.status);
    expect([201, 409]).toContain(res.status);
    const stock = (await lineRow(lot.lineId)).current;
    if (res.status === 201) expect(stock).toBe('8.000');
    else {
      expect(res.body.code).toBe('SALE_ITEMS_UNAVAILABLE');
      expect(stock).toBe('10.000');
      expect(await cartStatus(cart.id)).toBe('open');
    }
  });
});

describe('idempotency and offline (CA-12)', () => {
  it('the same key answers the same sale: no second discount, number or event', async () => {
    const { who, est } = await mkSeller();
    const lot = await mkLot(est, '4.00', '10');
    const { cart } = await cartWith(who, est, [[lot.lineId, '3']]);
    const headers = key();
    const first = await sell(
      who,
      cart.id,
      { customer: { docType: 'CC', docNumber: '1', name: 'Ana' } },
      headers,
    );
    expect(first.status, first.raw).toBe(201);
    const created = events('sale.created').length;
    const again = await sell(
      who,
      cart.id,
      { customer: { docType: 'CC', docNumber: '1', name: 'Ana' } },
      headers,
    );
    expect(again.status).toBe(201);
    expect(again.body).toEqual(first.body);
    expect(events('sale.created')).toHaveLength(created);
    expect((await lineRow(lot.lineId)).current).toBe('7.000');
    expect(await counterOf(est)).toBe(1);
    expect(await historyCount(lot.lineId)).toBe(2);
    // another body with the same key is not a replay
    const reused = await sell(who, cart.id, {}, headers);
    expect(reused).toMatchObject({ status: 409, body: { code: 'IDEMPOTENCY_KEY_REUSED' } });
    // concurrent replays also sell once
    const lot2 = await mkLot(est, '4.00', '10');
    const second = await cartWith(who, est, [[lot2.lineId, '3']]);
    const same = key();
    const results = await Promise.all([
      sell(who, second.cart.id, undefined, same),
      sell(who, second.cart.id, undefined, same),
      sell(who, second.cart.id, undefined, same),
    ]);
    expect(results.filter((r) => r.status === 201).length).toBeGreaterThanOrEqual(1);
    for (const res of results.filter((r) => r.status !== 201)) {
      expect(res.status).toBe(409);
      expect(['IDEMPOTENCY_IN_PROGRESS', 'CART_NOT_OPEN']).toContain(res.body.code);
    }
    expect((await lineRow(lot2.lineId)).current).toBe('7.000');
  });

  it('a replay re-evaluates permission, scope and establishment state', async () => {
    const setupReplay = async () => {
      const { who, est } = await mkSeller();
      const lot = await mkLot(est, '1.00', '10');
      const { cart } = await cartWith(who, est, [[lot.lineId, '1']]);
      const headers = key();
      expect((await sell(who, cart.id, undefined, headers)).status).toBe(201);
      return { who, est, cart, headers };
    };
    const lostPermission = await setupReplay();
    await pool.query(
      `DELETE FROM role_permissions WHERE role_id = $1
       AND permission_id = (SELECT id FROM permissions WHERE code = 'sales.create')`,
      [lostPermission.who.roleId],
    );
    expect(
      (await sell(lostPermission.who, lostPermission.cart.id, undefined, lostPermission.headers))
        .status,
    ).toBe(403);

    const lostScope = await setupReplay();
    await pool.query(
      'UPDATE establishment_users SET removed_at = now(), removed_by = user_id WHERE user_id = $1',
      [lostScope.who.userId],
    );
    expect(
      await sell(lostScope.who, lostScope.cart.id, undefined, lostScope.headers),
    ).toMatchObject({
      status: 403,
      body: { code: 'ESTABLISHMENT_NOT_IN_SCOPE' },
    });

    const inactive = await setupReplay();
    await pool.query('UPDATE establishments SET is_active = false WHERE id = $1', [inactive.est]);
    expect(await sell(inactive.who, inactive.cart.id, undefined, inactive.headers)).toMatchObject({
      status: 409,
      body: { code: 'ESTABLISHMENT_INACTIVE' },
    });
    await pool.query('UPDATE establishments SET is_active = true WHERE id = $1', [inactive.est]);
    expect((await sell(inactive.who, inactive.cart.id, undefined, inactive.headers)).status).toBe(
      201,
    );
  });

  it('the client id becomes the sale id; a repeated id is 409 SALE_ID_TAKEN and sells nothing', async () => {
    const { who, est } = await mkSeller();
    const lot = await mkLot(est, '1.00', '10');
    const id = uuid().toUpperCase();
    const first = await cartWith(who, est, [[lot.lineId, '1']]);
    const sold = await sell(who, first.cart.id, { id });
    expect(sold.status, sold.raw).toBe(201);
    expect(sold.body.id).toBe(id.toLowerCase());
    const second = await cartWith(who, est, [[lot.lineId, '1']]);
    const counter = await counterOf(est);
    expect(await sell(who, second.cart.id, { id })).toMatchObject({
      status: 409,
      body: { code: 'SALE_ID_TAKEN' },
    });
    expect(await counterOf(est)).toBe(counter);
    expect(await cartStatus(second.cart.id)).toBe('open');
    expect((await lineRow(lot.lineId)).current).toBe('9.000');
    // two carts racing with the same id: one sale, one SALE_ID_TAKEN, no hole in the numbering
    const raceId = uuid();
    const c1 = await cartWith(who, est, [[lot.lineId, '1']]);
    const c2 = await cartWith(who, est, [[lot.lineId, '1']]);
    const results = await Promise.all([
      sell(who, c1.cart.id, { id: raceId }),
      sell(who, c2.cart.id, { id: raceId }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body.code).toBe('SALE_ID_TAKEN');
    expect(await counterOf(est)).toBe(counter + 1);
  });
});

describe('queries (CA-13)', () => {
  const day = (offset: number) =>
    new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

  async function world() {
    const a = await mkSeller();
    const b = await mkSeller();
    const make = async (s: { who: Actor; est: string }, quantity = '1') => {
      const lot = await mkLot(s.est, '5.00', '10');
      const { cart } = await cartWith(s.who, s.est, [[lot.lineId, quantity]]);
      const res = await sell(s.who, cart.id);
      expect(res.status, res.raw).toBe(201);
      return res.body as { id: string; number: number; createdAt: string };
    };
    const a1 = await make(a);
    await new Promise((resolve) => setTimeout(resolve, 15));
    const a2 = await make(a);
    const b1 = await make(b);
    const reader = await actor(['sales.read']);
    await assignTo(reader, a.est);
    const readerAll = await actor(['sales.read', 'establishments.all']);
    return { a, b, a1, a2, b1, reader, readerAll };
  }
  const ids = (res: Res) => (res.body.items as { id: string }[]).map((i) => i.id);

  it('GET /sales/:id: the seller, a reader in scope or with establishments.all; otherwise 404', async () => {
    const w = await world();
    const get = (who: Actor, id: string) => as(who, 'GET', `/sales/${id}`);
    const own = await get(w.a.who, w.a1.id);
    expect(own.status, own.raw).toBe(200);
    expect(own.body.items).toHaveLength(1);
    expect((await get(w.reader, w.a1.id)).status).toBe(200);
    expect((await get(w.readerAll, w.b1.id)).status).toBe(200);
    for (const denied of [
      await get(w.b.who, w.a1.id),
      await get(w.reader, w.b1.id),
      await get(await actor([]), w.a1.id),
      await get(await actor(['sales.create']), w.a1.id),
      await get(w.a.who, ZERO),
    ]) {
      expect(denied).toMatchObject({ status: 404, body: { code: 'SALE_NOT_FOUND' } });
    }
    expect((await get(w.a.who, w.a1.id.toUpperCase())).status).toBe(200);
    expect((await get(w.a.who, 'no-uuid')).status).toBe(400);
    expect((await call('GET', `/sales/${w.a1.id}`)).status).toBe(401);
    // the reader loses the scope: the sale disappears (live scope)
    await pool.query(
      'UPDATE establishment_users SET removed_at = now(), removed_by = user_id WHERE user_id = $1',
      [w.reader.userId],
    );
    expect((await get(w.reader, w.a1.id)).status).toBe(404);
  });

  it('GET /sales: own with sales.create, scope with sales.read, newest first, 403 with neither', async () => {
    const w = await world();
    const own = await as(w.a.who, 'GET', '/sales');
    expect(own.status, own.raw).toBe(200);
    expect(ids(own)).toEqual([w.a2.id, w.a1.id]);
    expect(own.body).toMatchObject({ total: 2, limit: 50, offset: 0 });
    expect(own.body.items[0].items).toHaveLength(1);
    expect(ids(await as(w.b.who, 'GET', '/sales'))).toEqual([w.b1.id]);
    expect(ids(await as(w.reader, 'GET', '/sales'))).toEqual([w.a2.id, w.a1.id]);
    const all = await as(w.readerAll, 'GET', '/sales?limit=200');
    expect(ids(all)).toEqual(expect.arrayContaining([w.a1.id, w.a2.id, w.b1.id]));
    // sales.create + sales.read: own and the scope's
    const both = await actor(['sales.create', 'sales.read']);
    await assignTo(both, w.b.est);
    expect(ids(await as(both, 'GET', '/sales'))).toEqual([w.b1.id]);
    expect((await as(await actor([]), 'GET', '/sales')).status).toBe(403);
    expect((await call('GET', '/sales')).status).toBe(401);
  });

  it('filters, pagination and validation', async () => {
    const w = await world();
    const list = (who: Actor, query: string) => as(who, 'GET', `/sales${query}`);
    expect(ids(await list(w.readerAll, `?establishmentId=${w.b.est}`))).toEqual([w.b1.id]);
    expect(ids(await list(w.readerAll, `?sellerId=${w.a.who.userId}`))).toEqual([w.a2.id, w.a1.id]);
    expect(ids(await list(w.reader, `?sellerId=${w.b.who.userId}`))).toEqual([]);
    expect(ids(await list(w.a.who, `?sellerId=${w.a.who.userId.toUpperCase()}`))).toEqual([
      w.a2.id,
      w.a1.id,
    ]);
    expect((await list(w.a.who, `?sellerId=${w.b.who.userId}`)).status).toBe(403);
    expect(ids(await list(w.a.who, `?from=${day(0)}&to=${day(0)}`))).toEqual([w.a2.id, w.a1.id]);
    expect(ids(await list(w.a.who, `?from=${day(1)}`))).toEqual([]);
    expect(ids(await list(w.a.who, `?to=${day(-2)}`))).toEqual([]);
    expect(ids(await list(w.a.who, `?establishmentId=${w.b.est}`))).toEqual([]);
    const page = await list(w.a.who, '?limit=1&offset=1');
    expect(ids(page)).toEqual([w.a1.id]);
    expect(page.body).toMatchObject({ total: 2, limit: 1, offset: 1 });
    for (const bad of [
      '?limit=0',
      '?limit=201',
      '?offset=-1',
      '?from=2026-13-40',
      '?to=hoy',
      `?from=${day(1)}&to=${day(0)}`,
      '?establishmentId=x',
      '?sellerId=x',
    ]) {
      expect((await list(w.a.who, bad)).status, bad).toBe(400);
    }
  });
});

describe('feed (CA-14)', () => {
  const FEED_WAIT_MS = 60_000;
  async function eventually<T>(what: string, read: () => Promise<T>, ready: (v: T) => boolean) {
    const deadline = Date.now() + FEED_WAIT_MS;
    for (;;) {
      const value = await read();
      if (ready(value)) return value;
      if (Date.now() >= deadline) throw new Error(`the feed did not show ${what} in time`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  async function drain(who: Actor, cursor?: string, limit = 2) {
    const items: { id: string; items: unknown[] }[] = [];
    let next = cursor;
    for (let pages = 0; pages < 100; pages++) {
      const res = await as(
        who,
        'GET',
        `/sales/changes?limit=${limit}${next ? `&cursor=${next}` : ''}`,
      );
      expect(res.status, res.raw).toBe(200);
      items.push(...res.body.items);
      if (res.body.nextCursor) next = res.body.nextCursor;
      if (!res.body.hasMore) return { items, cursor: next };
    }
    throw new Error('feed did not end');
  }

  it('only the sales of the actor, with items, complete without repeats, incremental by cursor', async () => {
    const a = await mkSeller();
    const b = await mkSeller();
    const make = async (s: { who: Actor; est: string }) => {
      const lot = await mkLot(s.est, '1.00', '10');
      const { cart } = await cartWith(s.who, s.est, [[lot.lineId, '1']]);
      return (await sell(s.who, cart.id)).body.id as string;
    };
    const mine = [await make(a), await make(a), await make(a)];
    const theirs = await make(b);
    const all = await eventually(
      '3 sales',
      () => drain(a.who),
      (r) => mine.every((id) => r.items.some((i) => i.id === id)),
    );
    const got = all.items.map((i) => i.id);
    expect(new Set(got).size).toBe(got.length);
    expect([...got].sort()).toEqual([...mine].sort());
    expect(got).not.toContain(theirs);
    expect(all.items.every((i) => i.items.length === 1)).toBe(true);

    const extra = await make(a);
    const incremental = await eventually(
      'the new sale',
      () => drain(a.who, all.cursor),
      (r) => r.items.some((i) => i.id === extra),
    );
    expect(incremental.items.map((i) => i.id)).toEqual([extra]);
    const idle = await as(a.who, 'GET', `/sales/changes?cursor=${incremental.cursor}`);
    expect(idle.body).toMatchObject({ items: [], hasMore: false, nextCursor: incremental.cursor });
  });

  it('400 for a malformed cursor or limit; 403 without sales.create', async () => {
    const { who } = await mkSeller();
    for (const query of ['?cursor=%25%25', '?cursor=abc', '?limit=0', '?limit=501']) {
      expect((await as(who, 'GET', `/sales/changes${query}`)).status, query).toBe(400);
    }
    const reader = await actor(['sales.read', 'establishments.all']);
    expect((await as(reader, 'GET', '/sales/changes')).status).toBe(403);
    expect((await call('GET', '/sales/changes')).status).toBe(401);
  });
});

describe('audit (CA-15) and compatibility (CA-16)', () => {
  it('sale.created and one inventory_line.quantity_sold per line, with ids and no buyer data', async () => {
    const { who, est } = await mkSeller();
    const a = await mkLot(est, '2.00', '10');
    const b = await mkLot(est, '3.00', '10');
    const { cart } = await cartWith(who, est, [
      [a.lineId, '2'],
      [b.lineId, '1'],
    ]);
    logs.length = 0;
    const res = await sell(who, cart.id, {
      customer: {
        docType: 'CC',
        docNumber: '55667788',
        name: 'Zacarías Quispe',
        email: 'zq@example.test',
        phone: '3001234567',
      },
    });
    expect(res.status, res.raw).toBe(201);
    const created = events('sale.created').filter((e) => e.saleId === res.body.id);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      saleId: res.body.id,
      number: 1,
      establishmentId: est,
      sellerId: who.userId,
      total: '7.00',
    });
    const sold = events('inventory_line.quantity_sold').filter((e) => e.saleId === res.body.id);
    expect(sold.map((e) => e.inventoryLineId).sort()).toEqual([a.lineId, b.lineId].sort());
    expect(sold.find((e) => e.inventoryLineId === a.lineId)).toMatchObject({
      quantity: '2.000',
      actorId: who.userId,
    });
    expect(logs.join('\n')).not.toMatch(/Zacar|55667788|zq@example|3001234567/);
    // a failed sale leaves no sale event
    logs.length = 0;
    expect((await sell(who, cart.id)).status).toBe(409);
    expect(events('sale.created')).toHaveLength(0);
  });

  it('uppercase ids, NUL and existing endpoints keep working; identity tables are untouched', async () => {
    const { who, est } = await mkSeller();
    const lot = await mkLot(est, '1.00', '10');
    const { cart } = await cartWith(who, est, [[lot.lineId, '1']]);
    const usersBefore = (await pool.query('SELECT count(*) FROM users')).rows[0].count;
    const rolesBefore = (await pool.query('SELECT count(*) FROM role_permissions')).rows[0].count;
    const res = await sell(who, cart.id.toUpperCase(), { id: uuid().toUpperCase() });
    expect(res.status, res.raw).toBe(201);
    expect((await pool.query('SELECT count(*) FROM users')).rows[0].count).toBe(usersBefore);
    expect((await pool.query('SELECT count(*) FROM role_permissions')).rows[0].count).toBe(
      rolesBefore,
    );
    const fkTargets = await pool.query<{ target: string }>(
      `SELECT confrelid::regclass::text AS target FROM pg_constraint
       WHERE contype = 'f' AND conrelid IN ('sales'::regclass, 'sale_items'::regclass,
         'sale_counters'::regclass)`,
    );
    expect(fkTargets.rows.some((r) => ['users', 'roles', 'permissions'].includes(r.target))).toBe(
      false,
    );
    expect((await as(who, 'GET', `/sales?establishmentId=${est}%00`)).status).toBe(400);
    const cart2 = await mkCart(who, est);
    expect((await as(who, 'GET', `/carts/${cart2.id}`)).body).toMatchObject({
      status: 'open',
      soldAt: null,
      soldBy: null,
      saleId: null,
    });
    expect(
      (await as(who, 'GET', '/carts?status=open')).body.items.some(
        (c: { id: string }) => c.id === cart2.id,
      ),
    ).toBe(true);
    // the carts feed shows the sold cart with its sale
    const feed = await (async () => {
      for (let i = 0; i < 240; i++) {
        const page = await as(who, 'GET', '/carts/changes?limit=200');
        const found = (page.body.items as { id: string }[]).find((c) => c.id === cart.id);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return undefined;
    })();
    expect(feed).toMatchObject({ status: 'sold', saleId: res.body.id });
  });
});

describe('immutability (sprint 010, ADR-0006)', () => {
  const IMMUTABLE = { code: 'P0V01' };

  it('UPDATE and DELETE on sales and sale_items fail with P0V01 and change nothing', async () => {
    const { who, est } = await mkSeller();
    const lot = await mkLot(est, '10.00', '10');
    const { cart } = await cartWith(who, est, [[lot.lineId, '2']]);
    const sale = await sell(who, cart.id);
    expect(sale.status, sale.raw).toBe(201);
    const id = sale.body.id as string;
    const snapshot = async () => ({
      sale: (await pool.query('SELECT * FROM sales WHERE id = $1', [id])).rows,
      items: (await pool.query('SELECT * FROM sale_items WHERE sale_id = $1', [id])).rows,
    });
    const before = await snapshot();
    await expect(
      pool.query(`UPDATE sales SET total = 1 WHERE id = $1`, [id]),
    ).rejects.toMatchObject(IMMUTABLE);
    await expect(
      pool.query(`UPDATE sale_items SET quantity = 1 WHERE sale_id = $1`, [id]),
    ).rejects.toMatchObject(IMMUTABLE);
    await expect(
      pool.query('DELETE FROM sale_items WHERE sale_id = $1', [id]),
    ).rejects.toMatchObject(IMMUTABLE);
    await expect(pool.query('DELETE FROM sales WHERE id = $1', [id])).rejects.toMatchObject(
      IMMUTABLE,
    );
    expect(await snapshot()).toEqual(before);
    const names = await pool.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger WHERE tgname IN ('sales_immutable_trg', 'sale_items_immutable_trg')`,
    );
    expect(names.rows).toHaveLength(2);
  });
});

describe('sales of deactivated assigned establishments (sprint 010, RE-3, RE-4)', () => {
  /** A seller sells in `est`, then a reader with `sales.read` is assigned to it. */
  async function setupSold() {
    const seller = await mkSeller();
    const lot = await mkLot(seller.est, '5.00', '10');
    const { cart } = await cartWith(seller.who, seller.est, [[lot.lineId, '1']]);
    const sale = await sell(seller.who, cart.id);
    expect(sale.status, sale.raw).toBe(201);
    const reader = await actor(['sales.read']);
    await assignTo(reader, seller.est);
    return { seller, lot, cart, sale: sale.body as { id: string }, reader };
  }
  const ids = (res: Res) => (res.body.items as { id: string }[]).map((i) => i.id);
  const deactivate = (est: string) =>
    pool.query('UPDATE establishments SET is_active = false WHERE id = $1', [est]);

  it('CA-5: a reader assigned to a deactivated establishment still sees its sales', async () => {
    const w = await setupSold();
    await deactivate(w.seller.est);
    expect(ids(await as(w.reader, 'GET', '/sales'))).toEqual([w.sale.id]);
    expect(ids(await as(w.reader, 'GET', `/sales?establishmentId=${w.seller.est}`))).toEqual([
      w.sale.id,
    ]);
    expect((await as(w.reader, 'GET', `/sales/${w.sale.id}`)).status).toBe(200);
  });

  it('CA-6: with the assignment removed the sales are not listed and the sale is 404', async () => {
    const w = await setupSold();
    await deactivate(w.seller.est);
    await pool.query(
      'UPDATE establishment_users SET removed_at = now(), removed_by = user_id WHERE user_id = $1',
      [w.reader.userId],
    );
    expect(ids(await as(w.reader, 'GET', '/sales'))).toEqual([]);
    expect(await as(w.reader, 'GET', `/sales/${w.sale.id}`)).toMatchObject({
      status: 404,
      body: { code: 'SALE_NOT_FOUND' },
    });
    // never assigned: also hidden
    const stranger = await actor(['sales.read']);
    expect((await as(stranger, 'GET', `/sales/${w.sale.id}`)).status).toBe(404);
  });

  it('CA-7: operating in a deactivated establishment keeps failing as before', async () => {
    const w = await setupSold();
    const other = await mkLot(w.seller.est, '2.00', '5');
    const open = await cartWith(w.seller.who, w.seller.est, [[other.lineId, '1']]);
    await deactivate(w.seller.est);
    expect(await sell(w.seller.who, open.cart.id)).toMatchObject({
      status: 409,
      body: { code: 'ESTABLISHMENT_INACTIVE' },
    });
    expect(
      await as(w.seller.who, 'POST', '/carts', { establishmentId: w.seller.est }),
    ).toMatchObject({ status: 409, body: { code: 'ESTABLISHMENT_INACTIVE' } });
    const mine = await as(w.reader, 'GET', '/me/establishments');
    expect(mine.status, mine.raw).toBe(200);
    expect(ids(mine)).not.toContain(w.seller.est);
    // the seller still sees own sales; establishments.all sees everything as before
    expect(ids(await as(w.seller.who, 'GET', '/sales'))).toEqual([w.sale.id]);
    const all = await actor(['sales.read', 'establishments.all']);
    expect((await as(all, 'GET', `/sales/${w.sale.id}`)).status).toBe(200);
  });
});

describe('detail of a sold cart (sprint 010, RE-5, RE-6)', () => {
  it('CA-8: shows the frozen sale data after the product and the lot changed', async () => {
    const { who, est } = await mkSeller();
    const a = await mkLot(est, '12.34', '10');
    const b = await mkLot(est, '3.00', '5');
    const { cart } = await cartWith(who, est, [
      [a.lineId, '3'],
      [b.lineId, '1.500'],
    ]);
    const before = await as(who, 'GET', `/carts/${cart.id}`);
    const sale = await sell(who, cart.id);
    expect(sale.status, sale.raw).toBe(201);
    expect((await build('PATCH', `/products/${a.productId}`, { price: '99.00' })).status).toBe(200);
    await pool.query('UPDATE inventory_lines SET quantity_current = 0 WHERE id = $1', [b.lineId]);
    await pool.query('UPDATE inventory_lines SET is_active = false WHERE id = $1', [a.lineId]);
    const detail = await as(who, 'GET', `/carts/${cart.id}`);
    expect(detail.status, detail.raw).toBe(200);
    expect(Object.keys(detail.body).sort()).toEqual(Object.keys(before.body).sort());
    expect(detail.body).toMatchObject({
      status: 'sold',
      total: sale.body.total,
      unavailableCount: 0,
    });
    expect(detail.body.items).toHaveLength(2);
    const frozen = sale.body.items as {
      productId: string;
      unitPrice: string;
      quantity: string;
      subtotal: string;
    }[];
    for (const item of detail.body.items) {
      const sold = frozen.find((s) => s.productId === item.product.id)!;
      expect(item).toMatchObject({
        available: true,
        unavailableReason: null,
        quantity: sold.quantity,
        subtotal: sold.subtotal,
        product: { price: sold.unitPrice },
      });
    }
    const first = detail.body.items.find(
      (i: { product: { id: string } }) => i.product.id === a.productId,
    );
    expect(first.product.price).toBe('12.34');
    expect(first.subtotal).toBe('37.02');
    expect(Object.keys(first).sort()).toEqual(Object.keys(before.body.items[0]).sort());
  });

  it('CA-9: a sold cart without sale is an internal error logged as cart.sold_without_sale', async () => {
    const { who, est } = await mkSeller();
    const lot = await mkLot(est, '1.00', '10');
    const { cart } = await cartWith(who, est, [[lot.lineId, '1']]);
    await pool.query(
      `UPDATE carts SET status = 'sold', sold_at = now(), sold_by = $2 WHERE id = $1`,
      [cart.id, who.userId],
    );
    logs.length = 0;
    const res = await as(who, 'GET', `/carts/${cart.id}`);
    expect(res.status).toBe(500);
    expect(res.body).not.toHaveProperty('items');
    expect(events('cart.sold_without_sale')).toEqual([
      expect.objectContaining({ cartId: cart.id }),
    ]);
    await pool.query(
      `UPDATE carts SET status = 'open', sold_at = NULL, sold_by = NULL WHERE id = $1`,
      [cart.id],
    );
  });

  it('CA-10: open and cancelled carts keep the live availability', async () => {
    const { who, est } = await mkSeller();
    const lot = await mkLot(est, '4.00', '10');
    const { cart } = await cartWith(who, est, [[lot.lineId, '2']]);
    expect(await as(who, 'GET', `/carts/${cart.id}`)).toMatchObject({
      status: 200,
      body: { total: '8.00', unavailableCount: 0 },
    });
    expect((await build('PATCH', `/products/${lot.productId}`, { price: '5.00' })).status).toBe(
      200,
    );
    await pool.query('UPDATE inventory_lines SET is_active = false WHERE id = $1', [lot.lineId]);
    const open = await as(who, 'GET', `/carts/${cart.id}`);
    expect(open.body).toMatchObject({ total: '0.00', unavailableCount: 1 });
    expect(open.body.items[0]).toMatchObject({
      available: false,
      unavailableReason: 'LINE_INACTIVE',
      product: { price: '5.00' },
    });
    const cancelled = await as(who, 'PATCH', `/carts/${cart.id}/status`, { status: 'cancelled' });
    expect(cancelled.status, cancelled.raw).toBe(200);
    const after = await as(who, 'GET', `/carts/${cart.id}`);
    expect(after.body).toMatchObject({ status: 'cancelled', unavailableCount: 1 });
    expect(after.body.items[0].unavailableReason).toBe('LINE_INACTIVE');
  });
});
