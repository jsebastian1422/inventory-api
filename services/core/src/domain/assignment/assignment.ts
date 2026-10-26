import { forbiddenError } from '../shared/errors.js';

/** User data shown with an assignment (read from identity's `users`, never written). */
export interface AssignmentUser {
  readonly id: string;
  readonly fullName: string;
  readonly email: string;
  readonly isActive: boolean;
}

/** Link between a user and an establishment. Removal is logical (R-2): the row is kept. */
export interface Assignment {
  readonly id: string;
  readonly establishmentId: string;
  readonly user: AssignmentUser;
  readonly assignedBy: string;
  readonly assignedAt: Date;
  readonly removedBy: string | null;
  readonly removedAt: Date | null;
}

/** R-6: nobody assigns or removes themselves (same anti-escalation rule as the identity service). */
export function assertNotSelf(actorId: string, userId: string): void {
  if (actorId.toLowerCase() === userId.toLowerCase()) {
    throw forbiddenError(
      'No puedes asignarte ni retirarte a ti mismo de un local',
      'SELF_ASSIGNMENT',
    );
  }
}
