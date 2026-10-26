import type { EstablishmentPermission } from '@inventory/shared';
import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import type { EstablishmentUseCases } from '../../application/establishments/establishment.use-cases.js';
import {
  buildMapsUrl,
  type Establishment,
  type EstablishmentChanges,
  type EstablishmentInput,
} from '../../domain/establishment/establishment.js';
import type { StatusFilter } from '../../domain/establishment/establishment-repository.js';
import { DomainError } from '../../domain/shared/errors.js';
import { CurrentUserId, RequirePermissions } from './auth-decorators.js';
import {
  createEstablishmentSchema,
  establishmentStatusSchema,
  idSchema,
  listChangesQuerySchema,
  listEstablishmentsQuerySchema,
  updateEstablishmentSchema,
} from './schemas.js';
import { Idempotent } from './idempotency.interceptor.js';
import { IfMatchVersion } from './if-match.js';
import { ESTABLISHMENT_USE_CASES } from './tokens.js';
import { ZodValidationPipe } from './zod-validation.pipe.js';

const PERM_READ = 'establishments.read' satisfies EstablishmentPermission;
const PERM_CREATE = 'establishments.create' satisfies EstablishmentPermission;
const PERM_UPDATE = 'establishments.update' satisfies EstablishmentPermission;
const PERM_DEACTIVATE = 'establishments.deactivate' satisfies EstablishmentPermission;

const idPipe = new ZodValidationPipe(idSchema);

/** Public representation: adds the Google Maps link derived from the coordinates. */
export function present(e: Establishment) {
  return {
    id: e.id,
    name: e.name,
    address: e.address,
    city: e.city,
    department: e.department,
    phone: e.phone,
    latitude: e.latitude,
    longitude: e.longitude,
    isActive: e.isActive,
    version: e.version,
    mapsUrl: buildMapsUrl(e.latitude, e.longitude),
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

/** A VERSION_CONFLICT carries the server copy: answer it in the public representation. */
async function presentingConflict<T>(operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    if (error instanceof DomainError && error.code === 'VERSION_CONFLICT' && error.extra?.current) {
      throw new DomainError(error.kind, error.message, error.code, error.details, {
        current: present(error.extra.current as Establishment),
      });
    }
    throw error;
  }
}

@Controller('establishments')
export class EstablishmentsController {
  constructor(@Inject(ESTABLISHMENT_USE_CASES) private readonly uc: EstablishmentUseCases) {}

  @Post()
  @RequirePermissions(PERM_CREATE)
  @Idempotent()
  async create(
    @CurrentUserId() actorId: string,
    @Body(new ZodValidationPipe(createEstablishmentSchema))
    body: EstablishmentInput & { id?: string },
  ) {
    const { id, ...input } = body;
    return present(await this.uc.create(actorId, input, id));
  }

  @Get()
  @RequirePermissions(PERM_READ)
  async list(
    @Query(new ZodValidationPipe(listEstablishmentsQuerySchema))
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
    @Query(new ZodValidationPipe(listChangesQuerySchema))
    query: {
      cursor?: string;
      limit: number;
    },
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
    @Body(new ZodValidationPipe(updateEstablishmentSchema)) body: EstablishmentChanges,
    @IfMatchVersion() expectedVersion: number | undefined,
  ) {
    return present(await presentingConflict(this.uc.update(actorId, id, body, expectedVersion)));
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
      await presentingConflict(this.uc.setStatus(actorId, id, body.isActive, expectedVersion)),
    );
  }
}
