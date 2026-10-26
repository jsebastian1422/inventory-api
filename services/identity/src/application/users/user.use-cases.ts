import type { PasswordHasher, RefreshTokenRepository } from '../../domain/auth/ports.js';
import type { Role } from '../../domain/role/role.js';
import type { RoleRepository } from '../../domain/role/role-repository.js';
import type { AuditLog } from '../../domain/shared/audit-log.js';
import { normalizeEmail } from '../../domain/shared/email.js';
import { conflictError, notFoundError, validationError } from '../../domain/shared/errors.js';
import { type Actor, assertCanGrant } from '../../domain/shared/privilege-rules.js';
import {
  assertNotLastActiveAdmin,
  assertNotSelfPasswordReset,
} from '../../domain/user/admin-rules.js';
import { assertPasswordPolicy } from '../../domain/user/password-policy.js';
import { FULL_NAME_MAX, type User } from '../../domain/user/user.js';
import type { UserChanges, UserRepository } from '../../domain/user/user-repository.js';
import { enforcePrivilege } from '../shared/privilege-guard.js';

function normalizeFullName(raw: string): string {
  const name = raw.trim();
  if (name.length === 0 || name.length > FULL_NAME_MAX) {
    throw validationError('Datos inválidos', [
      {
        field: 'fullName',
        message: `El nombre es obligatorio y no puede superar ${FULL_NAME_MAX} caracteres`,
      },
    ]);
  }
  return name;
}

async function requireUser(users: UserRepository, id: string): Promise<User> {
  const user = await users.findById(id);
  if (!user) throw notFoundError('Usuario no encontrado');
  return user;
}

async function requireRole(roles: RoleRepository, roleId: string): Promise<Role> {
  const role = await roles.findById(roleId);
  if (!role) {
    throw validationError('Datos inválidos', [
      { field: 'roleId', message: 'El rol indicado no existe' },
    ]);
  }
  return role;
}

/** Operating on a user requires holding every permission of that user's role. */
async function assertCanManageTarget(
  roles: RoleRepository,
  log: AuditLog,
  actor: Actor,
  target: User,
  what: string,
): Promise<void> {
  const role = await requireRole(roles, target.role.id);
  enforcePrivilege(log, actor, { userId: target.id, targetRoleId: role.id, operation: what }, () =>
    assertCanGrant(actor, role.permissions, what),
  );
}

export class ListUsersUseCase {
  constructor(private readonly users: UserRepository) {}
  execute(limit: number, offset: number) {
    return this.users.list(limit, offset);
  }
}

export class GetUserUseCase {
  constructor(private readonly users: UserRepository) {}
  execute(id: string): Promise<User> {
    return requireUser(this.users, id);
  }
}

export class CreateUserUseCase {
  constructor(
    private readonly users: UserRepository,
    private readonly roles: RoleRepository,
    private readonly hasher: PasswordHasher,
    private readonly log: AuditLog,
  ) {}

  async execute(
    actor: Actor,
    input: { email: string; password: string; fullName: string; roleId: string },
  ): Promise<User> {
    const email = normalizeEmail(input.email);
    const fullName = normalizeFullName(input.fullName);
    assertPasswordPolicy(input.password);
    const role = await requireRole(this.roles, input.roleId);
    enforcePrivilege(this.log, actor, { operation: 'user.create', roleId: role.id }, () =>
      assertCanGrant(actor, role.permissions, 'asignar ese rol'),
    );
    const user = await this.users.create({
      email,
      fullName,
      roleId: input.roleId,
      passwordHash: await this.hasher.hash(input.password),
    });
    this.log.info('user.created', {
      actorId: actor.id,
      userId: user.id,
      email: user.email,
      roleId: input.roleId,
    });
    return user;
  }
}

export class UpdateUserUseCase {
  constructor(
    private readonly users: UserRepository,
    private readonly roles: RoleRepository,
    private readonly log: AuditLog,
  ) {}

