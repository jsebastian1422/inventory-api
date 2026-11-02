export type ErrorKind =
  'validation' | 'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'rate_limited';

export interface FieldIssue {
  readonly field: string;
  readonly message: string;
}

/** Business error. The HTTP layer maps `kind` to a status code; messages are user-facing (Spanish). */
export class DomainError extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
    readonly code?: string,
    readonly details?: readonly FieldIssue[],
    /** Seconds the client should wait (`rate_limited` only); sent as `Retry-After`. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export const validationError = (message: string, details?: readonly FieldIssue[]): DomainError =>
  new DomainError('validation', message, 'VALIDATION_ERROR', details);
export const unauthorizedError = (message: string, code = 'UNAUTHORIZED'): DomainError =>
  new DomainError('unauthorized', message, code);
export const forbiddenError = (message: string, code = 'FORBIDDEN'): DomainError =>
  new DomainError('forbidden', message, code);
export const notFoundError = (message: string): DomainError =>
  new DomainError('not_found', message, 'NOT_FOUND');
export const conflictError = (message: string, code: string): DomainError =>
  new DomainError('conflict', message, code);
/** Too many attempts: the HTTP layer answers 429 with `Retry-After`. */
export const tooManyAttemptsError = (message: string, retryAfterSeconds: number): DomainError =>
  new DomainError('rate_limited', message, 'TOO_MANY_ATTEMPTS', undefined, retryAfterSeconds);
