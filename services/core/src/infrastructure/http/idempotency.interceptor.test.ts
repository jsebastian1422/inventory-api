import type { CallHandler, ExecutionContext } from '@nestjs/common';
import type { ModuleRef, Reflector } from '@nestjs/core';
import { lastValueFrom, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import type { AuditLog } from '../../domain/shared/audit-log.js';
import { DomainError } from '../../domain/shared/errors.js';
import {
  hashRequest,
  IDEMPOTENCY_PURGE_BATCH,
  type IdempotencyStore,
  type ReserveResult,
} from '../../domain/sync/idempotency.js';
import { IdempotencyInterceptor, type ReplayAuthorization } from './idempotency.interceptor.js';

const KEY = '0b7f1c9e-5a2d-4e8b-9c3a-1f2e3d4c5b6a';

/** In-memory store with the same reserve/complete/release semantics as the port. */
class MemoryStore implements IdempotencyStore {
  readonly rows = new Map<
    string,
    { hash: string; state: 'in_progress' | 'completed'; status?: number; response?: unknown }
  >();
  purged: Array<{ now: Date; limit: number }> = [];
  failComplete = false;
  failPurge = false;

  reserve(actorId: string, key: string, hash: string): Promise<ReserveResult> {
    const id = `${actorId}:${key}`;
    const row = this.rows.get(id);
    if (!row) {
      this.rows.set(id, { hash, state: 'in_progress' });
      return Promise.resolve({ kind: 'new' });
    }
    if (row.hash !== hash) return Promise.resolve({ kind: 'mismatch' });
    if (row.state === 'in_progress') return Promise.resolve({ kind: 'in_progress' });
    return Promise.resolve({ kind: 'replay', statusCode: row.status!, response: row.response });
  }
  complete(actorId: string, key: string, statusCode: number, response: unknown): Promise<void> {
    if (this.failComplete) return Promise.reject(new Error('db down'));
    const row = this.rows.get(`${actorId}:${key}`)!;
    row.state = 'completed';
    row.status = statusCode;
    row.response = response;
    return Promise.resolve();
  }
  release(actorId: string, key: string): Promise<void> {
    this.rows.delete(`${actorId}:${key}`);
    return Promise.resolve();
  }
  purgeExpired(now: Date, limit: number): Promise<void> {
    if (this.failPurge) return Promise.reject(new Error('purge down'));
    this.purged.push({ now, limit });
    return Promise.resolve();
  }
}

interface Req {
  headers: Record<string, unknown>;
  method: string;
  url: string;
  body: unknown;
  auth: { userId: string };
}

function setup(store = new MemoryStore()) {
  const warns: Array<{ event: string; data: Record<string, unknown> }> = [];
  const infos: string[] = [];
  const log: AuditLog = {
    info: (event) => void infos.push(event),
    warn: (event, data) => void warns.push({ event, data }),
  };
  const interceptor = new IdempotencyInterceptor(store, log);
  const reply = { statusCode: 201, status: vi.fn() };
  reply.status.mockImplementation((code: number) => {
    reply.statusCode = code;
    return reply;
  });

  const run = (
    request: Partial<Req>,
    handler: () => ReturnType<CallHandler['handle']>,
  ): Promise<unknown> => {
    const req: Req = {
      headers: { 'idempotency-key': KEY },
      method: 'POST',
      url: '/things?x=1',
      body: { name: 'a' },
      auth: { userId: 'u1' },
      ...request,
    };
    const context = {
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => reply }),
    } as unknown as ExecutionContext;
    const next: CallHandler = { handle: handler };
    return interceptor.intercept(context, next).then((obs) => lastValueFrom(obs));
  };
  return { store, run, reply, warns, infos };
}

const ok = (value: unknown) => vi.fn(() => of(value));

