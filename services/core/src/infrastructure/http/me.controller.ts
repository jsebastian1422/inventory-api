import { Controller, Get, Inject } from '@nestjs/common';
import type { ScopeUseCases } from '../../application/scope/scope.use-cases.js';
import type { Actor } from '../../domain/scope/scope.js';
import { CurrentActor } from './auth-decorators.js';
import { present } from './establishments.controller.js';
import { SCOPE_USE_CASES } from './tokens.js';

/** Endpoints of the authenticated user itself: any active user, no specific permission. */
@Controller('me')
export class MeController {
  constructor(@Inject(SCOPE_USE_CASES) private readonly uc: ScopeUseCases) {}

  /** Establishments the user can operate in (assigned and active, or every active one). */
  @Get('establishments')
  async establishments(@CurrentActor() actor: Actor) {
    const { access, items } = await this.uc.myEstablishments(actor);
    return { items: items.map((e) => ({ ...present(e), access })) };
  }
}
