import type { EstablishmentScope } from './scope.js';

/** Port: resolves the live scope of a user. One query per request, no cache. */
export interface ScopeReader {
  /** To operate. `all` = the user holds `establishments.all`. Inactive establishments are never included. */
  resolve(userId: string, all: boolean): Promise<EstablishmentScope>;
  /**
   * To read sales: ids of the establishments with a current assignment of the user (removed_at
   * IS NULL), active or not. Never used to operate (sprint 010, RE-3).
   */
  resolveAssignedForRead(userId: string): Promise<string[]>;
}
