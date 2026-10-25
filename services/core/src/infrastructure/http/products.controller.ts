import type { ProductPermission } from '@inventory/shared';
import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import type { ProductUseCases } from '../../application/products/product.use-cases.js';
import type { StatusFilter } from '../../domain/establishment/establishment-repository.js';
import type {
  PriceChange,
  Product,
  ProductChanges,
  ProductInput,
} from '../../domain/product/product.js';
import { CurrentUserId, RequirePermissions } from './auth-decorators.js';
import { Idempotent } from './idempotency.interceptor.js';
import { IfMatchVersion } from './if-match.js';
import { presentingConflict } from './present.js';
import {
  createProductSchema,
  establishmentStatusSchema,
  idSchema,
  listChangesQuerySchema,
  listProductsQuerySchema,
  pageQuerySchema,
  updateProductSchema,
} from './schemas.js';
import { PRODUCT_USE_CASES } from './tokens.js';
import { ZodValidationPipe } from './zod-validation.pipe.js';

const PERM_READ = 'products.read' satisfies ProductPermission;
const PERM_CREATE = 'products.create' satisfies ProductPermission;
const PERM_UPDATE = 'products.update' satisfies ProductPermission;
const PERM_DEACTIVATE = 'products.deactivate' satisfies ProductPermission;

const idPipe = new ZodValidationPipe(idSchema);

function present(p: Product) {
  return {
    id: p.id,
    sku: p.sku,
    name: p.name,
    description: p.description,
    brand: p.brand,
    unit: p.unit,
    categoryId: p.categoryId,
    price: p.price,
    isActive: p.isActive,
    version: p.version,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

function presentPrice(h: PriceChange) {
  return {
    oldPrice: h.oldPrice,
    newPrice: h.newPrice,
    actorId: h.actorId,
    changedAt: h.changedAt,
  };
}

@Controller('products')
export class ProductsController {
  constructor(@Inject(PRODUCT_USE_CASES) private readonly uc: ProductUseCases) {}

  @Post()
  @RequirePermissions(PERM_CREATE)
  @Idempotent()
  async create(
    @CurrentUserId() actorId: string,
    @Body(new ZodValidationPipe(createProductSchema)) body: ProductInput & { id?: string },
  ) {
    const { id, ...input } = body;
    return present(await this.uc.create(actorId, input, id));
  }

  @Get()
  @RequirePermissions(PERM_READ)
  async list(
    @Query(new ZodValidationPipe(listProductsQuerySchema))
    query: {
      status: StatusFilter;
      q?: string;
      categoryId?: string;
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

  @Get(':id/price-history')
  @RequirePermissions(PERM_READ)
  async priceHistory(
    @Param('id', idPipe) id: string,
    @Query(new ZodValidationPipe(pageQuerySchema)) query: { limit: number; offset: number },
  ) {
    const { items, total } = await this.uc.priceHistory(id, query.limit, query.offset);
    return { items: items.map(presentPrice), total, limit: query.limit, offset: query.offset };
  }

  @Patch(':id')
  @RequirePermissions(PERM_UPDATE)
  @Idempotent()
  async update(
    @CurrentUserId() actorId: string,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(updateProductSchema)) body: ProductChanges,
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
