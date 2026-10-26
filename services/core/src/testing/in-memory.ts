import { randomUUID } from 'node:crypto';
import type { Establishment, EstablishmentData } from '../domain/establishment/establishment.js';
import type {
  EstablishmentFilter,
  EstablishmentRepository,
} from '../domain/establishment/establishment-repository.js';
import type { AuditLog } from '../domain/shared/audit-log.js';
import { conflictError } from '../domain/shared/errors.js';
import type { ChangeBatch, ChangeCursor } from '../domain/sync/change-cursor.js';
import type { WriteOutcome } from '../domain/sync/version.js';

export class InMemoryEstablishmentRepository implements EstablishmentRepository {
  readonly rows = new Map<string, Establishment>();
  /** Change position (monotonic counter standing in for xid8) of each row. */
  private readonly positions = new Map<string, number>();
  private clock = 0;

  async create(data: EstablishmentData, id?: string): Promise<Establishment> {
    if (id !== undefined && this.rows.has(id)) {
      throw conflictError('id duplicado', 'ESTABLISHMENT_ID_TAKEN');
    }
    if (await this.existsByName(data.name)) {
      throw conflictError('duplicado', 'ESTABLISHMENT_NAME_TAKEN');
    }
    const now = new Date('2026-01-01T00:00:00.000Z');
    const row: Establishment = {
      id: id ?? randomUUID(),
      ...data,
      isActive: true,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(row.id, row);
    this.positions.set(row.id, ++this.clock);
    return row;
  }

  async findById(id: string): Promise<Establishment | null> {
    return this.rows.get(id) ?? null;
  }

  async findByIds(ids: readonly string[]): Promise<Establishment[]> {
    return ids.flatMap((id) => this.rows.get(id) ?? []);
  }

  async list(filter: EstablishmentFilter) {
    const q = filter.q?.toLowerCase();
    const all = [...this.rows.values()]
      .filter((e) => filter.status === 'all' || e.isActive === (filter.status === 'active'))
      .filter((e) => !q || e.name.toLowerCase().includes(q) || e.city.toLowerCase().includes(q))
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    return { items: all.slice(filter.offset, filter.offset + filter.limit), total: all.length };
  }

  async update(
    id: string,
    changes: Partial<EstablishmentData>,
    now: Date,
    expectedVersion?: number,
  ): Promise<WriteOutcome<Establishment>> {
    return this.write(id, expectedVersion, (current) => ({
      ...current,
      ...changes,
      updatedAt: now,
    }));
  }

  async setActive(
    id: string,
    isActive: boolean,
    now: Date,
    expectedVersion?: number,
  ): Promise<WriteOutcome<Establishment>> {
    return this.write(id, expectedVersion, (current) => ({ ...current, isActive, updatedAt: now }));
  }

  async listChanges(
    cursor: ChangeCursor | null,
    limit: number,
  ): Promise<ChangeBatch<Establishment>> {
    const after = cursor ? Number(cursor.xid) : -1;
    const ordered = [...this.rows.values()]
      .filter((row) => this.positions.get(row.id)! > after)
      .sort((a, b) => this.positions.get(a.id)! - this.positions.get(b.id)!);
    const items = ordered.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      hasMore: ordered.length > limit,
      last: last ? { xid: String(this.positions.get(last.id)), id: last.id } : null,
    };
  }

  private write(
    id: string,
    expectedVersion: number | undefined,
    apply: (current: Establishment) => Establishment,
  ): WriteOutcome<Establishment> {
    const current = this.rows.get(id);
    if (!current) return { status: 'not_found' };
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      return { status: 'conflict', current };
    }
    const next = { ...apply(current), version: current.version + 1 };
    this.rows.set(id, next);
    this.positions.set(id, ++this.clock);
    return { status: 'updated', value: next };
  }

  async existsByName(name: string, excludeId?: string): Promise<boolean> {
    return [...this.rows.values()].some(
      (e) => e.id !== excludeId && e.name.toLowerCase() === name.toLowerCase(),
    );
  }
}

export class RecordingAuditLog implements AuditLog {
  readonly events: { level: 'info' | 'warn'; event: string; data: Record<string, unknown> }[] = [];
  info(event: string, data: Record<string, unknown>): void {
    this.events.push({ level: 'info', event, data });
  }
  warn(event: string, data: Record<string, unknown>): void {
    this.events.push({ level: 'warn', event, data });
  }
}
