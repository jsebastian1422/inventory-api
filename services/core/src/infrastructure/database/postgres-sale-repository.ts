import type { Pool, PoolClient } from 'pg';
import { cartNotFoundError, type CartStatus } from '../../domain/cart/cart.js';
import type {
  Customer,
  DocType,
  Sale,
  SaleItem,
  SaleUnavailableReason,
} from '../../domain/sale/sale.js';
import type {
  CheckoutInput,
  CheckoutOutcome,
  SaleFilter,
  SaleRepository,
} from '../../domain/sale/sale-repository.js';
import { compareDecimal, QUANTITY_SCALE, subtractDecimal } from '../../domain/shared/decimal.js';
import { conflictError, notFoundError } from '../../domain/shared/errors.js';
import type { ChangeBatch, ChangeCursor } from '../../domain/sync/change-cursor.js';
import { CART_COLUMNS, toCart, type CartRow } from './postgres-cart-repository.js';
import { isPgError, UNIQUE_VIOLATION, violatedConstraint } from './pool.js';
import { inTransaction, VersionedTable, type Db } from './versioned-table.js';

const NUMERIC_VALUE_OUT_OF_RANGE = '22003';
/** numeric(18,2) holds amounts below 10^16. */
const AMOUNT_LIMIT = '10000000000000000';

const COLUMNS = `id, cart_id, establishment_id, seller_id, number, customer_doc_type,
  customer_doc_number, customer_name, customer_email, customer_phone, total::text AS total,
  created_at, version`;

interface SaleRow {
  id: string;
  cart_id: string;
  establishment_id: string;
  seller_id: string;
  number: number;
  customer_doc_type: DocType | null;
  customer_doc_number: string | null;
  customer_name: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  // numeric is read as text and never converted to Number (ADR-0003)
  total: string;
  created_at: Date;
  version: number;
}

function toCustomer(row: SaleRow): Customer | null {
  if (row.customer_doc_type === null) return null;
  return {
    docType: row.customer_doc_type,
    docNumber: row.customer_doc_number!,
    name: row.customer_name!,
    email: row.customer_email,
    phone: row.customer_phone,
  };
}

/** A sale without its items (filled by `withItems`). */
function toSale(row: SaleRow): Sale {
  return {
    id: row.id,
    number: row.number,
    establishmentId: row.establishment_id,
    cartId: row.cart_id,
    sellerId: row.seller_id,
    customer: toCustomer(row),
    items: [],
    total: row.total,
    createdAt: row.created_at,
    version: row.version,
  };
}

interface ItemRow {
  id: string;
  sale_id: string;
  cart_item_id: string;
  inventory_line_id: string;
  product_id: string;
  sku: string;
  product_name: string;
  unit: string;
  barcode: string;
  expires_on: string | null;
  unit_price: string;
  quantity: string;
  subtotal: string;
}

const ITEM_SELECT = `SELECT si.id, si.sale_id, si.cart_item_id, si.inventory_line_id, si.product_id,
    si.sku, si.product_name, si.unit, si.barcode, to_char(si.expires_on, 'YYYY-MM-DD') AS expires_on,
    si.unit_price::text AS unit_price, si.quantity::text AS quantity, si.subtotal::text AS subtotal
  FROM sale_items si JOIN cart_items ci ON ci.id = si.cart_item_id`;

function toItem(row: ItemRow): SaleItem {
  return {
    id: row.id,
    cartItemId: row.cart_item_id,
    inventoryLineId: row.inventory_line_id,
    productId: row.product_id,
    sku: row.sku,
    productName: row.product_name,
    unit: row.unit,
    barcode: row.barcode,
    expiresOn: row.expires_on,
    unitPrice: row.unit_price,
    quantity: row.quantity,
    subtotal: row.subtotal,
  };
}

/** Active item of the cart with its lot, inventory and product, as locked by the checkout. */
interface Candidate {
  item_id: string;
  line_id: string;
  inventory_id: string;
  product_id: string;
  line_active: boolean;
  inventory_active: boolean;
  product_active: boolean;
  inventory_establishment_id: string;
  quantity_initial: string;
  quantity_current: string;
  quantity: string;
}

