import type { Assignment, AssignmentUser } from './assignment.js';

export interface AssignmentPage {
  readonly includeRemoved: boolean;
  readonly limit: number;
  readonly offset: number;
}

export interface AssignmentRepository {
  /** Read-only lookup of a user in identity's table (ADR-0001). */
  findUser(userId: string): Promise<AssignmentUser | null>;
  /**
   * One transaction: locks the establishment FOR SHARE (404 when missing, 409 ESTABLISHMENT_INACTIVE
   * when inactive) and inserts the current assignment. When the pair already has a current
   * assignment (also under a race) it returns that one with `created: false`; never fails on it.
   */
  assign(
    establishmentId: string,
    userId: string,
    actorId: string,
    now: Date,
  ): Promise<{ assignment: Assignment; created: boolean }>;
  /** Marks the current assignment as removed; false when there is none (race-safe: one winner). */
  remove(establishmentId: string, userId: string, actorId: string, now: Date): Promise<boolean>;
  /** Newest first, ties by id; `total` ignores limit/offset. */
  listByEstablishment(
    establishmentId: string,
    page: AssignmentPage,
  ): Promise<{ items: Assignment[]; total: number }>;
  listByUser(userId: string, page: AssignmentPage): Promise<{ items: Assignment[]; total: number }>;
}
