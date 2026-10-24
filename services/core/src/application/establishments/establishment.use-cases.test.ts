import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryEstablishmentRepository, RecordingAuditLog } from '../../testing/in-memory.js';
import { DomainError } from '../../domain/shared/errors.js';
import type { EstablishmentInput } from '../../domain/establishment/establishment.js';
import { EstablishmentUseCases } from './establishment.use-cases.js';

const input = (overrides: Partial<EstablishmentInput> = {}): EstablishmentInput => ({
  name: 'Sede Norte',
  address: 'Cra 10 # 20-30',
  city: 'Medellín',
  department: 'Antioquia',
  latitude: 6.25,
  longitude: -75.56,
  ...overrides,
});

const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainError) return `${error.kind}:${error.code}`;
    throw error;
  }
  return 'none';
};

let repo: InMemoryEstablishmentRepository;
let log: RecordingAuditLog;
let uc: EstablishmentUseCases;
const later = new Date('2026-02-02T00:00:00.000Z');

beforeEach(() => {
  repo = new InMemoryEstablishmentRepository();
  log = new RecordingAuditLog();
  uc = new EstablishmentUseCases(repo, log, () => later);
});

describe('EstablishmentUseCases', () => {
  it('creates an active establishment and logs the event', async () => {
    const created = await uc.create('actor-1', input({ phone: '' }));
    expect(created.isActive).toBe(true);
    expect(created.phone).toBeNull();
    expect(log.events).toEqual([
      {
        level: 'info',
        event: 'establishment.created',
        data: { establishmentId: created.id, actorId: 'actor-1' },
      },
    ]);
  });

  it('rejects a duplicate name ignoring case and outer spaces, also against inactive ones', async () => {
    const first = await uc.create('a', input());
    await uc.setStatus('a', first.id, false);
    expect(await codeOf(uc.create('a', input({ name: '  SEDE norte ' })))).toBe(
      'conflict:ESTABLISHMENT_NAME_TAKEN',
    );
  });

  it('edits keeping its own name but rejects another one in use', async () => {
    const a = await uc.create('a', input());
    const b = await uc.create('a', input({ name: 'Sede Sur' }));
    expect((await uc.update('a', a.id, { name: 'sede norte', city: 'Cali' })).city).toBe('Cali');
    expect(await codeOf(uc.update('a', b.id, { name: 'Sede Norte' }))).toBe(
      'conflict:ESTABLISHMENT_NAME_TAKEN',
    );
  });

  it('update changes only provided fields, sets updatedAt and logs changed fields without values', async () => {
    const a = await uc.create('a', input({ phone: '123' }));
    log.events.length = 0;
    const updated = await uc.update('actor-2', a.id, { phone: null, city: 'Medellín' });
    expect(updated.phone).toBeNull();
    expect(updated.name).toBe('Sede Norte');
    expect(updated.updatedAt).toEqual(later);
    expect(log.events[0]).toEqual({
      level: 'info',
      event: 'establishment.updated',
      data: { establishmentId: a.id, actorId: 'actor-2', fields: ['phone'] },
    });
  });

  it('update without fields is a validation error and unknown ids are 404', async () => {
    const a = await uc.create('a', input());
    expect(await codeOf(uc.update('a', a.id, {}))).toBe('validation:VALIDATION_ERROR');
    expect(await codeOf(uc.update('a', crypto.randomUUID(), { city: 'x' }))).toBe(
      'not_found:NOT_FOUND',
    );
    expect(await codeOf(uc.get(crypto.randomUUID()))).toBe('not_found:NOT_FOUND');
    expect(await codeOf(uc.setStatus('a', crypto.randomUUID(), false))).toBe('not_found:NOT_FOUND');
  });

  it('status change is idempotent and logs only real transitions', async () => {
    const a = await uc.create('a', input());
    log.events.length = 0;
    expect((await uc.setStatus('a', a.id, true)).isActive).toBe(true);
    expect(log.events).toHaveLength(0);
    expect((await uc.setStatus('a', a.id, false)).isActive).toBe(false);
    expect((await uc.setStatus('a', a.id, true)).isActive).toBe(true);
    expect(log.events.map((e) => e.event)).toEqual([
      'establishment.deactivated',
      'establishment.activated',
    ]);
  });

  it('lists filtered by status and text, ordered by name', async () => {
    await uc.create('a', input({ name: 'beta', city: 'Cali' }));
    const alpha = await uc.create('a', input({ name: 'Alpha', city: 'Bogotá' }));
    await uc.setStatus('a', alpha.id, false);
    const all = await uc.list({ status: 'all', limit: 50, offset: 0 });
    expect(all.items.map((e) => e.name)).toEqual(['Alpha', 'beta']);
    expect((await uc.list({ status: 'active', limit: 50, offset: 0 })).total).toBe(1);
    expect((await uc.list({ status: 'all', q: 'bogo', limit: 50, offset: 0 })).items).toHaveLength(
      1,
    );
  });
});
