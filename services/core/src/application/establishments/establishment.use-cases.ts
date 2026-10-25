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
import type { WriteOutcome } from '../../domain/sync/version.js';
import { decodeCursor, encodeCursor, type ChangePage } from '../../domain/sync/change-cursor.js';

const NAME_TAKEN = 'Ya existe un establecimiento con ese nombre';
const ID_TAKEN = 'Ya existe un establecimiento con ese id';
const NOT_FOUND = 'Establecimiento no encontrado';

/** Establishment use cases. Every write records an audit event with `establishmentId` and `actorId`. */
export class EstablishmentUseCases {
  constructor(
    private readonly establishments: EstablishmentRepository,
    private readonly log: AuditLog,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** `id` is the optional client-generated identifier (offline creation). */
  async create(actorId: string, input: EstablishmentInput, id?: string): Promise<Establishment> {
    const data = normalizeNewEstablishment(input);
    if (id !== undefined && (await this.establishments.findById(id))) {
      throw conflictError(ID_TAKEN, 'ESTABLISHMENT_ID_TAKEN');
    }
    if (await this.establishments.existsByName(data.name)) {
      throw conflictError(NAME_TAKEN, 'ESTABLISHMENT_NAME_TAKEN');
    }
    const created = await this.establishments.create(data, id);
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

  /** `expectedVersion` (If-Match) makes the edit conditional; a stale one is a 409 VERSION_CONFLICT. */
  async update(
    actorId: string,
    id: string,
    input: EstablishmentChanges,
    expectedVersion?: number,
  ): Promise<Establishment> {
    const changes = normalizeChanges(input);
    if (Object.keys(changes).length === 0) {
      throw validationError('Indica al menos un campo a modificar');
    }
    const current = await this.get(id);
    this.assertVersion(actorId, current, expectedVersion);
    if (changes.name !== undefined && (await this.establishments.existsByName(changes.name, id))) {
      throw conflictError(NAME_TAKEN, 'ESTABLISHMENT_NAME_TAKEN');
    }
    const outcome = await this.establishments.update(id, changes, this.now(), expectedVersion);
    const updated = this.unwrap(actorId, id, expectedVersion, outcome);
    this.log.info('establishment.updated', {
      establishmentId: id,
      actorId,
      fields: changedFields(current, changes),
    });
    return updated;
  }

  /** Idempotent: asking for the current state answers the establishment without an event. */
  async setStatus(
    actorId: string,
    id: string,
    isActive: boolean,
    expectedVersion?: number,
  ): Promise<Establishment> {
    const current = await this.get(id);
    this.assertVersion(actorId, current, expectedVersion);
    if (current.isActive === isActive) return current;
    const outcome = await this.establishments.setActive(id, isActive, this.now(), expectedVersion);
    const updated = this.unwrap(actorId, id, expectedVersion, outcome);
    this.log.info(isActive ? 'establishment.activated' : 'establishment.deactivated', {
      establishmentId: id,
      actorId,
    });
    return updated;
  }

  /** Changes after an opaque cursor (400 when malformed), see ADR-0002. */
  async listChanges(cursor: string | undefined, limit: number): Promise<ChangePage<Establishment>> {
    const from = cursor === undefined ? null : decodeCursor(cursor);
    const batch = await this.establishments.listChanges(from, limit);
    const position = batch.last ?? from;
    return {
      items: batch.items,
      nextCursor: position ? encodeCursor(position) : null,
      hasMore: batch.hasMore,
    };
  }

  private assertVersion(actorId: string, current: Establishment, expected?: number): void {
    if (expected !== undefined && current.version !== expected) {
      throw this.versionConflict(actorId, current, expected);
    }
  }

  private unwrap(
    actorId: string,
    id: string,
    expected: number | undefined,
    outcome: WriteOutcome<Establishment>,
  ): Establishment {
    if (outcome.status === 'updated') return outcome.value;
    if (outcome.status === 'not_found') throw notFoundError(NOT_FOUND);
    throw this.versionConflict(actorId, outcome.current, expected, id);
  }

  private versionConflict(
    actorId: string,
    current: Establishment,
    expected: number | undefined,
    id = current.id,
  ) {
    this.log.warn('establishment.version_conflict', {
      establishmentId: id,
      actorId,
      expectedVersion: expected,
      currentVersion: current.version,
    });
    return conflictError(
      'El establecimiento cambió en el servidor; revisa la versión actual',
      'VERSION_CONFLICT',
      { current },
    );
  }
}
