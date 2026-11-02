import type { Pool } from 'pg';
import {
  cartNotFoundError,
  SoldCartWithoutSaleError,
  type Cart,
  type CartDetail,
  type CartDetailItem,
  type CartStatus,
  type UnavailableReason,
} from '../../domain/cart/cart.js';
import type {
  CartFilter,
  CartRepository,
  EffectiveOutcome,
} from '../../domain/cart/cart-repository.js';
import { conflictError, notFoundError } from '../../domain/shared/errors.js';
import type { ChangeBatch, ChangeCursor } from '../../domain/sync/change-cursor.js';
import { FOREIGN_KEY_VIOLATION, isPgError, UNIQUE_VIOLATION } from './pool.js';
import { inTransaction, VersionedTable } from './versioned-table.js';

const COLUMNS = `id, establishment_id, created_by, status, cancelled_by, cancelled_at, sold_by, sold_at,
  (SELECT s.id FROM sales s WHERE s.cart_id = carts.id) AS sale_id, version, created_at, updated_at`;

interface CartRow {
  id: string;
  establishment_id: string;
  created_by: string;
  status: CartStatus;
  cancelled_by: string | null;
  cancelled_at: Date | null;
  sold_by: string | null;
  sold_at: Date | null;
  sale_id: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

function toCart(row: CartRow): Cart {
  return {
    id: row.id,
    establishmentId: row.establishment_id,
    createdBy: row.created_by,
    status: row.status,
    cancelledBy: row.cancelled_by,
    cancelledAt: row.cancelled_at,
    soldBy: row.sold_by,
    soldAt: row.sold_at,
    saleId: row.sale_id,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface DetailRow {
  id: string;
  version: number;
  quantity: string;
  line_id: string;
  barcode: string;
  expires_on: string | null;
  // numeric is read as text and never converted to Number (ADR-0003)
  quantity_current: string;
  product_id: string;
  sku: string;
  product_name: string;
  unit: string;
  price: string;
  subtotal: string;
  unavailable_reason: UnavailableReason | null;
  total: string;
}

/**
 * Active items with product, lot and availability. The subtotal is round(quantity x price, 2)
 * (numeric rounding is half away from zero: half-up for these positive values) and the total is the
 * sum of the subtotals of the available items, both calculated here and never with `Number`.
 */
const DETAIL_SQL = `SELECT d.*,
    round(COALESCE(sum(d.subtotal) FILTER (WHERE d.unavailable_reason IS NULL) OVER (), 0), 2)::text AS total
  FROM (
    SELECT ci.id, ci.version, ci.quantity::text AS quantity, l.id AS line_id, l.barcode,
      to_char(l.expires_on, 'YYYY-MM-DD') AS expires_on,
      l.quantity_current::text AS quantity_current,
      p.id AS product_id, p.sku, p.name AS product_name, p.unit, p.price::text AS price,
      round(ci.quantity * p.price, 2) AS subtotal,
      CASE
        WHEN NOT l.is_active THEN 'LINE_INACTIVE'
        WHEN NOT i.is_active THEN 'INVENTORY_INACTIVE'
        WHEN NOT p.is_active THEN 'PRODUCT_INACTIVE'
        WHEN ci.quantity > l.quantity_current THEN 'INSUFFICIENT_STOCK'
      END AS unavailable_reason,
      ci.created_at AS item_created_at
    FROM cart_items ci
    JOIN inventory_lines l ON l.id = ci.inventory_line_id
    JOIN inventories i ON i.id = l.inventory_id
    JOIN products p ON p.id = l.product_id
    WHERE ci.cart_id = $1 AND ci.is_active
  ) d
  ORDER BY d.item_created_at, d.id`;

interface SoldDetailRow extends DetailRow {
  sale_total: string;
}

/**
 * Detail of a `sold` cart from the frozen data of its sale (sprint 010): product and price as
 * sold, quantity and subtotal of the sale; only `quantity_current` of the lot is live.
 */
const SOLD_DETAIL_SQL = `SELECT ci.id, ci.version, si.quantity::text AS quantity,
    si.inventory_line_id AS line_id, si.barcode, to_char(si.expires_on, 'YYYY-MM-DD') AS expires_on,
    l.quantity_current::text AS quantity_current,
    si.product_id, si.sku, si.product_name, si.unit, si.unit_price::text AS price,
    si.subtotal::text AS subtotal, NULL::text AS unavailable_reason, s.total::text AS sale_total
  FROM sale_items si
  JOIN sales s ON s.id = si.sale_id AND s.cart_id = $1
  JOIN cart_items ci ON ci.id = si.cart_item_id
  JOIN inventory_lines l ON l.id = si.inventory_line_id
  ORDER BY ci.created_at, ci.id`;

function toDetailItem(row: DetailRow): CartDetailItem {
  return {
    id: row.id,
    version: row.version,
    product: {
      id: row.product_id,
      sku: row.sku,
      name: row.product_name,
      unit: row.unit,
      price: row.price,
    },
    line: {
      id: row.line_id,
      barcode: row.barcode,
      expiresOn: row.expires_on,
      quantityCurrent: row.quantity_current,
    },
    quantity: row.quantity,
    subtotal: row.subtotal,
    available: row.unavailable_reason === null,
    unavailableReason: row.unavailable_reason,
  };
}

const EMPTY_TOTAL = '0.00';

export class PostgresCartRepository implements CartRepository {
  private readonly table = new VersionedTable<CartRow, Cart>('carts', COLUMNS, toCart);

  constructor(private readonly pool: Pool) {}

  async create(establishmentId: string, actorId: string, id?: string): Promise<Cart> {
    try {
      return await inTransaction(this.pool, async (client) => {
        const establishment = await client.query<{ is_active: boolean }>(
          'SELECT is_active FROM establishments WHERE id = $1 FOR SHARE',
          [establishmentId],
        );
        if (!establishment.rows[0]) throw notFoundError('Establecimiento no encontrado');
        if (!establishment.rows[0].is_active) {
          throw conflictError('El establecimiento está inactivo', 'ESTABLISHMENT_INACTIVE');
        }
        const { rows } = await client.query<CartRow>(
          `INSERT INTO carts (id, establishment_id, created_by)
           VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3) RETURNING ${COLUMNS}`,
          [id ?? null, establishmentId, actorId],
        );
        return toCart(rows[0]!);
      });
    } catch (error) {
      if (isPgError(error, UNIQUE_VIOLATION)) {
        throw conflictError('Ya existe un carrito con ese id', 'CART_ID_TAKEN');
      }
      if (isPgError(error, FOREIGN_KEY_VIOLATION)) {
        throw notFoundError('Establecimiento no encontrado');
      }
      throw error;
    }
  }

  findById(id: string): Promise<Cart | null> {
    return this.table.findById(this.pool, id);
  }

  async findDetail(id: string): Promise<CartDetail | null> {
    const cart = await this.table.findById(this.pool, id);
    if (!cart) return null;
    if (cart.status === 'sold') return this.soldDetail(cart);
    const { rows } = await this.pool.query<DetailRow>(DETAIL_SQL, [id]);
    return {
      cart,
      items: rows.map(toDetailItem),
      total: rows[0]?.total ?? EMPTY_TOTAL,
      unavailableCount: rows.filter((row) => row.unavailable_reason !== null).length,
    };
  }

  private async soldDetail(cart: Cart): Promise<CartDetail> {
    const sale = await this.pool.query<{ total: string }>(
      'SELECT total::text AS total FROM sales WHERE cart_id = $1',
      [cart.id],
    );
    if (!sale.rows[0]) throw new SoldCartWithoutSaleError(cart.id);
    const { rows } = await this.pool.query<SoldDetailRow>(SOLD_DETAIL_SQL, [cart.id]);
    return {
      cart,
      items: rows.map(toDetailItem),
      total: sale.rows[0].total,
      unavailableCount: 0,
    };
  }

  list(filter: CartFilter): Promise<{ items: Cart[]; total: number }> {
    const conditions = ['created_by = $1'];
    const params: unknown[] = [filter.createdBy];
    if (filter.status) {
      params.push(filter.status);
      conditions.push(`status = $${params.length}`);
    }
    if (filter.establishmentId) {
      params.push(filter.establishmentId);
      conditions.push(`establishment_id = $${params.length}`);
    }
    return this.table.page(
      this.pool,
      `WHERE ${conditions.join(' AND ')}`,
      params,
      'created_at DESC, id',
      filter.limit,
      filter.offset,
    );
  }

  async cancel(
    id: string,
    actorId: string,
    now: Date,
    expectedVersion?: number,
  ): Promise<EffectiveOutcome<Cart>> {
    return inTransaction(this.pool, async (client): Promise<EffectiveOutcome<Cart>> => {
      const current = await this.table.findById(client, id, 'FOR UPDATE');
      if (!current) return { status: 'not_found' };
      if (expectedVersion !== undefined && current.version !== expectedVersion) {
        return { status: 'conflict', current };
      }
      if (current.status === 'sold') {
        throw conflictError('El carrito no está abierto', 'CART_NOT_OPEN');
      }
      if (current.status === 'cancelled')
        return { status: 'updated', value: current, changed: false };
      const outcome = await this.table.conditionalUpdate(
        client,
        ["status = 'cancelled'", 'cancelled_by = $4', 'cancelled_at = $2', 'updated_at = $2'],
        [id, now, expectedVersion ?? null, actorId],
      );
      if (outcome.status === 'updated') return { ...outcome, changed: true };
      if (outcome.status === 'conflict') return outcome;
      throw cartNotFoundError();
    });
  }

  listChanges(
    cursor: ChangeCursor | null,
    limit: number,
    createdBy: string,
  ): Promise<ChangeBatch<Cart>> {
    return this.table.listFilteredChanges(
      this.pool,
      cursor,
      limit,
      'created_by = $4::uuid',
      createdBy,
    );
  }
}

export { COLUMNS as CART_COLUMNS, toCart };
export type { CartRow };
