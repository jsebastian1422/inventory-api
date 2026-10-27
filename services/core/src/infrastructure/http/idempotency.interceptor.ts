import {
  applyDecorators,
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
  Optional,
  SetMetadata,
  UseInterceptors,
} from '@nestjs/common';
import { ModuleRef, Reflector } from '@nestjs/core';
import type { FastifyReply } from 'fastify';
import { catchError, from, mergeMap, of, throwError, type Observable } from 'rxjs';
import type { AuditLog } from '../../domain/shared/audit-log.js';
import { conflictError, validationError } from '../../domain/shared/errors.js';
import {
  hashRequest,
  IDEMPOTENCY_PURGE_BATCH,
  type IdempotencyStore,
} from '../../domain/sync/idempotency.js';
import type { AuthenticatedRequest } from './auth-decorators.js';
import { parseIfMatch } from './if-match.js';
import { AUDIT_LOG, IDEMPOTENCY_STORE } from './tokens.js';

/** Metadata key under which `@Idempotent({ authorize })` stores the replay authorization. */
export const REPLAY_AUTHORIZATION_KEY = 'idempotency:authorize';

/**
 * Authorization a replay must pass again before the stored response is returned (spec 004 section 7):
 * the same live checks a new request would face, for endpoints whose checks live in the use case
 * (ownership, scope) and not in the guard. `check` throws the same error a new request would.
 */
export interface ReplayAuthorization<T = unknown> {
  /** Provider that `check` receives (resolved from the Nest container). */
  readonly token: string | symbol;
  readonly check: (
    service: T,
    actor: { userId: string; permissions: readonly string[] },
    request: AuthenticatedRequest,
  ) => Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * If-Match for the fingerprint: the integer version as text, so `"3"` and `3` hash the same.
 * A malformed value keeps its trimmed text (the handler answers the 400); absent stays undefined.
 */
function normalizeIfMatch(header: string | string[] | undefined): string | undefined {
  try {
    const version = parseIfMatch(header);
    return version === undefined ? undefined : String(version);
  } catch {
    return typeof header === 'string' ? header.trim() : undefined;
  }
}

/**
 * Applies the Idempotency-Key protocol (ADR-0002) to the endpoints marked with `@Idempotent()`.
 * Runs after the global guard (actor known). Without the header the request is untouched.
 * Only 2xx responses are stored; errors release the key so a retry is evaluated again.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    @Inject(IDEMPOTENCY_STORE) private readonly store: IdempotencyStore,
    @Inject(AUDIT_LOG) private readonly log: AuditLog,
    @Optional() @Inject(Reflector) private readonly reflector?: Reflector,
    @Optional() @Inject(ModuleRef) private readonly moduleRef?: ModuleRef,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const http = context.switchToHttp();
    const request = http.getRequest<AuthenticatedRequest>();
    const reply = http.getResponse<FastifyReply>();
    const header = request.headers['idempotency-key'];
    if (header === undefined) return next.handle();
    if (typeof header !== 'string' || !UUID.test(header.trim())) {
      throw validationError('Datos inválidos', [
        { field: 'Idempotency-Key', message: 'Debe ser un UUID' },
      ]);
    }
    const key = header.trim().toLowerCase();
    const actorId = request.auth!.userId;
    const path = request.url.split('?')[0]!;
    const ifMatch = request.headers['if-match'];
    const hash = hashRequest({
      method: request.method,
      path,
      body: request.body,
      extra: { 'if-match': normalizeIfMatch(ifMatch) },
    });

    const now = new Date();
    await this.purge(now);
    const reservation = await this.store.reserve(actorId, key, hash, now);
    switch (reservation.kind) {
      case 'mismatch':
        throw conflictError(
          'La clave de idempotencia ya se usó con otro contenido',
          'IDEMPOTENCY_KEY_REUSED',
        );
      case 'in_progress':
        throw conflictError(
          'Hay una petición en curso con esa clave de idempotencia',
          'IDEMPOTENCY_IN_PROGRESS',
        );
      case 'replay':
        // The key stays reserved and untouched: a denied replay answers the current error.
        await this.authorizeReplay(context, request);
        this.log.info('idempotency.replayed', { actorId, key, method: request.method, path });
        void reply.status(reservation.statusCode);
        return of(reservation.response);
      case 'new':
        break;
    }

    return next.handle().pipe(
      mergeMap((value) => from(this.complete(actorId, key, reply.statusCode, value))),
      catchError((error: unknown) =>
        from(this.release(actorId, key)).pipe(mergeMap(() => throwError(() => error))),
      ),
    );
  }

  /** Runs the endpoint's replay authorization, if it declared one (see `ReplayAuthorization`). */
  private async authorizeReplay(
    context: ExecutionContext,
    request: AuthenticatedRequest,
  ): Promise<void> {
    const authorization = this.reflector?.get<ReplayAuthorization | undefined>(
      REPLAY_AUTHORIZATION_KEY,
      context.getHandler(),
    );
    if (!authorization) return;
    const service = this.moduleRef!.get(authorization.token, { strict: false });
    const { userId, permissions } = request.auth!;
    await authorization.check(service, { userId, permissions }, request);
  }

  /** Stores the result; a storage failure is logged and the successful result is still answered. */
  private async complete(
    actorId: string,
    key: string,
    statusCode: number,
    value: unknown,
  ): Promise<unknown> {
    try {
      // JSON round trip so the stored body is what the client received (dates as ISO text).
      const body: unknown = value === undefined ? null : JSON.parse(JSON.stringify(value));
      await this.store.complete(actorId, key, statusCode, body);
    } catch (error) {
      this.log.warn('idempotency.store_failed', {
        actorId,
        key,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    return value;
  }

  private async release(actorId: string, key: string): Promise<void> {
    try {
      await this.store.release(actorId, key);
    } catch (error) {
      this.log.warn('idempotency.store_failed', {
        actorId,
        key,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async purge(now: Date): Promise<void> {
    try {
      await this.store.purgeExpired(now, IDEMPOTENCY_PURGE_BATCH);
    } catch (error) {
      this.log.warn('idempotency.purge_failed', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * Marks an endpoint as idempotent (honours the optional `Idempotency-Key` header). A replay returns
 * the stored response only after passing `authorize` (when given) with the live permissions.
 */
export const Idempotent = <T>(options: { authorize?: ReplayAuthorization<T> } = {}) =>
  applyDecorators(
    ...(options.authorize ? [SetMetadata(REPLAY_AUTHORIZATION_KEY, options.authorize)] : []),
    UseInterceptors(IdempotencyInterceptor),
  );
