import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import type { Actor } from '../../domain/shared/privilege-rules.js';
import { CurrentActor, RequirePermissions } from './auth-decorators.js';
import type { UseCases } from './composition.js';
import {
  createUserSchema,
  idSchema,
  listUsersQuerySchema,
  resetPasswordSchema,
  updateUserSchema,
  userStatusSchema,
} from './schemas.js';
import { USE_CASES } from './tokens.js';
import { ZodValidationPipe } from './zod-validation.pipe.js';

const idPipe = new ZodValidationPipe(idSchema);

@Controller('users')
export class UsersController {
  constructor(@Inject(USE_CASES) private readonly uc: UseCases) {}

  @Get()
  @RequirePermissions('users.read')
  async list(
    @Query(new ZodValidationPipe(listUsersQuerySchema)) query: { limit: number; offset: number },
  ) {
    const { items, total } = await this.uc.listUsers.execute(query.limit, query.offset);
    return { items, total, limit: query.limit, offset: query.offset };
  }

  @Get(':id')
  @RequirePermissions('users.read')
  get(@Param('id', idPipe) id: string) {
    return this.uc.getUser.execute(id);
  }

  @Post()
  @RequirePermissions('users.create')
  create(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(createUserSchema))
    body: { email: string; password: string; fullName: string; roleId: string },
  ) {
    return this.uc.createUser.execute(actor, body);
  }

  @Patch(':id')
  @RequirePermissions('users.update')
  update(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(updateUserSchema))
    body: { email?: string; fullName?: string; roleId?: string },
  ) {
    return this.uc.updateUser.execute(actor, id, body);
  }

  @Patch(':id/status')
  @RequirePermissions('users.deactivate')
  setStatus(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(userStatusSchema)) body: { isActive: boolean },
  ) {
    return this.uc.setUserStatus.execute(actor, id, body.isActive);
  }

  @Post(':id/reset-password')
  @RequirePermissions('users.update')
  @HttpCode(204)
  async resetPassword(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(resetPasswordSchema)) body: { newPassword: string },
  ) {
    await this.uc.resetPassword.execute(actor, id, body.newPassword);
  }
}
