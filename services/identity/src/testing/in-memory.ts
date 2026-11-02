import { randomUUID } from 'node:crypto';
import type {
  AccessReader,
  AccessTokenIssuer,
  AttemptLimiter,
  Mailer,
  PasswordHasher,
  PasswordResetMail,
  PasswordResetTokenRepository,
  PasswordResetTransaction,
  RefreshTokenCodec,
  RefreshTokenRecord,
  RefreshTokenRepository,
} from '../domain/auth/ports.js';
import type { PermissionRepository } from '../domain/permission/permission.js';
import type { Role } from '../domain/role/role.js';
import type { RoleRepository } from '../domain/role/role-repository.js';
import type { AuditLog } from '../domain/shared/audit-log.js';
import { conflictError } from '../domain/shared/errors.js';
import type { User, UserWithPasswordHash } from '../domain/user/user.js';
import type { UserRepository } from '../domain/user/user-repository.js';

/** In-memory fakes of the domain ports, for unit tests of use cases. */
export class FakeLog implements AuditLog {
  events: Array<{ level: string; event: string; data: Record<string, unknown> }> = [];
  info(event: string, data: Record<string, unknown>) {
    this.events.push({ level: 'info', event, data });
  }
  warn(event: string, data: Record<string, unknown>) {
    this.events.push({ level: 'warn', event, data });
  }
}

export class FakeHasher implements PasswordHasher {
  async hash(plain: string) {
    return `hash:${plain}`;
  }
  async verify(hash: string | null, plain: string) {
    return hash !== null && hash === `hash:${plain}`;
  }
}

export class FakeCodec implements RefreshTokenCodec {
  private n = 0;
  generate() {
    const token = `rt-${++this.n}`;
    return { token, hash: this.hash(token) };
  }
  hash(token: string) {
    return `h(${token})`;
  }
}

export class FakeIssuer implements AccessTokenIssuer {
  async issue(userId: string) {
    return { token: `jwt-${userId}`, expiresIn: 900 };
  }
}

export class FakeRoles implements RoleRepository {
  roles = new Map<string, Role>();
  add(partial: Partial<Role> & { name: string }): Role {
    const role: Role = {
      id: randomUUID(),
      description: '',
      isSystem: false,
      permissions: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      ...partial,
    };
    this.roles.set(role.id, role);
    return role;
  }
  async list() {
    return [...this.roles.values()];
  }
  async findById(id: string) {
    return this.roles.get(id) ?? null;
  }
  async findSystemRole() {
    return [...this.roles.values()].find((r) => r.isSystem) ?? null;
  }
  async create(data: { name: string; description: string }) {
    if ([...this.roles.values()].some((r) => r.name.toLowerCase() === data.name.toLowerCase())) {
      throw conflictError('Ya existe un rol con ese nombre', 'ROLE_NAME_TAKEN');
    }
    return this.add(data);
  }
  async update(id: string, changes: { name?: string; description?: string }) {
    const role = { ...this.roles.get(id)!, ...changes };
    this.roles.set(id, role);
    return role;
  }
  async delete(id: string) {
    this.roles.delete(id);
  }
  async setPermissions(id: string, codes: readonly string[]) {
    const role = { ...this.roles.get(id)!, permissions: [...codes] };
    this.roles.set(id, role);
    return role;
  }
}

export class FakePermissions implements PermissionRepository {
  constructor(private readonly codes: string[]) {}
  async listAll() {
    return this.codes.map((code) => ({
      id: code,
      code,
      module: code.split('.')[0]!,
      action: code.split('.')[1]!,
      description: '',
    }));
  }
  async findMissingCodes(codes: readonly string[]) {
    return codes.filter((c) => !this.codes.includes(c));
  }
}

export class FakeUsers implements UserRepository {
  users = new Map<string, UserWithPasswordHash>();
  constructor(private readonly roles: FakeRoles) {}

