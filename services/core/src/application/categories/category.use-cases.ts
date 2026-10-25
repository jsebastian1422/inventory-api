import {
  changedCategoryFields,
  normalizeCategoryChanges,
  normalizeNewCategory,
  type Category,
  type CategoryChanges,
  type CategoryInput,
} from '../../domain/category/category.js';
import type {
  CategoryFilter,
  CategoryRepository,
} from '../../domain/category/category-repository.js';
import type { AuditLog } from '../../domain/shared/audit-log.js';
import { conflictError, validationError } from '../../domain/shared/errors.js';
import { ResourceUseCases } from '../shared/resource-use-cases.js';

const CODE_TAKEN = 'Ya existe una categoría con ese código';
const NAME_TAKEN = 'Ya existe una categoría con ese nombre';

/** Category use cases. Every write records an audit event with `categoryId` and `actorId`. */
export class CategoryUseCases extends ResourceUseCases<Category> {
  constructor(
    private readonly categories: CategoryRepository,
    log: AuditLog,
    now: () => Date = () => new Date(),
  ) {
    super(
      categories,
      log,
      {
        event: 'category',
        idKey: 'categoryId',
        notFound: 'Categoría no encontrada',
        versionConflict: 'La categoría cambió en el servidor; revisa la versión actual',
      },
      now,
    );
  }

  /** `id` is the optional client-generated identifier (offline creation). */
  async create(actorId: string, input: CategoryInput, id?: string): Promise<Category> {
    const data = normalizeNewCategory(input);
    if (id !== undefined && (await this.categories.findById(id))) {
      throw conflictError('Ya existe una categoría con ese id', 'CATEGORY_ID_TAKEN');
    }
    await this.assertUnique(data);
    const created = await this.categories.create(data, id);
    this.event('created', created.id, actorId);
    return created;
  }

  list(filter: CategoryFilter): Promise<{ items: Category[]; total: number }> {
    return this.categories.list(filter);
  }

  /** `expectedVersion` (If-Match) makes the edit conditional; a stale one is a 409 VERSION_CONFLICT. */
  async update(
    actorId: string,
    id: string,
    input: CategoryChanges,
    expectedVersion?: number,
  ): Promise<Category> {
    const changes = normalizeCategoryChanges(input);
    if (Object.keys(changes).length === 0) {
      throw validationError('Indica al menos un campo a modificar');
    }
    const current = await this.get(id);
    this.assertVersion(actorId, current, expectedVersion);
    await this.assertUnique(changes, id);
    const outcome = await this.categories.update(id, changes, this.now(), expectedVersion);
    const updated = this.unwrap(actorId, id, expectedVersion, outcome);
    this.event('updated', id, actorId, { fields: changedCategoryFields(current, changes) });
    return updated;
  }

  /** Idempotent: asking for the current state answers the category without an event. */
  async setStatus(
    actorId: string,
    id: string,
    isActive: boolean,
    expectedVersion?: number,
  ): Promise<Category> {
    const current = await this.get(id);
    this.assertVersion(actorId, current, expectedVersion);
    if (current.isActive === isActive) return current;
    const outcome = await this.categories.setActive(id, isActive, this.now(), expectedVersion);
    const updated = this.unwrap(actorId, id, expectedVersion, outcome);
    this.event(isActive ? 'activated' : 'deactivated', id, actorId);
    return updated;
  }

  private async assertUnique(
    data: { code?: string; name?: string },
    excludeId?: string,
  ): Promise<void> {
    if (data.code !== undefined && (await this.categories.existsByCode(data.code, excludeId))) {
      throw conflictError(CODE_TAKEN, 'CATEGORY_CODE_TAKEN');
    }
    if (data.name !== undefined && (await this.categories.existsByName(data.name, excludeId))) {
      throw conflictError(NAME_TAKEN, 'CATEGORY_NAME_TAKEN');
    }
  }
}
