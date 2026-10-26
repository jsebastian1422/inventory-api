import type { EstablishmentScope } from './scope.js';

/** Port: resolves the live scope of a user. One query per request, no cache. */
export interface ScopeReader {
  /** `all` = the user holds `establishments.all`. Inactive establishments are never included. */
  resolve(userId: string, all: boolean): Promise<EstablishmentScope>;
}
