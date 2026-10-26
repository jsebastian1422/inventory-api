import type { EstablishmentScopePermission } from '@inventory/shared';
import { Controller, Delete, Get, HttpCode, Inject, Param, Put, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { AssignmentUseCases } from '../../application/assignments/assignment.use-cases.js';
import type { Assignment } from '../../domain/assignment/assignment.js';
import { CurrentUserId, RequirePermissions } from './auth-decorators.js';
import { assignmentPageQuerySchema, idSchema, userAssignmentsQuerySchema } from './schemas.js';
import { ASSIGNMENT_USE_CASES } from './tokens.js';
import { ZodValidationPipe } from './zod-validation.pipe.js';

const PERM_ASSIGN = 'establishments.assign' satisfies EstablishmentScopePermission;

const idPipe = new ZodValidationPipe(idSchema);

interface PageQuery {
  includeRemoved: boolean;
  limit: number;
  offset: number;
}

function present(a: Assignment) {
  return {
    id: a.id,
    establishmentId: a.establishmentId,
    user: {
      id: a.user.id,
      fullName: a.user.fullName,
      email: a.user.email,
      isActive: a.user.isActive,
    },
    assignedBy: a.assignedBy,
    assignedAt: a.assignedAt,
    removedBy: a.removedBy,
    removedAt: a.removedAt,
  };
}

/** Assignments of users to establishments (administration, online only: no idempotency or version). */
@Controller()
export class AssignmentsController {
  constructor(@Inject(ASSIGNMENT_USE_CASES) private readonly uc: AssignmentUseCases) {}

  /** 201 when created, 200 when the pair was already assigned. */
  @Put('establishments/:id/users/:userId')
  @RequirePermissions(PERM_ASSIGN)
  async assign(
    @CurrentUserId() actorId: string,
    @Param('id', idPipe) establishmentId: string,
    @Param('userId', idPipe) userId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { assignment, created } = await this.uc.assign(actorId, establishmentId, userId);
    void reply.code(created ? 201 : 200);
    return present(assignment);
  }

  @Delete('establishments/:id/users/:userId')
  @RequirePermissions(PERM_ASSIGN)
  @HttpCode(204)
  async remove(
    @CurrentUserId() actorId: string,
    @Param('id', idPipe) establishmentId: string,
    @Param('userId', idPipe) userId: string,
  ): Promise<void> {
    await this.uc.remove(actorId, establishmentId, userId);
  }

  @Get('establishments/:id/users')
  @RequirePermissions(PERM_ASSIGN)
  async listByEstablishment(
    @Param('id', idPipe) establishmentId: string,
    @Query(new ZodValidationPipe(assignmentPageQuerySchema)) query: PageQuery,
  ) {
    const { items, total } = await this.uc.listByEstablishment(establishmentId, query);
    return { items: items.map(present), total, limit: query.limit, offset: query.offset };
  }

  @Get('establishment-assignments')
  @RequirePermissions(PERM_ASSIGN)
  async listByUser(
    @Query(new ZodValidationPipe(userAssignmentsQuerySchema)) query: PageQuery & { userId: string },
  ) {
    const { items, total } = await this.uc.listByUser(query.userId, query);
    return { items: items.map(present), total, limit: query.limit, offset: query.offset };
  }
}