  execute(
    actor: Actor,
    id: string,
    input: { email?: string; fullName?: string; roleId?: string },
  ): Promise<User> {
    // Atomic with the "last administrator" check: see UserRepository.runExclusive.
    return this.users.runExclusive(async (users) => {
      const target = await requireUser(users, id);
      await assertCanManageTarget(
        this.roles,
        this.log,
        actor,
        target,
        'editar a un usuario con ese rol',
      );
      const changes: { -readonly [K in keyof UserChanges]: UserChanges[K] } = {};
      if (input.email !== undefined) changes.email = normalizeEmail(input.email);
      if (input.fullName !== undefined) changes.fullName = normalizeFullName(input.fullName);
      if (input.roleId !== undefined && input.roleId !== target.role.id) {
        const newRole = await requireRole(this.roles, input.roleId);
        enforcePrivilege(
          this.log,
          actor,
          { operation: 'user.update', userId: id, roleId: newRole.id },
          () => assertCanGrant(actor, newRole.permissions, 'asignar ese rol'),
        );
        assertNotLastActiveAdmin(
          target,
          await users.countActiveSystemRoleUsers(id),
          'cambiar el rol del',
        );
        changes.roleId = input.roleId;
      }
      if (Object.keys(changes).length === 0) return target;
      const updated = await users.update(id, changes);
      this.log.info('user.updated', {
        actorId: actor.id,
        userId: id,
        fields: Object.keys(changes),
        ...(changes.roleId ? { previousRoleId: target.role.id, newRoleId: changes.roleId } : {}),
      });
      return updated;
    });
  }
}

export class SetUserStatusUseCase {
  constructor(
    private readonly users: UserRepository,
    private readonly roles: RoleRepository,
    private readonly refreshTokens: RefreshTokenRepository,
    private readonly log: AuditLog,
  ) {}

  async execute(actor: Actor, id: string, isActive: boolean): Promise<User> {
    // Atomic with the "last administrator" check: see UserRepository.runExclusive.
    const result = await this.users.runExclusive(async (users) => {
      const target = await requireUser(users, id);
      await assertCanManageTarget(
        this.roles,
        this.log,
        actor,
        target,
        isActive ? 'activar a un usuario con ese rol' : 'desactivar a un usuario con ese rol',
      );
      if (target.isActive === isActive) return { user: target, changed: false };
      if (!isActive) {
        assertNotLastActiveAdmin(
          target,
          await users.countActiveSystemRoleUsers(id),
          'desactivar al',
        );
        if (actor.id.toLowerCase() === id.toLowerCase()) {
          throw conflictError('No puedes desactivar tu propio usuario', 'SELF_DEACTIVATION');
        }
      }
      await users.setActive(id, isActive);
      return { user: await requireUser(users, id), changed: true };
    });
    if (result.changed) {
      if (!isActive) await this.refreshTokens.revokeAllForUser(id);
      this.log.info(isActive ? 'user.activated' : 'user.deactivated', {
        actorId: actor.id,
        userId: id,
      });
    }
    return result.user;
  }
}

export class ResetUserPasswordUseCase {
  constructor(
    private readonly users: UserRepository,
    private readonly roles: RoleRepository,
    private readonly hasher: PasswordHasher,
    private readonly refreshTokens: RefreshTokenRepository,
    private readonly log: AuditLog,
  ) {}

  async execute(actor: Actor, id: string, newPassword: string): Promise<void> {
    assertNotSelfPasswordReset(actor.id, id);
    const target = await requireUser(this.users, id);
    await assertCanManageTarget(
      this.roles,
      this.log,
      actor,
      target,
      'restablecer la contraseña de un usuario con ese rol',
    );
    assertPasswordPolicy(newPassword, 'newPassword');
    await this.users.updatePassword(id, await this.hasher.hash(newPassword));
    await this.refreshTokens.revokeAllForUser(id);
    this.log.info('user.password.reset', { actorId: actor.id, userId: id });
  }
}
