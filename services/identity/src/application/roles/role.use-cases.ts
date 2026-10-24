import type { PermissionRepository } from '../../domain/permission/permission.js';
import type { Role } from '../../domain/role/role.js';
import {
  assertCanChangePermissions,
  assertCanDeleteRole,
  assertCanRename,
  normalizeRoleName,
  ROLE_DESCRIPTION_MAX,
} from '../../domain/role/role-rules.js';
import type { RoleRepository } from '../../domain/role/role-repository.js';
import type { AuditLog } from '../../domain/shared/audit-log.js';
import { notFoundError, validationError } from '../../domain/shared/errors.js';
import {
  type Actor,
  assertCanGrant,
  assertNotOwnRole,
} from '../../domain/shared/privilege-rules.js';
import type { UserRepository } from '../../domain/user/user-repository.js';
import { enforcePrivilege } from '../shared/privilege-guard.js';

async function requireRole(roles: RoleRepository, id: string): Promise<Role> {
  const role = await roles.findById(id);
  if (!role) throw notFoundError('Rol no encontrado');
  return role;
}

function normalizeDescription(raw: string): string {
  const description = raw.trim();
  if (description.length > ROLE_DESCRIPTION_MAX) {
    throw validationError('Datos inválidos', [
      {
        field: 'description',
        message: `La descripción no puede superar ${ROLE_DESCRIPTION_MAX} caracteres`,
      },
    ]);
  }
  return description;
}

/** Role the actor may not exceed: its current permissions must be within the actor's. */
function assertRoleWithinActor(log: AuditLog, actor: Actor, role: Role, what: string): void {
  enforcePrivilege(log, actor, { operation: what, roleId: role.id }, () =>
    assertCanGrant(actor, role.permissions, what),
  );
}

function assertNotActorRole(log: AuditLog, actor: Actor, role: Role, what: string): void {
  enforcePrivilege(log, actor, { operation: what, roleId: role.id }, () =>
    assertNotOwnRole(actor, role.id),
  );
}

export class ListRolesUseCase {
  constructor(private readonly roles: RoleRepository) {}
  execute(): Promise<Role[]> {
    return this.roles.list();
  }
}

export class GetRoleUseCase {
  constructor(private readonly roles: RoleRepository) {}
  execute(id: string): Promise<Role> {
    return requireRole(this.roles, id);
  }
}

export class ListPermissionsUseCase {
  constructor(private readonly permissions: PermissionRepository) {}
  execute() {
    return this.permissions.listAll();
  }
}

export class CreateRoleUseCase {
  constructor(
    private readonly roles: RoleRepository,
    private readonly log: AuditLog,
  ) {}

  async execute(actor: Actor, input: { name: string; description?: string }): Promise<Role> {
    // A new role has no permissions, so it is always within the actor's.
    const role = await this.roles.create({
      name: normalizeRoleName(input.name),
      description: normalizeDescription(input.description ?? ''),
    });
    this.log.info('role.created', { actorId: actor.id, roleId: role.id, name: role.name });
    return role;
  }
}

export class UpdateRoleUseCase {
  constructor(
    private readonly roles: RoleRepository,
    private readonly log: AuditLog,
  ) {}

  async execute(
    actor: Actor,
    id: string,
    input: { name?: string; description?: string },
  ): Promise<Role> {
    const role = await requireRole(this.roles, id);
    assertRoleWithinActor(this.log, actor, role, 'editar ese rol');
    const changes: { name?: string; description?: string } = {};
    if (input.name !== undefined) {
      changes.name = normalizeRoleName(input.name);
      assertCanRename(role, changes.name);
    }
    assertNotActorRole(this.log, actor, role, 'editar tu propio rol');
    if (input.description !== undefined)
      changes.description = normalizeDescription(input.description);
    if (Object.keys(changes).length === 0) return role;
    const updated = await this.roles.update(id, changes);
    this.log.info('role.updated', { actorId: actor.id, roleId: id, fields: Object.keys(changes) });
    return updated;
  }
}

export class SetRolePermissionsUseCase {
  constructor(
    private readonly roles: RoleRepository,
    private readonly permissions: PermissionRepository,
    private readonly log: AuditLog,
  ) {}

  async execute(actor: Actor, id: string, codes: readonly string[]): Promise<Role> {
    const role = await requireRole(this.roles, id);
    assertRoleWithinActor(this.log, actor, role, 'cambiar los permisos de ese rol');
    assertCanChangePermissions(role);
    assertNotActorRole(this.log, actor, role, 'cambiar los permisos de tu propio rol');
    const unique = [...new Set(codes)];
    const missing = await this.permissions.findMissingCodes(unique);
    if (missing.length > 0) {
      throw validationError(
        'Datos inválidos',
        missing.map((code) => ({ field: 'permissions', message: `El permiso ${code} no existe` })),
      );
    }
    enforcePrivilege(this.log, actor, { operation: 'role.permissions', roleId: id }, () =>
      assertCanGrant(actor, unique, 'otorgar esos permisos'),
    );
    const updated = await this.roles.setPermissions(id, unique);
    const before = new Set(role.permissions);
    const after = new Set(unique);
    this.log.info('role.permissions.changed', {
      actorId: actor.id,
      roleId: id,
      added: unique.filter((code) => !before.has(code)),
      removed: role.permissions.filter((code) => !after.has(code)),
    });
    return updated;
  }
}

export class DeleteRoleUseCase {
  constructor(
    private readonly roles: RoleRepository,
    private readonly users: UserRepository,
    private readonly log: AuditLog,
  ) {}

  async execute(actor: Actor, id: string): Promise<void> {
    const role = await requireRole(this.roles, id);
    assertRoleWithinActor(this.log, actor, role, 'eliminar ese rol');
    if (role.isSystem) assertCanDeleteRole(role, 0);
    assertNotActorRole(this.log, actor, role, 'eliminar tu propio rol');
    assertCanDeleteRole(role, await this.users.countByRole(id));
    await this.roles.delete(id);
    this.log.info('role.deleted', { actorId: actor.id, roleId: id, name: role.name });
  }
}