const CANDIDATES_SQL = `SELECT ci.id AS item_id, l.id AS line_id, l.inventory_id, l.product_id,
    l.is_active AS line_active, i.is_active AS inventory_active, p.is_active AS product_active,
    i.establishment_id AS inventory_establishment_id,
    l.quantity_initial::text AS quantity_initial, l.quantity_current::text AS quantity_current,
    ci.quantity::text AS quantity
  FROM cart_items ci
  JOIN inventory_lines l ON l.id = ci.inventory_line_id
  JOIN inventories i ON i.id = l.inventory_id
  JOIN products p ON p.id = l.product_id
  WHERE ci.cart_id = $1 AND ci.is_active
  ORDER BY ci.created_at, ci.id`;

function unavailableReason(
  candidate: Candidate,
  establishmentId: string,
): SaleUnavailableReason | null {
  if (!candidate.line_active) return 'LINE_INACTIVE';
  if (!candidate.inventory_active) return 'INVENTORY_INACTIVE';
  if (!candidate.product_active) return 'PRODUCT_INACTIVE';
  if (candidate.inventory_establishment_id !== establishmentId) return 'LINE_OTHER_ESTABLISHMENT';
  if (compareDecimal(candidate.quantity, candidate.quantity_current, QUANTITY_SCALE) > 0) {
    return 'INSUFFICIENT_STOCK';
  }
  return null;
}

export class PostgresSaleRepository implements SaleRepository {
  private readonly table = new VersionedTable<SaleRow, Sale>('sales', COLUMNS, toSale);

  constructor(private readonly pool: Pool) {}

  /** Fills the items of the sales (one query), in the order the items were added to the cart. */
  private async withItems(db: Db, sales: Sale[]): Promise<Sale[]> {
    if (sales.length === 0) return sales;
    const { rows } = await db.query<ItemRow>(
      `${ITEM_SELECT} WHERE si.sale_id = ANY($1::uuid[]) ORDER BY ci.created_at, si.id`,
      [sales.map((sale) => sale.id)],
    );
    return sales.map((sale) => ({
      ...sale,
      items: rows.filter((row) => row.sale_id === sale.id).map(toItem),
    }));
  }

  async findById(id: string): Promise<Sale | null> {
    return this.loadSale(this.pool, id);
  }

  private async loadSale(db: Db, id: string): Promise<Sale | null> {
    const sale = await this.table.findById(db, id);
    return sale ? ((await this.withItems(db, [sale]))[0] ?? null) : null;
  }

