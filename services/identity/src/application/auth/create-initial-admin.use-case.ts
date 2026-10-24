import type { PasswordHasher } from '../../domain/auth/ports.js';
import type { RoleRepository } from '../../domain/role/role-repository.js';
import type { AuditLog } from '../../domain/shared/audit-log.js';
import { normalizeEmail } from '../../domain/shared/email.js';
import { conflictError, notFoundError } from '../../domain/shared/errors.js';
import { assertPasswordPolicy } from '../../domain/user/password-policy.js';
import type { User } from '../../domain/user/user.js';
import type { UserRepository } from '../../domain/user/user-repository.js';

export class CreateInitialAdminUseCase {
  constructor(
    private readonly users: UserRepository,
    private readonly roles: RoleRepository,
    private readonly hasher: PasswordHasher,
    private readonly log: AuditLog,
  ) {}

  /** Fails when an administrator already exists (active or not). */
  async execute(input: { email: string; password: string; fullName: string }): Promise<User> {
    const email = normalizeEmail(input.email);
    assertPasswordPolicy(input.password);
    const role = await this.roles.findSystemRole();
    if (!role)
      throw notFoundError('No existe el rol Administrador: ejecuta primero las migraciones');
    if ((await this.users.countByRole(role.id)) > 0) {
      throw conflictError('Ya existe un administrador; no se creó ningún usuario', 'ADMIN_EXISTS');
    }
    const user = await this.users.create({
      email,
      fullName: input.fullName.trim() || 'Administrador',
      roleId: role.id,
      passwordHash: await this.hasher.hash(input.password),
    });
    this.log.info('user.admin.created', { userId: user.id, email: user.email });
    return user;
  }
}
