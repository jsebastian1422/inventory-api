import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { validationError } from '../../domain/shared/errors.js';
import { isValidVersion } from '../../domain/sync/version.js';

const VERSION = /^(?:"(\d+)"|(\d+))$/;

/**
 * Reads the expected version of an `If-Match` header: an integer >= 1, quoted or not.
 * Returns undefined when the header is absent; throws a 400 when malformed (`*` is not supported).
 */
export function parseIfMatch(header: string | string[] | undefined): number | undefined {
  if (header === undefined) return undefined;
  const fail = () =>
    validationError('Datos inválidos', [
      { field: 'If-Match', message: 'Debe ser la versión (entero mayor o igual a 1)' },
    ]);
  if (typeof header !== 'string') throw fail();
  const match = VERSION.exec(header.trim());
  const version = match ? Number(match[1] ?? match[2]) : NaN;
  if (!isValidVersion(version)) throw fail();
  return version;
}

/** Expected version from `If-Match` (undefined when the client did not send it). */
export const IfMatchVersion = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): number | undefined =>
    parseIfMatch(ctx.switchToHttp().getRequest<FastifyRequest>().headers['if-match']),
);
