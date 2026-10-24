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
import { CurrentUserId, RequirePermissions } from './auth-decorators.js';
import {
  createEstablishmentSchema,
  establishmentStatusSchema,
  idSchema,
  listEstablishmentsQuerySchema,
  updateEstablishmentSchema,
} from './schemas.js';
import { ESTABLISHMENT_USE_CASES } from './tokens.js';
import { ZodValidationPipe } from './zod-validation.pipe.js';

const PERM_READ = 'establishments.read' satisfies EstablishmentPermission;
const PERM_CREATE = 'establishments.create' satisfies EstablishmentPermission;
const PERM_UPDATE = 'establishments.update' satisfies EstablishmentPermission;
const PERM_DEACTIVATE = 'establishments.deactivate' satisfies EstablishmentPermission;

const idPipe = new ZodValidationPipe(idSchema);

/** Public representation: adds the Google Maps link derived from the coordinates. */
function present(e: Establishment) {
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
    mapsUrl: buildMapsUrl(e.latitude, e.longitude),
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

@Controller('establishments')
export class EstablishmentsController {
  constructor(@Inject(ESTABLISHMENT_USE_CASES) private readonly uc: EstablishmentUseCases) {}

  @Post()
  @RequirePermissions(PERM_CREATE)
  async create(
    @CurrentUserId() actorId: string,
    @Body(new ZodValidationPipe(createEstablishmentSchema)) body: EstablishmentInput,
  ) {
    return present(await this.uc.create(actorId, body));
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

  @Get(':id')
  @RequirePermissions(PERM_READ)
  async get(@Param('id', idPipe) id: string) {
    return present(await this.uc.get(id));
  }

  @Patch(':id')
  @RequirePermissions(PERM_UPDATE)
  async update(
    @CurrentUserId() actorId: string,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(updateEstablishmentSchema)) body: EstablishmentChanges,
  ) {
    return present(await this.uc.update(actorId, id, body));
  }

  @Patch(':id/status')
  @RequirePermissions(PERM_DEACTIVATE)
  async setStatus(
    @CurrentUserId() actorId: string,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(establishmentStatusSchema)) body: { isActive: boolean },
  ) {
    return present(await this.uc.setStatus(actorId, id, body.isActive));
  }
}
