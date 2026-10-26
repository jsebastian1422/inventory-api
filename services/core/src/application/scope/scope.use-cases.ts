import type { Establishment } from '../../domain/establishment/establishment.js';
import type { EstablishmentRepository } from '../../domain/establishment/establishment-repository.js';
import {
  assertInScope,
  hasFullAccess,
  type Actor,
  type EstablishmentScope,
} from '../../domain/scope/scope.js';
import type { ScopeReader } from '../../domain/scope/scope-reader.js';

/** Scope of a user by establishment (ADR-0004), always evaluated live on each request. */
export class ScopeUseCases {
  constructor(
    private readonly scopes: ScopeReader,
    private readonly establishments: EstablishmentRepository,
  ) {}

  resolve(actor: Actor): Promise<EstablishmentScope> {
    return this.scopes.resolve(actor.userId, hasFullAccess(actor));
  }

  /** 404 / 409 / 403 per R-5; returns the establishment when the actor may operate in it. */
  async assertInScope(actor: Actor, establishmentId: string): Promise<Establishment> {
    const establishment = await this.establishments.findById(establishmentId);
    const scope = await this.resolve(actor);
    assertInScope(establishment, scope);
    return establishment!;
  }

  /** Establishments the actor can operate in, with how the access was obtained. */
  async myEstablishments(
    actor: Actor,
  ): Promise<{ access: 'all' | 'assigned'; items: Establishment[] }> {
    const scope = await this.resolve(actor);
    const items = scope.ids.length > 0 ? await this.establishments.findByIds(scope.ids) : [];
    return { access: scope.access, items };
  }
}
