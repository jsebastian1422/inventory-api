import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import type { Actor } from '../../domain/shared/privilege-rules.js';
import { CurrentActor, RequirePermissions } from './auth-decorators.js';
import type { UseCases } from './composition.js';
import { createRoleSchema, idSchema, rolePermissionsSchema, updateRoleSchema } from './schemas.js';
import { USE_CASES } from './tokens.js';
import { ZodValidationPipe } from './zod-validation.pipe.js';

const idPipe = new ZodValidationPipe(idSchema);

@Controller()
export class RolesController {
  constructor(@Inject(USE_CASES) private readonly uc: UseCases) {}

  @Get('roles')
  @RequirePermissions('roles.read')
  async list() {
    return { items: await this.uc.listRoles.execute() };
  }

  @Get('roles/:id')
  @RequirePermissions('roles.read')
  get(@Param('id', idPipe) id: string) {
    return this.uc.getRole.execute(id);
  }

  @Get('permissions')
  @RequirePermissions('roles.read')
  async permissions() {
    return { items: await this.uc.listPermissions.execute() };
  }

  @Post('roles')
  @RequirePermissions('roles.create')
  create(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(createRoleSchema)) body: { name: string; description?: string },
  ) {
    return this.uc.createRole.execute(actor, body);
  }

  @Patch('roles/:id')
  @RequirePermissions('roles.update')
  update(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(updateRoleSchema)) body: { name?: string; description?: string },
  ) {
    return this.uc.updateRole.execute(actor, id, body);
  }

  @Put('roles/:id/permissions')
  @RequirePermissions('roles.update')
  setPermissions(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(rolePermissionsSchema)) body: { permissions: string[] },
  ) {
    return this.uc.setRolePermissions.execute(actor, id, body.permissions);
  }

  @Delete('roles/:id')
  @RequirePermissions('roles.delete')
  @HttpCode(204)
  async remove(@CurrentActor() actor: Actor, @Param('id', idPipe) id: string) {
    await this.uc.deleteRole.execute(actor, id);
  }
}
