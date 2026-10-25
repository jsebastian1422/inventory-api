import { DomainError } from '../../domain/shared/errors.js';

/**
 * A VERSION_CONFLICT carries the server copy: answer it in the public representation, like any
 * other response of the resource.
 */
export async function presentingConflict<T, R extends { id: string }>(
  operation: Promise<T>,
  present: (resource: R) => unknown,
): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    if (error instanceof DomainError && error.code === 'VERSION_CONFLICT' && error.extra?.current) {
      throw new DomainError(error.kind, error.message, error.code, error.details, {
        current: present(error.extra.current as R),
      });
    }
    throw error;
  }
}
