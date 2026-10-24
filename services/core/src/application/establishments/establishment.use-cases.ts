import {
  changedFields,
  normalizeChanges,
  normalizeNewEstablishment,
  type Establishment,
  type EstablishmentChanges,
  type EstablishmentInput,
} from '../../domain/establishment/establishment.js';
import type {
  EstablishmentFilter,
  EstablishmentRepository,
} from '../../domain/establishment/establishment-repository.js';
import type { AuditLog } from '../../domain/shared/audit-log.js';
import { conflictError, notFoundError, validationError } from '../../domain/shared/errors.js';

const NAME_TAKEN = 'Ya existe un establecimiento con ese nombre';
const NOT_FOUND = 'Establecimiento no encontrado';

/** Establishment use cases. Every write records an audit event with `establishmentId` and `actorId`. */
export class EstablishmentUseCases {
  constructor(
    private readonly establishments: EstablishmentRepository,
    private readonly log: AuditLog,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(actorId: string, input: EstablishmentInput): Promise<Establishment> {
    const data = normalizeNewEstablishment(input);
    if (await this.establishments.existsByName(data.name)) {
      throw conflictError(NAME_TAKEN, 'ESTABLISHMENT_NAME_TAKEN');
    }
    const created = await this.establishments.create(data);
    this.log.info('establishment.created', { establishmentId: created.id, actorId });
    return created;
  }

  async get(id: string): Promise<Establishment> {
    const found = await this.establishments.findById(id);
    if (!found) throw notFoundError(NOT_FOUND);
    return found;
  }

  list(filter: EstablishmentFilter): Promise<{ items: Establishment[]; total: number }> {
    return this.establishments.list(filter);
  }

  async update(actorId: string, id: string, input: EstablishmentChanges): Promise<Establishment> {
    const changes = normalizeChanges(input);
    if (Object.keys(changes).length === 0) {
      throw validationError('Indica al menos un campo a modificar');
    }
    const current = await this.get(id);
    if (changes.name !== undefined && (await this.establishments.existsByName(changes.name, id))) {
      throw conflictError(NAME_TAKEN, 'ESTABLISHMENT_NAME_TAKEN');
    }
    const updated = await this.establishments.update(id, changes, this.now());
    if (!updated) throw notFoundError(NOT_FOUND);
    this.log.info('establishment.updated', {
      establishmentId: id,
      actorId,
      fields: changedFields(current, changes),
    });
    return updated;
  }

  /** Idempotent: asking for the current state answers the establishment without an event. */
  async setStatus(actorId: string, id: string, isActive: boolean): Promise<Establishment> {
    const current = await this.get(id);
    if (current.isActive === isActive) return current;
    const updated = await this.establishments.setActive(id, isActive, this.now());
    if (!updated) throw notFoundError(NOT_FOUND);
    this.log.info(isActive ? 'establishment.activated' : 'establishment.deactivated', {
      establishmentId: id,
      actorId,
    });
    return updated;
  }
}
