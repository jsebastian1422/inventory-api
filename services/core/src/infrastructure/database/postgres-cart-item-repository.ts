import type { Pool, PoolClient } from 'pg';
import type { EffectiveOutcome } from '../../domain/cart/cart-repository.js';
import { cartNotFoundError, type CartStatus } from '../../domain/cart/cart.js';
import type { CartItem, NewCartItem } from '../../domain/cart-item/cart-item.js';
import type { CartItemRepository } from '../../domain/cart-item/cart-item-repository.js';
import { addDecimal, compareDecimal, QUANTITY_SCALE } from '../../domain/shared/decimal.js';
import { conflictError, notFoundError } from '../../domain/shared/errors.js';
import type { ChangeBatch, ChangeCursor } from '../../domain/sync/change-cursor.js';
import { isPgError, UNIQUE_VIOLATION, violatedConstraint } from './pool.js';
import { inTransaction, VersionedTable } from './versioned-table.js';

const COLUMNS = `id, cart_id, inventory_line_id, quantity::text AS quantity, is_active, version,
  created_at, updated_at`;

interface ItemRow {
  id: string;
  cart_id: string;
  inventory_line_id: string;
  // numeric is read as text and never converted to Number (ADR-0003)
  quantity: string;
  is_active: boolean;
  version: number;
  created_at: Date;
  updated_at: Date;
}

