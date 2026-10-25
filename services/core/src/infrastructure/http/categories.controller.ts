import type { CategoryPermission } from '@inventory/shared';
import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import type { CategoryUseCases } from '../../application/categories/category.use-cases.js';
import type { Category, CategoryChanges, CategoryInput } from '../../domain/category/category.js';
import type { StatusFilter } from '../../domain/establishment/establishment-repository.js';
import { CurrentUserId, RequirePermissions } from './auth-decorators.js';
import { Idempotent } from './idempotency.interceptor.js';
import { IfMatchVersion } from './if-match.js';
import { presentingConflict } from './present.js';
import {
  createCategorySchema,
  establishmentStatusSchema,
  idSchema,
  listCategoriesQuerySchema,
  listChangesQuerySchema,
  updateCategorySchema,
} from './schemas.js';
import { CATEGORY_USE_CASES } from './tokens.js';
import { ZodValidationPipe } from './zod-validation.pipe.js';

const PERM_READ = 'categories.read' satisfies CategoryPermission;
const PERM_CREATE = 'categories.create' satisfies CategoryPermission;
const PERM_UPDATE = 'categories.update' satisfies CategoryPermission;
const PERM_DEACTIVATE = 'categories.deactivate' satisfies CategoryPermission;

const idPipe = new ZodValidationPipe(idSchema);

function present(c: Category) {
  return {
    id: c.id,
    code: c.code,
    name: c.name,
    description: c.description,
    isActive: c.isActive,
    version: c.version,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

@Controller('categories')
export class CategoriesController {
  constructor(@Inject(CATEGORY_USE_CASES) private readonly uc: CategoryUseCases) {}

  @Post()
  @RequirePermissions(PERM_CREATE)
  @Idempotent()
  async create(
    @CurrentUserId() actorId: string,
    @Body(new ZodValidationPipe(createCategorySchema)) body: CategoryInput & { id?: string },
  ) {
    const { id, ...input } = body;
    return present(await this.uc.create(actorId, input, id));
  }

  @Get()
  @RequirePermissions(PERM_READ)
  async list(
    @Query(new ZodValidationPipe(listCategoriesQuerySchema))
    query: {
      status: StatusFilter;
      q?: string;
      limit: number;
      offset: number;
    },
  ) {
    const { items, total } = await this.uc.list(query);
    return { items: items.map(present), total, limit: query.limit, offset: query.offset };
  }

  /** Registered before `:id` so that `changes` is not taken as an id. */
  @Get('changes')
  @RequirePermissions(PERM_READ)
  async changes(
    @Query(new ZodValidationPipe(listChangesQuerySchema)) query: { cursor?: string; limit: number },
  ) {
    const page = await this.uc.listChanges(query.cursor, query.limit);
    return { items: page.items.map(present), nextCursor: page.nextCursor, hasMore: page.hasMore };
  }

  @Get(':id')
  @RequirePermissions(PERM_READ)
  async get(@Param('id', idPipe) id: string) {
    return present(await this.uc.get(id));
  }

  @Patch(':id')
  @RequirePermissions(PERM_UPDATE)
  @Idempotent()
  async update(
    @CurrentUserId() actorId: string,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(updateCategorySchema)) body: CategoryChanges,
    @IfMatchVersion() expectedVersion: number | undefined,
  ) {
    return present(
      await presentingConflict(this.uc.update(actorId, id, body, expectedVersion), present),
    );
  }

  @Patch(':id/status')
  @RequirePermissions(PERM_DEACTIVATE)
  @Idempotent()
  async setStatus(
    @CurrentUserId() actorId: string,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(establishmentStatusSchema)) body: { isActive: boolean },
    @IfMatchVersion() expectedVersion: number | undefined,
  ) {
    return present(
      await presentingConflict(
        this.uc.setStatus(actorId, id, body.isActive, expectedVersion),
        present,
      ),
    );
  }
}
