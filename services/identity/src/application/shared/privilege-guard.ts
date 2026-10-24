import type { AuditLog } from '../../domain/shared/audit-log.js';
import { DomainError } from '../../domain/shared/errors.js';
import { type Actor, PRIVILEGE_ESCALATION_CODE } from '../../domain/shared/privilege-rules.js';

/** Runs a privilege check; a denial is logged (warn) before the error propagates. */
export function enforcePrivilege(
  log: AuditLog,
  actor: Actor,
  context: Record<string, unknown>,
  check: () => void,
): void {
  try {
    check();
  } catch (error) {
    if (error instanceof DomainError && error.code === PRIVILEGE_ESCALATION_CODE) {
      log.warn('privilege.escalation.denied', {
        actorId: actor.id,
        reason: error.message,
        ...context,
      });
    }
    throw error;
  }
}
