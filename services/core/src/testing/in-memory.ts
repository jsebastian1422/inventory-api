import { randomUUID } from 'node:crypto';
import type { Establishment, EstablishmentData } from '../domain/establishment/establishment.js';
import type {
  EstablishmentFilter,
  EstablishmentRepository,
} from '../domain/establishment/establishment-repository.js';
import type { AuditLog } from '../domain/shared/audit-log.js';
import { conflictError } from '../domain/shared/errors.js';

export class InMemoryEstablishmentRepository implements EstablishmentRepository {
  readonly rows = new Map<string, Establishment>();

  async create(data: EstablishmentData): Promise<Establishment> {
    if (await this.existsByName(data.name)) {
      throw conflictError('duplicado', 'ESTABLISHMENT_NAME_TAKEN');
    }
    const now = new Date('2026-01-01T00:00:00.000Z');
    const row: Establishment = {
      id: randomUUID(),
      ...data,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(row.id, row);
    return row;
  }

  async findById(id: string): Promise<Establishment | null> {
    return this.rows.get(id) ?? null;
  }

  async list(filter: EstablishmentFilter) {
    const q = filter.q?.toLowerCase();
    const all = [...this.rows.values()]
      .filter((e) => filter.status === 'all' || e.isActive === (filter.status === 'active'))
      .filter((e) => !q || e.name.toLowerCase().includes(q) || e.city.toLowerCase().includes(q))
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    return { items: all.slice(filter.offset, filter.offset + filter.limit), total: all.length };
  }

  async update(id: string, changes: Partial<EstablishmentData>, now: Date) {
    const current = this.rows.get(id);
    if (!current) return null;
    const next: Establishment = { ...current, ...changes, updatedAt: now };
    this.rows.set(id, next);
    return next;
  }

  async setActive(id: string, isActive: boolean, now: Date) {
    const current = this.rows.get(id);
    if (!current) return null;
    const next: Establishment = { ...current, isActive, updatedAt: now };
    this.rows.set(id, next);
    return next;
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
