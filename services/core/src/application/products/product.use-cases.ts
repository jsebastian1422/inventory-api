import {
  changedProductFields,
  normalizeNewProduct,
  normalizeProductChanges,
  priceChanged,
  type PriceChange,
  type Product,
  type ProductChanges,
  type ProductInput,
} from '../../domain/product/product.js';
import type { ProductFilter, ProductRepository } from '../../domain/product/product-repository.js';
import type { AuditLog } from '../../domain/shared/audit-log.js';
import { validationError } from '../../domain/shared/errors.js';
import { ResourceUseCases } from '../shared/resource-use-cases.js';

/** Product use cases. Every write records an audit event with `productId` and `actorId`. */
export class ProductUseCases extends ResourceUseCases<Product> {
  constructor(
    private readonly products: ProductRepository,
    log: AuditLog,
    now: () => Date = () => new Date(),
  ) {
    super(
      products,
      log,
      {
        event: 'product',
        idKey: 'productId',
        notFound: 'Producto no encontrado',
        versionConflict: 'El producto cambió en el servidor; revisa la versión actual',
      },
      now,
    );
  }

  /** `id` is the optional client-generated identifier (offline creation). */
  async create(actorId: string, input: ProductInput, id?: string): Promise<Product> {
    const data = normalizeNewProduct(input);
    // Uniqueness (id, SKU) is detected last, by the repository, after the category checks (spec §6).
    const created = await this.products.create(data, actorId, id);
    this.event('created', created.id, actorId);
    return created;
  }

  list(filter: ProductFilter): Promise<{ items: Product[]; total: number }> {
    return this.products.list(filter);
  }

  /** `expectedVersion` (If-Match) makes the edit conditional; a stale one is a 409 VERSION_CONFLICT. */
  async update(
    actorId: string,
    id: string,
    input: ProductChanges,
    expectedVersion?: number,
  ): Promise<Product> {
    const changes = normalizeProductChanges(input);
    if (Object.keys(changes).length === 0) {
      throw validationError('Indica al menos un campo a modificar');
    }
    const current = await this.get(id);
    this.assertVersion(actorId, current, expectedVersion);
    const outcome = await this.products.update(id, changes, actorId, this.now(), expectedVersion);
    const updated = this.unwrap(actorId, id, expectedVersion, outcome);
    this.event('updated', id, actorId, { fields: changedProductFields(current, changes) });
    if (priceChanged(current, changes)) this.event('price_changed', id, actorId);
    return updated;
  }

  /** Idempotent: asking for the current state answers the product without an event. */
  async setStatus(
    actorId: string,
    id: string,
    isActive: boolean,
    expectedVersion?: number,
  ): Promise<Product> {
    const current = await this.get(id);
    this.assertVersion(actorId, current, expectedVersion);
    if (current.isActive === isActive) return current;
    const outcome = await this.products.setActive(id, isActive, this.now(), expectedVersion);
    const updated = this.unwrap(actorId, id, expectedVersion, outcome);
    this.event(isActive ? 'activated' : 'deactivated', id, actorId);
    return updated;
  }

  /** Price history of a product (404 when the product does not exist), most recent first. */
  async priceHistory(
    id: string,
    limit: number,
    offset: number,
  ): Promise<{ items: PriceChange[]; total: number }> {
    await this.get(id);
    return this.products.listPriceHistory(id, limit, offset);
  }
}
