import type { Pool } from 'pg';
import { CheckHealthUseCase } from '../../application/health/check-health.use-case.js';
import {
  AuthorizeRequestUseCase,
  ChangeOwnPasswordUseCase,
  GetCurrentUserUseCase,
  LoginUseCase,
  LogoutUseCase,
  RefreshSessionUseCase,
} from '../../application/auth/auth.use-cases.js';
import {
  CreateRoleUseCase,
  DeleteRoleUseCase,
  GetRoleUseCase,
  ListPermissionsUseCase,
  ListRolesUseCase,
  SetRolePermissionsUseCase,
  UpdateRoleUseCase,
} from '../../application/roles/role.use-cases.js';
import {
  CreateUserUseCase,
  GetUserUseCase,
  ListUsersUseCase,
  ResetUserPasswordUseCase,
  SetUserStatusUseCase,
  UpdateUserUseCase,
} from '../../application/users/user.use-cases.js';
import type { AuditLog } from '../../domain/shared/audit-log.js';
import type { IdentityConfig } from '../config/config.js';
import { PostgresAccessReader } from '../database/postgres-access-reader.js';
import { PostgresHealthCheck } from '../database/postgres-health-check.js';
import { PostgresPermissionRepository } from '../database/postgres-permission-repository.js';
import { PostgresRefreshTokenRepository } from '../database/postgres-refresh-token-repository.js';
import { PostgresRoleRepository } from '../database/postgres-role-repository.js';
import { PostgresUserRepository } from '../database/postgres-user-repository.js';
import { Argon2PasswordHasher } from '../security/argon2-password-hasher.js';
import { JwtAccessTokenIssuer } from '../security/jwt-access-token-issuer.js';
import { RandomRefreshTokenCodec } from '../security/random-refresh-token-codec.js';

export function createRepositories(pool: Pool) {
  return {
    users: new PostgresUserRepository(pool),
    roles: new PostgresRoleRepository(pool),
    permissions: new PostgresPermissionRepository(pool),
    refreshTokens: new PostgresRefreshTokenRepository(pool),
    access: new PostgresAccessReader(pool),
  };
}

/** Composition root: wires ports to adapters and builds every use case once. */
export function createUseCases(config: IdentityConfig, pool: Pool, log: AuditLog) {
  const repos = createRepositories(pool);
  const hasher = new Argon2PasswordHasher();
  const tokens = {
    issuer: new JwtAccessTokenIssuer(config.privateKeyPem, config.accessTokenTtlSeconds),
    codec: new RandomRefreshTokenCodec(),
    refreshTokens: repos.refreshTokens,
    refreshTtlSeconds: config.refreshTokenTtlSeconds,
    now: () => new Date(),
  };
  return {
    health: new CheckHealthUseCase(new PostgresHealthCheck(pool)),
    login: new LoginUseCase(repos.users, hasher, tokens, log),
    refresh: new RefreshSessionUseCase(repos.users, tokens, log),
    logout: new LogoutUseCase(repos.refreshTokens, tokens.codec, log),
    me: new GetCurrentUserUseCase(repos.users, repos.access),
    changePassword: new ChangeOwnPasswordUseCase(repos.users, hasher, repos.refreshTokens, log),
    authorize: new AuthorizeRequestUseCase(repos.access),
    listUsers: new ListUsersUseCase(repos.users),
    getUser: new GetUserUseCase(repos.users),
    createUser: new CreateUserUseCase(repos.users, repos.roles, hasher, log),
    updateUser: new UpdateUserUseCase(repos.users, repos.roles, log),
    setUserStatus: new SetUserStatusUseCase(repos.users, repos.roles, repos.refreshTokens, log),
    resetPassword: new ResetUserPasswordUseCase(
      repos.users,
      repos.roles,
      hasher,
      repos.refreshTokens,
      log,
    ),
    listRoles: new ListRolesUseCase(repos.roles),
    getRole: new GetRoleUseCase(repos.roles),
    createRole: new CreateRoleUseCase(repos.roles, log),
    updateRole: new UpdateRoleUseCase(repos.roles, log),
    setRolePermissions: new SetRolePermissionsUseCase(repos.roles, repos.permissions, log),
    deleteRole: new DeleteRoleUseCase(repos.roles, repos.users, log),
    listPermissions: new ListPermissionsUseCase(repos.permissions),
  };
}

export type UseCases = ReturnType<typeof createUseCases>;
