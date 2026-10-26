import { assertNotSelf, type Assignment } from '../../domain/assignment/assignment.js';
import type {
  AssignmentPage,
  AssignmentRepository,
} from '../../domain/assignment/assignment-repository.js';
import type { EstablishmentRepository } from '../../domain/establishment/establishment-repository.js';
import type { AuditLog } from '../../domain/shared/audit-log.js';
import { conflictError, notFoundError } from '../../domain/shared/errors.js';

const ESTABLISHMENT_NOT_FOUND = 'Establecimiento no encontrado';
const USER_NOT_FOUND = 'Usuario no encontrado';
const ASSIGNMENT_NOT_FOUND = 'El usuario no está asignado a este establecimiento';

/**
 * Assignments of users to establishments (administration, online only). Assigning and removing
 * record an audit event with `establishmentId`, `userId` and `actorId`.
 */
export class AssignmentUseCases {
  constructor(
    private readonly assignments: AssignmentRepository,
    private readonly establishments: EstablishmentRepository,
    private readonly log: AuditLog,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Order: establishment (404, 409) -> user (404, 409) -> own user (403). Idempotent: an existing
   * current assignment is answered with `created: false` and no event.
   */
  async assign(
    actorId: string,
    establishmentId: string,
    userId: string,
  ): Promise<{ assignment: Assignment; created: boolean }> {
    const establishment = await this.establishments.findById(establishmentId);
    if (!establishment) throw notFoundError(ESTABLISHMENT_NOT_FOUND);
    if (!establishment.isActive) {
      throw conflictError('El establecimiento está inactivo', 'ESTABLISHMENT_INACTIVE');
    }
    const user = await this.assignments.findUser(userId);
    if (!user) throw notFoundError(USER_NOT_FOUND);
    if (!user.isActive) throw conflictError('El usuario está inactivo', 'USER_INACTIVE');
    assertNotSelf(actorId, userId);
    const result = await this.assignments.assign(establishmentId, userId, actorId, this.now());
    if (result.created) this.event('establishment.user_assigned', establishmentId, userId, actorId);
    return result;
  }

  /**
   * Own user (403) first, then 404: unknown establishment or no current assignment (the
   * establishment is only looked up on failure, to word the message). The history is kept (R-2).
   */
  async remove(actorId: string, establishmentId: string, userId: string): Promise<void> {
    assertNotSelf(actorId, userId);
    const removed = await this.assignments.remove(establishmentId, userId, actorId, this.now());
    if (!removed) {
      if (!(await this.establishments.findById(establishmentId))) {
        throw notFoundError(ESTABLISHMENT_NOT_FOUND);
      }
      throw notFoundError(ASSIGNMENT_NOT_FOUND);
    }
    this.event('establishment.user_removed', establishmentId, userId, actorId);
  }

  async listByEstablishment(establishmentId: string, page: AssignmentPage) {
    if (!(await this.establishments.findById(establishmentId))) {
      throw notFoundError(ESTABLISHMENT_NOT_FOUND);
    }
    return this.assignments.listByEstablishment(establishmentId, page);
  }

  async listByUser(userId: string, page: AssignmentPage) {
    if (!(await this.assignments.findUser(userId))) throw notFoundError(USER_NOT_FOUND);
    return this.assignments.listByUser(userId, page);
  }

  private event(name: string, establishmentId: string, userId: string, actorId: string): void {
    this.log.info(name, { establishmentId, userId, actorId });
  }
}
