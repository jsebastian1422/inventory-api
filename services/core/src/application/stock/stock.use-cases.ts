import type { Inventory } from '../../domain/inventory/inventory.js';
import type { InventoryLine } from '../../domain/inventory-line/inventory-line.js';
import type { Product } from '../../domain/product/product.js';
import type { ProductRepository } from '../../domain/product/product-repository.js';
import type { Actor, ScopedRecord } from '../../domain/scope/scope.js';
import type { StockCriteria, StockResult } from '../../domain/stock/stock.js';
import type { StockRepository } from '../../domain/stock/stock-repository.js';
import {
  decodeCursor,
  encodeCursor,
  type ChangeBatch,
  type ChangeCursor,
  type ChangePage,
} from '../../domain/sync/change-cursor.js';
import type { ScopeUseCases } from '../scope/scope.use-cases.js';

/** Stock search and offline feeds limited to the actor's establishments (ADR-0004). Not audited. */
export class StockUseCases {
  constructor(
    private readonly scope: ScopeUseCases,
    private readonly stock: StockRepository,
    private readonly products: ProductRepository,
  ) {}

  /** Order: establishment 404 -> inactive 409 -> outside the scope 403 (live scope). */
  async search(
    actor: Actor,
    establishmentId: string,
    criteria: StockCriteria,
    limit: number,
    offset: number,
  ): Promise<{ items: StockResult[]; total: number }> {
    await this.scope.assertInScope(actor, establishmentId);
    return this.stock.search(establishmentId, criteria, limit, offset);
  }

  async inventoryChanges(
    actor: Actor,
    cursor: string | undefined,
    limit: number,
  ): Promise<ChangePage<ScopedRecord<Inventory>>> {
    const from = parse(cursor);
    const { ids } = await this.scope.resolve(actor);
    return page(from, await this.stock.listInventoryChanges(from, limit, ids));
  }

  async lineChanges(
    actor: Actor,
    cursor: string | undefined,
    limit: number,
  ): Promise<ChangePage<ScopedRecord<InventoryLine>>> {
    const from = parse(cursor);
    const { ids } = await this.scope.resolve(actor);
    return page(from, await this.stock.listLineChanges(from, limit, ids));
  }

  /** The catalog is global (it belongs to no establishment): same feed as `/products/changes`. */
  async productChanges(cursor: string | undefined, limit: number): Promise<ChangePage<Product>> {
    const from = parse(cursor);
    return page(from, await this.products.listChanges(from, limit));
  }
}

/** Decodes the opaque cursor (400 when malformed). */
function parse(cursor: string | undefined): ChangeCursor | null {
  return cursor === undefined ? null : decodeCursor(cursor);
}

function page<T>(from: ChangeCursor | null, batch: ChangeBatch<T>): ChangePage<T> {
  const position = batch.last ?? from;
  return {
    items: batch.items,
    nextCursor: position ? encodeCursor(position) : null,
    hasMore: batch.hasMore,
  };
}