describe('IdempotencyInterceptor', () => {
  it('without the header runs the handler untouched and touches no storage', async () => {
    const { run, store } = setup();
    const handler = ok({ id: 1 });
    await expect(run({ headers: {} }, handler)).resolves.toEqual({ id: 1 });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(store.rows.size).toBe(0);
    expect(store.purged).toHaveLength(0);
  });

  it.each(['abc', '123', '', '0b7f1c9e-5a2d-4e8b-9c3a-1f2e3d4c5b6', ['a', 'b']])(
    'rejects a malformed key %j with a 400 on Idempotency-Key',
    async (value) => {
      const { run, store } = setup();
      const handler = ok({});
      const error = await run({ headers: { 'idempotency-key': value } }, handler).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).kind).toBe('validation');
      expect((error as DomainError).details?.[0]?.field).toBe('Idempotency-Key');
      expect(handler).not.toHaveBeenCalled();
      expect(store.rows.size).toBe(0);
    },
  );

  it('new key: runs the handler, stores status and a JSON copy of the body, purges first', async () => {
    const { run, store } = setup();
    const when = new Date('2026-01-02T03:04:05.000Z');
    await expect(run({}, ok({ id: 1, at: when, skip: undefined }))).resolves.toEqual({
      id: 1,
      at: when,
      skip: undefined,
    });
    const row = store.rows.get(`u1:${KEY}`)!;
    expect(row.state).toBe('completed');
    expect(row.status).toBe(201);
    expect(row.response).toEqual({ id: 1, at: '2026-01-02T03:04:05.000Z' });
    expect(store.purged).toEqual([
      { now: expect.any(Date) as Date, limit: IDEMPOTENCY_PURGE_BATCH },
    ]);
  });

  it('stores null when the handler returns no body; key is trimmed and lowercased', async () => {
    const { run, store } = setup();
    await run({ headers: { 'idempotency-key': `  ${KEY.toUpperCase()} ` } }, ok(undefined));
    expect(store.rows.get(`u1:${KEY}`)?.response).toBeNull();
  });

  it('replay: answers the stored status and body without running the handler', async () => {
    const { run, reply, infos } = setup();
    await run({}, ok({ id: 1 }));
    reply.status.mockClear();
    reply.statusCode = 200;
    const handler = ok({ id: 2 });
    await expect(run({}, handler)).resolves.toEqual({ id: 1 });
    expect(handler).not.toHaveBeenCalled();
    expect(reply.status).toHaveBeenCalledWith(201);
    expect(infos).toEqual(['idempotency.replayed']);
  });

  it('same key with another body, path or If-Match is a 409 IDEMPOTENCY_KEY_REUSED', async () => {
    const { run } = setup();
    await run({ headers: { 'idempotency-key': KEY, 'if-match': '"1"' } }, ok({}));
    for (const change of [
      { body: { name: 'b' } },
      { url: '/other' },
      { headers: { 'idempotency-key': KEY, 'if-match': '"2"' } },
      { headers: { 'idempotency-key': KEY } },
    ]) {
      const handler = ok({});
      const error = await run(change, handler).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).kind).toBe('conflict');
      expect((error as DomainError).code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(handler).not.toHaveBeenCalled();
    }
  });

  it('If-Match "3" and 3 are the same content (replay); a malformed one keeps its own text', async () => {
    const { run } = setup();
    await run({ headers: { 'idempotency-key': KEY, 'if-match': '"3"' } }, ok({ n: 1 }));
    const handler = ok({ n: 2 });
    await expect(
      run({ headers: { 'idempotency-key': KEY, 'if-match': ' 3 ' } }, handler),
    ).resolves.toEqual({ n: 1 });
    expect(handler).not.toHaveBeenCalled();
    const error = await run(
      { headers: { 'idempotency-key': KEY, 'if-match': 'abc' } },
      ok({}),
    ).catch((e: unknown) => e);
    expect((error as DomainError).code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('the query string and body key order do not change the hash', async () => {
    const { run } = setup();
    await run({ body: { a: 1, b: 2 }, url: '/things?x=1' }, ok({ n: 1 }));
    await expect(run({ body: { b: 2, a: 1 }, url: '/things?y=2' }, ok({ n: 2 }))).resolves.toEqual({
      n: 1,
    });
  });

  it('a reservation still running is a 409 IDEMPOTENCY_IN_PROGRESS', async () => {
    const store = new MemoryStore();
    store.rows.set(`u1:${KEY}`, {
      hash: hashRequest({ method: 'POST', path: '/things', body: { name: 'a' }, extra: {} }),
      state: 'in_progress',
    });
    const { run } = setup(store);
    const handler = ok({});
    const error = await run({}, handler).catch((e: unknown) => e);
    expect((error as DomainError).code).toBe('IDEMPOTENCY_IN_PROGRESS');
    expect(handler).not.toHaveBeenCalled();
  });

  it('delegates abandoned reservations to the store (a stale one is reported as new)', async () => {
    const store = new MemoryStore();
    vi.spyOn(store, 'reserve').mockResolvedValueOnce({ kind: 'new' });
    const { run } = setup(store);
    const handler = ok({ id: 9 });
    await expect(run({}, handler)).resolves.toEqual({ id: 9 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('a handler error releases the key, is rethrown, and a retry runs again', async () => {
    const { run, store } = setup();
    const boom = new DomainError('not_found', 'x');
    const error = await run(
      {},
      vi.fn(() => throwError(() => boom)),
    ).catch((e: unknown) => e);
    expect(error).toBe(boom);
    expect(store.rows.size).toBe(0);
    const retry = ok({ id: 3 });
    await expect(run({}, retry)).resolves.toEqual({ id: 3 });
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('keys are scoped by actor', async () => {
    const { run } = setup();
    await run({ auth: { userId: 'u1' } }, ok({ who: 1 }));
    await expect(run({ auth: { userId: 'u2' } }, ok({ who: 2 }))).resolves.toEqual({ who: 2 });
  });

  it('a storage failure on complete is logged and the result is still answered', async () => {
    const store = new MemoryStore();
    store.failComplete = true;
    const { run, warns } = setup(store);
    await expect(run({}, ok({ id: 1 }))).resolves.toEqual({ id: 1 });
    expect(warns.map((w) => w.event)).toEqual(['idempotency.store_failed']);
  });

  it('a purge failure is logged and the request continues', async () => {
    const store = new MemoryStore();
    store.failPurge = true;
    const { run, warns } = setup(store);
    await expect(run({}, ok({ id: 1 }))).resolves.toEqual({ id: 1 });
    expect(warns.map((w) => w.event)).toEqual(['idempotency.purge_failed']);
  });
});

describe('IdempotencyInterceptor replay authorization', () => {
  const SERVICE = Symbol('service');
  const handlerFn = () => undefined;

  function build(check: ReplayAuthorization<{ name: string }>['check']) {
    const store = new MemoryStore();
    const log: AuditLog = { info: () => undefined, warn: () => undefined };
    const authorization: ReplayAuthorization<{ name: string }> = { token: SERVICE, check };
    const reflector = { get: vi.fn(() => authorization) } as unknown as Reflector;
    const moduleRef = { get: vi.fn(() => ({ name: 'svc' })) } as unknown as ModuleRef;
    const interceptor = new IdempotencyInterceptor(store, log, reflector, moduleRef);
    const reply = { statusCode: 201, status: vi.fn() };
    reply.status.mockImplementation((code: number) => {
      reply.statusCode = code;
      return reply;
    });
    const req = {
      headers: { 'idempotency-key': KEY },
      method: 'POST',
      url: '/things',
      body: {},
      params: { id: 'abc' },
      auth: { userId: 'u1', permissions: ['x'] },
    };
    const context = {
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => reply }),
      getHandler: () => handlerFn,
    } as unknown as ExecutionContext;
    const run = (handler: () => ReturnType<CallHandler['handle']>) =>
      interceptor.intercept(context, { handle: handler }).then((obs) => lastValueFrom(obs));
    return { run, moduleRef };
  }

  it('does not authorize a new request (the use case does) but does authorize a replay', async () => {
    const check = vi.fn(() => Promise.resolve());
    const { run, moduleRef } = build(check);
    await run(ok({ id: 1 }));
    expect(check).not.toHaveBeenCalled();
    const handler = ok({ id: 2 });
    await expect(run(handler)).resolves.toEqual({ id: 1 });
    expect(moduleRef.get).toHaveBeenCalledWith(SERVICE, { strict: false });
    expect(check).toHaveBeenCalledWith(
      { name: 'svc' },
      { userId: 'u1', permissions: ['x'] },
      expect.objectContaining({ params: { id: 'abc' } }),
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it('a denied replay answers the authorization error, not the stored response', async () => {
    const denied = new DomainError('forbidden', 'No');
    let allow = true;
    const { run } = build(() => (allow ? Promise.resolve() : Promise.reject(denied)));
    await run(ok({ id: 1 }));
    allow = false;
    await expect(run(ok({ id: 2 }))).rejects.toBe(denied);
    allow = true;
    await expect(run(ok({ id: 3 }))).resolves.toEqual({ id: 1 });
  });
});
