import type { AuditLog } from '../../domain/shared/audit-log.js';
import { conflictError, notFoundError } from '../../domain/shared/errors.js';
import {
  decodeCursor,
  encodeCursor,
  type ChangeBatch,
  type ChangeCursor,
  type ChangePage,
} from '../../domain/sync/change-cursor.js';
import type { WriteOutcome } from '../../domain/sync/version.js';

/** Names a resource uses in audit events and messages. */
export interface ResourceLabels {
  /** Event prefix, e.g. `category` -> `category.created`. */
  readonly event: string;
  /** Audit data key holding the id, e.g. `categoryId`. */
  readonly idKey: string;
  readonly notFound: string;
  readonly versionConflict: string;
}

export interface ReadableResource<T> {
  findById(id: string): Promise<T | null>;
  listChanges(cursor: ChangeCursor | null, limit: number): Promise<ChangeBatch<T>>;
}

/** Behavior shared by the versioned resources (ADR-0002): get, feed, version checks and conflicts. */
export abstract class ResourceUseCases<
  T extends { id: string; version: number; isActive: boolean },
> {
  constructor(
    protected readonly repository: ReadableResource<T>,
    protected readonly log: AuditLog,
    protected readonly labels: ResourceLabels,
    protected readonly now: () => Date,
  ) {}

  async get(id: string): Promise<T> {
    const found = await this.repository.findById(id);
    if (!found) throw notFoundError(this.labels.notFound);
    return found;
  }

  /** Changes after an opaque cursor (400 when malformed), see ADR-0002. */
  async listChanges(cursor: string | undefined, limit: number): Promise<ChangePage<T>> {
    const from = cursor === undefined ? null : decodeCursor(cursor);
    const batch = await this.repository.listChanges(from, limit);
    const position = batch.last ?? from;
    return {
      items: batch.items,
      nextCursor: position ? encodeCursor(position) : null,
      hasMore: batch.hasMore,
    };
  }

  protected assertVersion(actorId: string, current: T, expected?: number): void {
    if (expected !== undefined && current.version !== expected) {
      throw this.versionConflict(actorId, current, expected);
    }
  }

  protected unwrap(
    actorId: string,
    id: string,
    expected: number | undefined,
    outcome: WriteOutcome<T>,
  ): T {
    if (outcome.status === 'updated') return outcome.value;
    if (outcome.status === 'not_found') throw notFoundError(this.labels.notFound);
    throw this.versionConflict(actorId, outcome.current, expected, id);
  }

  protected event(name: string, id: string, actorId: string, extra: Record<string, unknown> = {}) {
    this.log.info(`${this.labels.event}.${name}`, { [this.labels.idKey]: id, actorId, ...extra });
  }

  protected versionConflict(
    actorId: string,
    current: T,
    expected: number | undefined,
    id = current.id,
  ) {
    this.log.warn(`${this.labels.event}.version_conflict`, {
      [this.labels.idKey]: id,
      actorId,
      expectedVersion: expected,
      currentVersion: current.version,
    });
    return conflictError(this.labels.versionConflict, 'VERSION_CONFLICT', { current });
  }
}