  async list(filter: SaleFilter): Promise<{ items: Sale[]; total: number }> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    const { sellerId, establishmentIds } = filter.visibility;
    if (establishmentIds !== 'all') {
      const clauses: string[] = [];
      if (sellerId !== undefined) {
        params.push(sellerId);
        clauses.push(`seller_id = $${params.length}`);
      }
      if (establishmentIds !== undefined) {
        params.push(establishmentIds);
        clauses.push(`establishment_id = ANY($${params.length}::uuid[])`);
      }
      conditions.push(clauses.length > 0 ? `(${clauses.join(' OR ')})` : 'false');
    }
    if (filter.establishmentId !== undefined) {
      params.push(filter.establishmentId);
      conditions.push(`establishment_id = $${params.length}`);
    }
    if (filter.sellerId !== undefined) {
      params.push(filter.sellerId);
      conditions.push(`seller_id = $${params.length}`);
    }
    if (filter.from !== undefined) {
      params.push(filter.from);
      conditions.push(`created_at >= ($${params.length}::date)::timestamp AT TIME ZONE 'UTC'`);
    }
    if (filter.to !== undefined) {
      params.push(filter.to);
      conditions.push(`created_at < (($${params.length}::date) + 1)::timestamp AT TIME ZONE 'UTC'`);
    }
    const page = await this.table.page(
      this.pool,
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
      params,
      'created_at DESC, id',
      filter.limit,
      filter.offset,
    );
    return { items: await this.withItems(this.pool, page.items), total: page.total };
  }

  async listChanges(
    cursor: ChangeCursor | null,
    limit: number,
    sellerId: string,
  ): Promise<ChangeBatch<Sale>> {
    const batch = await this.table.listFilteredChanges(
      this.pool,
      cursor,
      limit,
      'seller_id = $4::uuid',
      sellerId,
    );
    return { ...batch, items: await this.withItems(this.pool, batch.items) };
  }

  async checkout(input: CheckoutInput): Promise<CheckoutOutcome> {
    try {
      return await inTransaction(this.pool, (client) => this.checkoutIn(client, input));
    } catch (error) {
      if (isPgError(error, UNIQUE_VIOLATION)) {
        const constraint = violatedConstraint(error);
        if (constraint === 'sales_pkey') {
          throw conflictError('Ya existe una venta con ese id', 'SALE_ID_TAKEN');
        }
        if (constraint === 'sales_cart_id_key') {
          throw conflictError('El carrito no está abierto', 'CART_NOT_OPEN');
        }
      }
      if (isPgError(error, NUMERIC_VALUE_OUT_OF_RANGE)) throw amountOutOfRange();
      throw error;
    }
  }

  private async checkoutIn(client: PoolClient, input: CheckoutInput): Promise<CheckoutOutcome> {
    // Lock order (spec 3.1): cart -> establishment -> products -> inventories -> lines -> counter.
    const cart = await client.query<{
      status: CartStatus;
      establishment_id: string;
      version: number;
    }>('SELECT status, establishment_id, version FROM carts WHERE id = $1 FOR UPDATE', [
      input.cartId,
    ]);
    if (!cart.rows[0]) throw cartNotFoundError();
    const { establishment_id: establishmentId } = cart.rows[0];
    if (input.expectedVersion !== undefined && cart.rows[0].version !== input.expectedVersion) {
      const current = await client.query<CartRow>(
        `SELECT ${CART_COLUMNS} FROM carts WHERE id = $1`,
        [input.cartId],
      );
      return { status: 'conflict', current: toCart(current.rows[0]!) };
    }
    if (cart.rows[0].status !== 'open') {
      throw conflictError('El carrito no está abierto', 'CART_NOT_OPEN');
    }
    const establishment = await client.query<{ is_active: boolean }>(
      'SELECT is_active FROM establishments WHERE id = $1 FOR SHARE',
      [establishmentId],
    );
    if (!establishment.rows[0]) throw notFoundError('Establecimiento no encontrado');
    if (!establishment.rows[0].is_active) {
      throw conflictError('El establecimiento está inactivo', 'ESTABLISHMENT_INACTIVE');
    }

    const candidates = await this.lockItems(client, input.cartId);
    if (candidates.length === 0) {
      throw conflictError('El carrito no tiene ítems para vender', 'CART_EMPTY');
    }
    this.assertAvailable(candidates, establishmentId);
    const total = await this.totalOf(client, input.cartId);

    if (input.saleId !== undefined) {
      const taken = await client.query('SELECT 1 FROM sales WHERE id = $1', [input.saleId]);
      if (taken.rows.length > 0) {
        throw conflictError('Ya existe una venta con ese id', 'SALE_ID_TAKEN');
      }
    }
    // The counter row stays locked until the commit: no gaps, no repeated numbers (ADR-0005).
    const counter = await client.query<{ last_number: number }>(
      `INSERT INTO sale_counters (establishment_id, last_number) VALUES ($1, 1)
       ON CONFLICT (establishment_id) DO UPDATE SET last_number = sale_counters.last_number + 1
       RETURNING last_number`,
      [establishmentId],
    );
    const customer = input.customer;
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO sales (id, cart_id, establishment_id, seller_id, number, customer_doc_type,
         customer_doc_number, customer_name, customer_email, customer_phone, total, created_at)
       VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10,
         $11::numeric, $12)
       RETURNING id`,
      [
        input.saleId ?? null,
        input.cartId,
        establishmentId,
        input.actorId,
        counter.rows[0]!.last_number,
        customer?.docType ?? null,
        customer?.docNumber ?? null,
        customer?.name ?? null,
        customer?.email ?? null,
        customer?.phone ?? null,
        total,
        input.now,
      ],
    );
    const saleId = rows[0]!.id;
    await client.query(
      `INSERT INTO sale_items (sale_id, cart_item_id, inventory_line_id, product_id, sku,
         product_name, unit, barcode, expires_on, unit_price, quantity, subtotal)
       SELECT $2, ci.id, l.id, p.id, p.sku, p.name, p.unit, l.barcode, l.expires_on, p.price,
         ci.quantity, round(ci.quantity * p.price, 2)
       FROM cart_items ci
       JOIN inventory_lines l ON l.id = ci.inventory_line_id
       JOIN products p ON p.id = l.product_id
       WHERE ci.cart_id = $1 AND ci.is_active`,
      [input.cartId, saleId],
    );
    for (const candidate of candidates) {
      await this.discount(client, candidate, saleId, input);
    }
    await client.query(
      `UPDATE carts SET status = 'sold', sold_at = $2, sold_by = $3, updated_at = $2,
         version = version + 1, change_xid = pg_current_xact_id()
       WHERE id = $1`,
      [input.cartId, input.now, input.actorId],
    );
    const sale = await this.loadSale(client, saleId);
    return { status: 'sold', sale: sale! };
  }

  /**
   * Active items and, in the R-8 order, their products and inventories FOR SHARE and their lines
   * FOR UPDATE (ids ascending inside each kind), then the items as they are under those locks.
   */
  private async lockItems(client: PoolClient, cartId: string): Promise<Candidate[]> {
    const unlocked = await client.query<Candidate>(CANDIDATES_SQL, [cartId]);
    if (unlocked.rows.length === 0) return [];
    const unique = (values: string[]) => [...new Set(values)];
    await client.query('SELECT id FROM products WHERE id = ANY($1::uuid[]) ORDER BY id FOR SHARE', [
      unique(unlocked.rows.map((row) => row.product_id)),
    ]);
    await client.query(
      'SELECT id FROM inventories WHERE id = ANY($1::uuid[]) ORDER BY id FOR SHARE',
      [unique(unlocked.rows.map((row) => row.inventory_id))],
    );
    await client.query(
      'SELECT id FROM inventory_lines WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
      [unique(unlocked.rows.map((row) => row.line_id))],
    );
    return (await client.query<Candidate>(CANDIDATES_SQL, [cartId])).rows;
  }

  /** All or nothing (R-3): 409 listing every item that cannot be sold. */
  private assertAvailable(candidates: Candidate[], establishmentId: string): void {
    const details = candidates.flatMap((candidate) => {
      const reason = unavailableReason(candidate, establishmentId);
      return reason === null
        ? []
        : [
            {
              itemId: candidate.item_id,
              inventoryLineId: candidate.line_id,
              reason,
              available: candidate.quantity_current,
              requested: candidate.quantity,
            },
          ];
    });
    if (details.length > 0) {
      throw conflictError(
        'Algunos ítems del carrito no están disponibles',
        'SALE_ITEMS_UNAVAILABLE',
        undefined,
        details,
      );
    }
  }

  /** Sum of the rounded subtotals, in SQL (ADR-0003); 409 when it does not fit numeric(18,2). */
  private async totalOf(client: PoolClient, cartId: string): Promise<string> {
    const { rows } = await client.query<{ total: string; out_of_range: boolean }>(
      `SELECT t.total::text AS total, t.total >= ${AMOUNT_LIMIT}::numeric AS out_of_range
       FROM (
         SELECT COALESCE(sum(round(ci.quantity * p.price, 2)), 0) AS total
         FROM cart_items ci
         JOIN inventory_lines l ON l.id = ci.inventory_line_id
         JOIN products p ON p.id = l.product_id
         WHERE ci.cart_id = $1 AND ci.is_active
       ) t`,
      [cartId],
    );
    if (rows[0]!.out_of_range) throw amountOutOfRange();
    return rows[0]!.total;
  }

  /** Reduces the current quantity of the lot (never the initial one) and records the history. */
  private async discount(
    client: PoolClient,
    candidate: Candidate,
    saleId: string,
    input: CheckoutInput,
  ): Promise<void> {
    const updated = await client.query<{ quantity_current: string }>(
      `UPDATE inventory_lines SET quantity_current = quantity_current - $2::numeric,
         version = version + 1, change_xid = pg_current_xact_id(), updated_at = $3
       WHERE id = $1 RETURNING quantity_current::text AS quantity_current`,
      [candidate.line_id, candidate.quantity, input.now],
    );
    await client.query(
      `INSERT INTO inventory_line_history (line_id, reason, initial_before, initial_after,
         current_before, current_after, delta, sale_id, actor_id, changed_at)
       VALUES ($1, 'sale', $2, $2, $3, $4, $5, $6, $7, now())`,
      [
        candidate.line_id,
        candidate.quantity_initial,
        candidate.quantity_current,
        updated.rows[0]!.quantity_current,
        subtractDecimal('0', candidate.quantity, QUANTITY_SCALE),
        saleId,
        input.actorId,
      ],
    );
  }
}

const amountOutOfRange = () =>
  conflictError('El total de la venta excede el máximo permitido', 'SALE_AMOUNT_OUT_OF_RANGE');