function toItem(row: ItemRow): CartItem {
  return {
    id: row.id,
    cartId: row.cart_id,
    inventoryLineId: row.inventory_line_id,
    quantity: row.quantity,
    isActive: row.is_active,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface LockedCart {
  readonly status: CartStatus;
  readonly establishmentId: string;
}

/** Line, inventory and product read under FOR SHARE locks in the same transaction. */
interface LockedLine {
  readonly lineActive: boolean;
  readonly quantityCurrent: string;
  readonly inventoryActive: boolean;
  readonly inventoryEstablishmentId: string;
  readonly productActive: boolean;
}

const LINE_NOT_FOUND = 'Línea de inventario no encontrada';

export class PostgresCartItemRepository implements CartItemRepository {
  private readonly table = new VersionedTable<ItemRow, CartItem>('cart_items', COLUMNS, toItem);

  constructor(private readonly pool: Pool) {}

  findById(id: string): Promise<CartItem | null> {
    return this.table.findById(this.pool, id);
  }

  /** First lock of every item write (carrito -> linea): serializes writes and cancellation. */
  private async lockCart(client: PoolClient, cartId: string): Promise<LockedCart> {
    const { rows } = await client.query<{ status: CartStatus; establishment_id: string }>(
      'SELECT status, establishment_id FROM carts WHERE id = $1 FOR UPDATE',
      [cartId],
    );
    if (!rows[0]) throw cartNotFoundError();
    return { status: rows[0].status, establishmentId: rows[0].establishment_id };
  }

  private assertOpen(cart: LockedCart): void {
    if (cart.status !== 'open') {
      throw conflictError('El carrito no está abierto', 'CART_NOT_OPEN');
    }
  }

  /**
   * Locks product, inventory and then the line FOR SHARE (R-8 order, as the line writes of sprint
   * 005), so that deactivating any of them or adjusting the stock cannot cross this write.
   */
  private async lockLine(client: PoolClient, lineId: string): Promise<LockedLine> {
    const unlocked = await client.query<{ inventory_id: string; product_id: string }>(
      'SELECT inventory_id, product_id FROM inventory_lines WHERE id = $1',
      [lineId],
    );
    if (!unlocked.rows[0]) throw notFoundError(LINE_NOT_FOUND);
    const { inventory_id: inventoryId, product_id: productId } = unlocked.rows[0];
    const product = await client.query<{ is_active: boolean }>(
      'SELECT is_active FROM products WHERE id = $1 FOR SHARE',
      [productId],
    );
    const inventory = await client.query<{ is_active: boolean; establishment_id: string }>(
      'SELECT is_active, establishment_id FROM inventories WHERE id = $1 FOR SHARE',
      [inventoryId],
    );
    const line = await client.query<{ is_active: boolean; quantity_current: string }>(
      'SELECT is_active, quantity_current::text AS quantity_current FROM inventory_lines WHERE id = $1 FOR SHARE',
      [lineId],
    );
    if (!line.rows[0] || !inventory.rows[0] || !product.rows[0])
      throw notFoundError(LINE_NOT_FOUND);
    return {
      lineActive: line.rows[0].is_active,
      quantityCurrent: line.rows[0].quantity_current,
      inventoryActive: inventory.rows[0].is_active,
      inventoryEstablishmentId: inventory.rows[0].establishment_id,
      productActive: product.rows[0].is_active,
    };
  }

  /** The lot must belong to the establishment of the cart and be usable (spec 3.3). */
  private assertLineUsable(cart: LockedCart, line: LockedLine): void {
    if (line.inventoryEstablishmentId !== cart.establishmentId) {
      throw conflictError(
        'La línea de inventario pertenece a otro local',
        'CART_LINE_OTHER_ESTABLISHMENT',
      );
    }
    if (!line.lineActive) {
      throw conflictError('La línea de inventario está inactiva', 'INVENTORY_LINE_INACTIVE');
    }
    if (!line.inventoryActive)
      throw conflictError('El inventario está inactivo', 'INVENTORY_INACTIVE');
    if (!line.productActive) throw conflictError('El producto está inactivo', 'PRODUCT_INACTIVE');
  }

  /** Stock is validated, not reserved (R-3). */
  private assertStock(lineId: string, quantity: string, line: LockedLine): void {
    if (compareDecimal(quantity, line.quantityCurrent, QUANTITY_SCALE) > 0) {
      throw conflictError(
        'La cantidad supera las existencias del lote',
        'INSUFFICIENT_STOCK',
        undefined,
        [{ inventoryLineId: lineId, available: line.quantityCurrent, requested: quantity }],
      );
    }
  }

  /** The cart changes version when its content changes, so the carts feed reflects it. */
  private async touchCart(client: PoolClient, cartId: string, now: Date): Promise<void> {
    await client.query(
      `UPDATE carts SET updated_at = $2, version = version + 1, change_xid = pg_current_xact_id()
       WHERE id = $1`,
      [cartId, now],
    );
  }

  async add(
    cartId: string,
    data: NewCartItem,
    now: Date,
    id?: string,
  ): Promise<{ item: CartItem; created: boolean; reactivated: boolean }> {
    try {
      return await inTransaction(this.pool, async (client) => {
        const cart = await this.lockCart(client, cartId);
        this.assertOpen(cart);
        const line = await this.lockLine(client, data.inventoryLineId);
        this.assertLineUsable(cart, line);
        // The cart lock serializes every write of its items: the existing item cannot change.
        const existing = await client.query<ItemRow>(
          `SELECT ${COLUMNS} FROM cart_items WHERE cart_id = $1 AND inventory_line_id = $2 FOR UPDATE`,
          [cartId, data.inventoryLineId],
        );
        const previous = existing.rows[0] ? toItem(existing.rows[0]) : null;
        const quantity = previous?.isActive
          ? addDecimal(previous.quantity, data.quantity, QUANTITY_SCALE)
          : data.quantity;
        this.assertStock(data.inventoryLineId, quantity, line);
        if (id !== undefined) {
          const taken = await client.query('SELECT 1 FROM cart_items WHERE id = $1', [id]);
          if (taken.rows.length > 0) {
            throw conflictError('Ya existe un ítem con ese id', 'CART_ITEM_ID_TAKEN');
          }
        }
        if (previous) {
          const outcome = await this.table.conditionalUpdate(
            client,
            ['updated_at = $2', 'quantity = $4', 'is_active = true'],
            [previous.id, now, null, quantity],
          );
          if (outcome.status !== 'updated') throw notFoundError('Ítem de carrito no encontrado');
          await this.touchCart(client, cartId, now);
          return { item: outcome.value, created: false, reactivated: !previous.isActive };
        }
        const { rows } = await client.query<ItemRow>(
          `INSERT INTO cart_items (id, cart_id, inventory_line_id, quantity, created_at, updated_at)
           VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $5)
           RETURNING ${COLUMNS}`,
          [id ?? null, cartId, data.inventoryLineId, quantity, now],
        );
        await this.touchCart(client, cartId, now);
        return { item: toItem(rows[0]!), created: true, reactivated: false };
      });
    } catch (error) {
      if (isPgError(error, UNIQUE_VIOLATION) && violatedConstraint(error) === 'cart_items_pkey') {
        throw conflictError('Ya existe un ítem con ese id', 'CART_ITEM_ID_TAKEN');
      }
      throw error;
    }
  }

  /**
   * Common frame of the item edits: locks the cart, then the item; version check (409 before the
   * state of the cart, spec 6); the cart must be open. `change` runs with both rows locked.
   */
  private async edit(
    id: string,
    expectedVersion: number | undefined,
    now: Date,
    change: (
      client: PoolClient,
      current: CartItem,
      cart: LockedCart,
    ) => Promise<{ sets: string[]; extra: unknown[] } | null>,
  ): Promise<EffectiveOutcome<CartItem>> {
    return inTransaction(this.pool, async (client): Promise<EffectiveOutcome<CartItem>> => {
      const unlocked = await this.table.findById(client, id);
      if (!unlocked) return { status: 'not_found' };
      const cart = await this.lockCart(client, unlocked.cartId);
      const current = await this.table.findById(client, id, 'FOR UPDATE');
      if (!current) return { status: 'not_found' };
      if (expectedVersion !== undefined && current.version !== expectedVersion) {
        return { status: 'conflict', current };
      }
      this.assertOpen(cart);
      const update = await change(client, current, cart);
      if (!update) return { status: 'updated', value: current, changed: false };
      const outcome = await this.table.conditionalUpdate(
        client,
        ['updated_at = $2', ...update.sets],
        [id, now, null, ...update.extra],
      );
      if (outcome.status !== 'updated') return outcome;
      await this.touchCart(client, current.cartId, now);
      return { status: 'updated', value: outcome.value, changed: true };
    });
  }

  setQuantity(
    id: string,
    quantity: string,
    now: Date,
    expectedVersion?: number,
  ): Promise<EffectiveOutcome<CartItem>> {
    return this.edit(id, expectedVersion, now, async (client, current, cart) => {
      const direction = compareDecimal(quantity, current.quantity, QUANTITY_SCALE);
      if (direction === 0) return null;
      // R-8: lowering is always allowed, even for an unavailable item; only raising is validated.
      if (direction > 0) {
        const line = await this.lockLine(client, current.inventoryLineId);
        this.assertLineUsable(cart, line);
        this.assertStock(current.inventoryLineId, quantity, line);
      }
      return { sets: ['quantity = $4'], extra: [quantity] };
    });
  }

  setActive(
    id: string,
    isActive: boolean,
    now: Date,
    expectedVersion?: number,
  ): Promise<EffectiveOutcome<CartItem>> {
    return this.edit(id, expectedVersion, now, async (client, current, cart) => {
      if (current.isActive === isActive) return null;
      if (isActive) {
        const line = await this.lockLine(client, current.inventoryLineId);
        this.assertLineUsable(cart, line);
        this.assertStock(current.inventoryLineId, current.quantity, line);
      }
      return { sets: ['is_active = $4'], extra: [isActive] };
    });
  }

  listChanges(
    cursor: ChangeCursor | null,
    limit: number,
    createdBy: string,
  ): Promise<ChangeBatch<CartItem>> {
    return this.table.listFilteredChanges(
      this.pool,
      cursor,
      limit,
      'cart_id IN (SELECT c.id FROM carts c WHERE c.created_by = $4::uuid)',
      createdBy,
    );
  }
}