  add(input: { email: string; password?: string; role: Role; isActive?: boolean }): User {
    const user: User = {
      id: randomUUID(),
      email: input.email,
      fullName: 'Test User',
      role: { id: input.role.id, name: input.role.name, isSystem: input.role.isSystem },
      isActive: input.isActive ?? true,
      lastLoginAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.users.set(user.id, { user, passwordHash: `hash:${input.password ?? 'Secret123'}` });
    return user;
  }
  private patch(id: string, changes: Partial<User>) {
    const entry = this.users.get(id)!;
    this.users.set(id, { ...entry, user: { ...entry.user, ...changes } });
  }
  async list(limit: number, offset: number) {
    const all = [...this.users.values()].map((e) => e.user);
    return { items: all.slice(offset, offset + limit), total: all.length };
  }
  async findById(id: string) {
    return this.users.get(id)?.user ?? null;
  }
  async findWithPasswordHashById(id: string) {
    return this.users.get(id) ?? null;
  }
  async findWithPasswordHashByEmail(email: string) {
    return [...this.users.values()].find((e) => e.user.email === email.toLowerCase()) ?? null;
  }
  async create(data: { email: string; passwordHash: string; fullName: string; roleId: string }) {
    if (await this.findWithPasswordHashByEmail(data.email)) {
      throw conflictError('Ya existe un usuario con ese correo electrónico', 'EMAIL_ALREADY_USED');
    }
    const user = this.add({ email: data.email, role: this.roles.roles.get(data.roleId)! });
    this.users.set(user.id, {
      user: { ...user, fullName: data.fullName },
      passwordHash: data.passwordHash,
    });
    return this.users.get(user.id)!.user;
  }
  async update(id: string, changes: { email?: string; fullName?: string; roleId?: string }) {
    const role = changes.roleId ? this.roles.roles.get(changes.roleId)! : undefined;
    this.patch(id, {
      ...(changes.email ? { email: changes.email } : {}),
      ...(changes.fullName ? { fullName: changes.fullName } : {}),
      ...(role ? { role: { id: role.id, name: role.name, isSystem: role.isSystem } } : {}),
    });
    return this.users.get(id)!.user;
  }
  async setActive(id: string, isActive: boolean) {
    this.patch(id, { isActive });
  }
  async updatePassword(id: string, passwordHash: string) {
    this.users.set(id, { ...this.users.get(id)!, passwordHash });
  }
  async touchLastLogin(id: string, at: Date) {
    this.patch(id, { lastLoginAt: at });
  }
  async countActiveSystemRoleUsers(excludeUserId?: string) {
    return [...this.users.values()].filter(
      (e) => e.user.role.isSystem && e.user.isActive && e.user.id !== excludeUserId,
    ).length;
  }
  async countByRole(roleId: string) {
    return [...this.users.values()].filter((e) => e.user.role.id === roleId).length;
  }
  async runExclusive<T>(work: (users: UserRepository) => Promise<T>): Promise<T> {
    const snapshot = new Map(this.users);
    try {
      return await work(this);
    } catch (error) {
      this.users = snapshot;
      throw error;
    }
  }
}

export class FakeRefreshTokens implements RefreshTokenRepository {
  tokens = new Map<string, RefreshTokenRecord>();
  async create(data: { userId: string; tokenHash: string; expiresAt: Date }) {
    const record: RefreshTokenRecord = { id: randomUUID(), revokedAt: null, ...data };
    this.tokens.set(record.id, record);
    return record;
  }
  async findByHash(hash: string) {
    return [...this.tokens.values()].find((t) => t.tokenHash === hash) ?? null;
  }
  async rotate(oldId: string, data: { userId: string; tokenHash: string; expiresAt: Date }) {
    const old = this.tokens.get(oldId)!;
    if (old.revokedAt) return null;
    this.tokens.set(oldId, { ...old, revokedAt: new Date() });
    return this.create(data);
  }
  async revoke(id: string) {
    const t = this.tokens.get(id);
    if (t && !t.revokedAt) this.tokens.set(id, { ...t, revokedAt: new Date() });
  }
  async revokeAllForUser(userId: string) {
    for (const t of this.tokens.values()) if (t.userId === userId) await this.revoke(t.id);
  }
  activeFor(userId: string) {
    return [...this.tokens.values()].filter((t) => t.userId === userId && !t.revokedAt).length;
  }
}

export class FakeAccess implements AccessReader {
  constructor(
    private readonly users: FakeUsers,
    private readonly roles: FakeRoles,
  ) {}
  async load(userId: string) {
    const user = this.users.users.get(userId)?.user;
    if (!user) return null;
    return {
      userId,
      roleId: user.role.id,
      isActive: user.isActive,
      permissions: this.roles.roles.get(user.role.id)?.permissions ?? [],
    };
  }
}

/** Fake mailer that records messages; set `failWith` to simulate an SMTP outage. */
export class FakeMailer implements Mailer {
  sent: PasswordResetMail[] = [];
  failWith: Error | null = null;
  async sendPasswordReset(mail: PasswordResetMail) {
    if (this.failWith) throw this.failWith;
    this.sent.push(mail);
  }
}

interface FakeResetToken {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  usedAt: Date | null;
}

export class FakePasswordResetTokens implements PasswordResetTokenRepository {
  tokens: FakeResetToken[] = [];
  constructor(
    private readonly users: FakeUsers,
    private readonly refreshTokens: FakeRefreshTokens,
  ) {}
  async replaceForUser(userId: string, data: { tokenHash: string; expiresAt: Date }, now: Date) {
    for (const t of this.tokens) if (t.userId === userId && !t.usedAt) t.usedAt = now;
    this.tokens.push({ id: randomUUID(), userId, usedAt: null, ...data });
  }
  async redeem(
    tokenHash: string,
    now: Date,
    apply: (userId: string, tx: PasswordResetTransaction) => Promise<void>,
  ) {
    const token = this.tokens.find(
      (t) => t.tokenHash === tokenHash && !t.usedAt && t.expiresAt.getTime() > now.getTime(),
    );
    if (!token) return false;
    token.usedAt = now;
    try {
      await apply(token.userId, {
        isUserActive: async (id) => (await this.users.findById(id))?.isActive === true,
        setPassword: (id, hash) => this.users.updatePassword(id, hash),
        revokeAllRefreshTokens: (id) => this.refreshTokens.revokeAllForUser(id),
      });
    } catch (error) {
      token.usedAt = null;
      throw error;
    }
    return true;
  }
  activeFor(userId: string) {
    return this.tokens.filter((t) => t.userId === userId && !t.usedAt).length;
  }
}

/** Fake limiter driven by a manual clock; same sliding-window rules as the real adapter. */
export class FakeAttemptLimiter implements AttemptLimiter {
  private readonly attempts = new Map<string, number[]>();
  constructor(private readonly now: () => number) {}
  retryAfter(key: string, max: number, windowSeconds: number) {
    const live = this.live(key, windowSeconds);
    if (live.length < max) return 0;
    return Math.max(
      1,
      Math.ceil((live[live.length - max]! + windowSeconds * 1000 - this.now()) / 1000),
    );
  }
  record(key: string, windowSeconds: number) {
    this.attempts.set(key, [...this.live(key, windowSeconds), this.now()]);
  }
  reset(key: string) {
    this.attempts.delete(key);
  }
  private live(key: string, windowSeconds: number) {
    const limit = this.now() - windowSeconds * 1000;
    return (this.attempts.get(key) ?? []).filter((at) => at > limit);
  }
}
