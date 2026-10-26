import { describe, expect, it } from 'vitest';
import type { Assignment, AssignmentUser } from '../../domain/assignment/assignment.js';
import type { AssignmentRepository } from '../../domain/assignment/assignment-repository.js';
import type { AuditLog } from '../../domain/shared/audit-log.js';
import { DomainError } from '../../domain/shared/errors.js';
import { InMemoryEstablishmentRepository } from '../../testing/in-memory.js';
import { AssignmentUseCases } from './assignment.use-cases.js';

const NOW = new Date('2026-01-01T00:00:00.000Z');

class FakeAssignments implements AssignmentRepository {
  readonly users = new Map<string, AssignmentUser>();
  readonly rows: Assignment[] = [];

  async findUser(userId: string) {
    return this.users.get(userId) ?? null;
  }

  async assign(establishmentId: string, userId: string, actorId: string) {
    const existing = this.rows.find(
      (r) => r.establishmentId === establishmentId && r.user.id === userId && !r.removedAt,
    );
    if (existing) return { assignment: existing, created: false };
    const assignment: Assignment = {
      id: `a${this.rows.length}`,
      establishmentId,
      user: this.users.get(userId)!,
      assignedBy: actorId,
      assignedAt: NOW,
      removedBy: null,
      removedAt: null,
    };
    this.rows.push(assignment);
    return { assignment, created: true };
  }

  async remove(establishmentId: string, userId: string, actorId: string, now: Date) {
    const index = this.rows.findIndex(
      (r) => r.establishmentId === establishmentId && r.user.id === userId && !r.removedAt,
    );
    if (index < 0) return false;
    this.rows[index] = { ...this.rows[index]!, removedBy: actorId, removedAt: now };
    return true;
  }

  async listByEstablishment() {
    return { items: [], total: 0 };
  }

  async listByUser() {
    return { items: [], total: 0 };
  }
}

function setup() {
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const log: AuditLog = {
    info: (event, data) => events.push({ event, data }),
    warn: (event, data) => events.push({ event, data }),
  };
  const assignments = new FakeAssignments();
  const establishments = new InMemoryEstablishmentRepository();
  const uc = new AssignmentUseCases(assignments, establishments, log, () => NOW);
  return { uc, assignments, establishments, events };
}

const place = {
  name: 'Sede',
  address: 'x',
  city: 'y',
  department: 'z',
  phone: null,
  latitude: 1,
  longitude: 1,
};

async function code(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return (error as DomainError).code;
  }
  return undefined;
}

describe('AssignmentUseCases', () => {
  it('assigns once, repeats answer the same assignment and audit only the first (R-1)', async () => {
    const { uc, assignments, establishments, events } = setup();
    const est = await establishments.create(place);
    assignments.users.set('u1', { id: 'u1', fullName: 'U', email: 'u@x', isActive: true });
    const first = await uc.assign('actor', est.id, 'u1');
    const second = await uc.assign('actor', est.id, 'u1');
    expect(first.created).toBe(true);
    expect(second).toMatchObject({ created: false });
    expect(second.assignment.id).toBe(first.assignment.id);
    expect(events).toEqual([
      {
        event: 'establishment.user_assigned',
        data: { establishmentId: est.id, userId: 'u1', actorId: 'actor' },
      },
    ]);
  });

  it('validation order: establishment 404 -> 409 -> user 404 -> 409 -> own user 403', async () => {
    const { uc, assignments, establishments } = setup();
    const active = await establishments.create(place);
    const inactive = await establishments.create({ ...place, name: 'Otra' });
    await establishments.setActive(inactive.id, false, NOW);
    assignments.users.set('off', { id: 'off', fullName: 'U', email: 'u@x', isActive: false });
    assignments.users.set('actor', { id: 'actor', fullName: 'A', email: 'a@x', isActive: true });
    expect(await code(uc.assign('actor', crypto.randomUUID(), 'off'))).toBe('NOT_FOUND');
    expect(await code(uc.assign('actor', inactive.id, 'ghost'))).toBe('ESTABLISHMENT_INACTIVE');
    expect(await code(uc.assign('actor', active.id, 'ghost'))).toBe('NOT_FOUND');
    expect(await code(uc.assign('actor', active.id, 'off'))).toBe('USER_INACTIVE');
    expect(await code(uc.assign('actor', active.id, 'actor'))).toBe('SELF_ASSIGNMENT');
  });

  it('removes keeping the history; own user is 403 and no current assignment is 404', async () => {
    const { uc, assignments, establishments, events } = setup();
    const est = await establishments.create(place);
    assignments.users.set('u1', { id: 'u1', fullName: 'U', email: 'u@x', isActive: true });
    await uc.assign('actor', est.id, 'u1');
    expect(await code(uc.remove('u1', est.id, 'u1'))).toBe('SELF_ASSIGNMENT');
    await uc.remove('actor', est.id, 'u1');
    expect(await code(uc.remove('actor', est.id, 'u1'))).toBe('NOT_FOUND');
    expect(assignments.rows[0]).toMatchObject({ removedBy: 'actor', removedAt: NOW });
    expect(events.map((e) => e.event)).toEqual([
      'establishment.user_assigned',
      'establishment.user_removed',
    ]);
    await uc.assign('actor', est.id, 'u1');
    expect(assignments.rows).toHaveLength(2);
  });
});
