import type { Actor } from '../domain/shared/privilege-rules.js';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ChangeOwnPasswordUseCase,
  LoginUseCase,
  type LoginThrottle,
  LogoutUseCase,
  RefreshSessionUseCase,
} from './auth/auth.use-cases.js';
import {
  ConfirmPasswordResetUseCase,
  RequestPasswordResetUseCase,
  RESET_MAX_REQUESTS_EMAIL,
  type PasswordResetDeps,
} from './auth/password-reset.use-cases.js';
import {
  DeleteRoleUseCase,
  SetRolePermissionsUseCase,
  UpdateRoleUseCase,
} from './roles/role.use-cases.js';
import {
  CreateUserUseCase,
  ResetUserPasswordUseCase,
  SetUserStatusUseCase,
  UpdateUserUseCase,
} from './users/user.use-cases.js';
import {
  FakeCodec,
  FakeHasher,
  FakeIssuer,
  FakeAttemptLimiter,
  FakeLog,
  FakeMailer,
  FakePasswordResetTokens,
  FakePermissions,
  FakeRefreshTokens,
  FakeRoles,
  FakeUsers,
} from '../testing/in-memory.js';

const ALL = [
  'users.read',
  'users.create',
  'users.update',
  'users.deactivate',
  'roles.read',
  'roles.update',
];
const superActor: Actor = { id: 'super', roleId: 'super-role', permissions: ALL };

let now = new Date('2026-01-01T00:00:00Z');
let roles: FakeRoles;
let users: FakeUsers;
let refresh: FakeRefreshTokens;
let log: FakeLog;
let codec: FakeCodec;
const hasher = new FakeHasher();

let limiter: FakeAttemptLimiter;
let mailer: FakeMailer;
let resetTokens: FakePasswordResetTokens;

function throttle(): LoginThrottle {
  return { limiter, maxPerEmail: 3, maxPerIp: 5, windowSeconds: 900 };
}

function resetDeps(overrides: Partial<PasswordResetDeps> = {}): PasswordResetDeps {
  return {
    users,
    resetTokens,
    refreshTokens: refresh,
    codec,
    hasher,
    mailer,
    limiter,
    log,
    webAppUrl: 'http://localhost:5173',
    ttlSeconds: 1800,
    now: () => now,
    ...overrides,
  };
}

function deps() {
  return {
    issuer: new FakeIssuer(),
    codec,
    refreshTokens: refresh,
    refreshTtlSeconds: 3600,
    now: () => now,
  };
}

beforeEach(() => {
  now = new Date('2026-01-01T00:00:00Z');
  roles = new FakeRoles();
  users = new FakeUsers(roles);
  refresh = new FakeRefreshTokens();
  log = new FakeLog();
  codec = new FakeCodec();
  limiter = new FakeAttemptLimiter(() => now.getTime());
  mailer = new FakeMailer();
  resetTokens = new FakePasswordResetTokens(users, refresh);
});

describe('LoginUseCase', () => {
  it('returns a token pair for valid credentials and logs success', async () => {
    const role = roles.add({ name: 'Administrador', isSystem: true });
    const u = users.add({ email: 'a@b.co', password: 'Secret123', role });
    const pair = await new LoginUseCase(users, hasher, deps(), log, throttle()).execute({
      email: 'A@B.co',
      password: 'Secret123',
    });
    expect(pair.accessToken).toBe(`jwt-${u.id}`);
    expect(pair.refreshToken).toBeTruthy();
    expect(log.events.map((e) => e.event)).toContain('auth.login.success');
  });

  it('gives the same error for unknown email and wrong password, and never logs the password', async () => {
    const role = roles.add({ name: 'R' });
    users.add({ email: 'a@b.co', password: 'Secret123', role });
    const login = new LoginUseCase(users, hasher, deps(), log, throttle());
    const errors = await Promise.all([
      login.execute({ email: 'nobody@b.co', password: 'Secret123' }).catch((e) => e),
      login.execute({ email: 'a@b.co', password: 'WrongPass1' }).catch((e) => e),
    ]);
    expect(errors[0].message).toBe(errors[1].message);
    expect(errors[0].kind).toBe('unauthorized');
    expect(JSON.stringify(log.events)).not.toMatch(/Secret123|WrongPass1/);
  });

  it('rejects inactive users with the generic error', async () => {
    const role = roles.add({ name: 'R' });
    users.add({ email: 'a@b.co', role, isActive: false });
    await expect(
      new LoginUseCase(users, hasher, deps(), log, throttle()).execute({
        email: 'a@b.co',
        password: 'Secret123',
      }),
    ).rejects.toMatchObject({ kind: 'unauthorized', message: 'Credenciales inválidas' });
  });
});

describe('LoginUseCase throttling', () => {
  function setup() {
    const role = roles.add({ name: 'R' });
    users.add({ email: 'a@b.co', password: 'Secret123', role });
    return new LoginUseCase(users, hasher, deps(), log, throttle());
  }
  const bad = { email: 'a@b.co', password: 'Wrong123', ip: '10.0.0.1' };

  it('blocks after the email limit with a Retry-After and logs auth.login.throttled', async () => {
    const login = setup();
    for (let i = 0; i < 3; i++) await login.execute(bad).catch(() => undefined);
    now = new Date(now.getTime() + 60_000);
    await expect(
      login.execute({ email: 'a@b.co', password: 'Secret123', ip: '10.0.0.2' }),
    ).rejects.toMatchObject({
      kind: 'rate_limited',
      code: 'TOO_MANY_ATTEMPTS',
      retryAfterSeconds: 840,
    });
    expect(log.events.map((e) => e.event)).toContain('auth.login.throttled');
    expect(JSON.stringify(log.events)).not.toMatch(/Secret123|Wrong123/);
  });

  it('blocks by IP across different emails and lets the window expire', async () => {
    const login = setup();
    for (let i = 0; i < 5; i++) {
      await login.execute({ ...bad, email: `x${i}@b.co` }).catch(() => undefined);
    }
    await expect(
      login.execute({ email: 'a@b.co', password: 'Secret123', ip: bad.ip }),
    ).rejects.toMatchObject({ kind: 'rate_limited' });
    now = new Date(now.getTime() + 901_000);
    await expect(
      login.execute({ email: 'a@b.co', password: 'Secret123', ip: bad.ip }),
    ).resolves.toBeDefined();
  });

  it('a successful login clears the email counter', async () => {
    const login = setup();
    await login.execute(bad).catch(() => undefined);
    await login.execute(bad).catch(() => undefined);
    await login.execute({ email: 'a@b.co', password: 'Secret123', ip: '10.0.0.9' });
    for (let i = 0; i < 2; i++) await login.execute(bad).catch(() => undefined);
    await expect(
      login.execute({ email: 'a@b.co', password: 'Secret123', ip: '10.0.0.9' }),
    ).resolves.toBeDefined();
  });
});

describe('RefreshSessionUseCase / LogoutUseCase', () => {
  async function loggedIn() {
    const role = roles.add({ name: 'R' });
    const u = users.add({ email: 'a@b.co', role });
    const pair = await new LoginUseCase(users, hasher, deps(), log, throttle()).execute({
      email: 'a@b.co',
      password: 'Secret123',
    });
    return { u, pair };
  }

  it('rotates the token and rejects reuse of the old one, closing all sessions', async () => {
    const { u, pair } = await loggedIn();
    const useCase = new RefreshSessionUseCase(users, deps(), log);
    const next = await useCase.execute(pair.refreshToken);
    expect(next.refreshToken).not.toBe(pair.refreshToken);
    await expect(useCase.execute(pair.refreshToken)).rejects.toMatchObject({
      kind: 'unauthorized',
    });
    expect(refresh.activeFor(u.id)).toBe(0);
    expect(log.events.map((e) => e.event)).toContain('auth.refresh.reuse_detected');
  });

  it('rejects expired refresh tokens', async () => {
    const { pair } = await loggedIn();
    now = new Date('2026-01-01T02:00:00Z');
    await expect(
      new RefreshSessionUseCase(users, deps(), log).execute(pair.refreshToken),
    ).rejects.toMatchObject({
      kind: 'unauthorized',
    });
  });

  it('rejects refresh for deactivated users', async () => {
    const { u, pair } = await loggedIn();
    await users.setActive(u.id, false);
    await expect(
      new RefreshSessionUseCase(users, deps(), log).execute(pair.refreshToken),
    ).rejects.toMatchObject({
      kind: 'unauthorized',
    });
  });

  it('logout revokes the token and is idempotent for unknown tokens', async () => {
    const { pair } = await loggedIn();
    const logout = new LogoutUseCase(refresh, codec, log);
    await logout.execute(pair.refreshToken);
    await expect(logout.execute('unknown')).resolves.toBeUndefined();
    await expect(logout.execute(undefined)).resolves.toBeUndefined();
    await expect(
      new RefreshSessionUseCase(users, deps(), log).execute(pair.refreshToken),
    ).rejects.toBeDefined();
  });
});

describe('ChangeOwnPasswordUseCase', () => {
  it('requires the current password and revokes refresh tokens', async () => {
    const role = roles.add({ name: 'R' });
    const u = users.add({ email: 'a@b.co', password: 'Secret123', role });
    await refresh.create({ userId: u.id, tokenHash: 'x', expiresAt: new Date('2030-01-01') });
    const useCase = new ChangeOwnPasswordUseCase(users, hasher, refresh, log);
    await expect(
      useCase.execute(u.id, { currentPassword: 'bad', newPassword: 'NewPass123' }),
    ).rejects.toMatchObject({ kind: 'validation' });
    await useCase.execute(u.id, { currentPassword: 'Secret123', newPassword: 'NewPass123' });
    expect(refresh.activeFor(u.id)).toBe(0);
    expect((await users.findWithPasswordHashById(u.id))!.passwordHash).toBe('hash:NewPass123');
  });
});

describe('user administration', () => {
  it('refuses to deactivate or change the role of the last active administrator', async () => {
    const admin = roles.add({ name: 'Administrador', isSystem: true });
    const other = roles.add({ name: 'Otro' });
    const u = users.add({ email: 'admin@b.co', role: admin });
    const status = new SetUserStatusUseCase(users, roles, refresh, log);
    await expect(status.execute(superActor, u.id, false)).rejects.toMatchObject({
      kind: 'conflict',
      code: 'LAST_ADMIN',
    });
    await expect(
      new UpdateUserUseCase(users, roles, log).execute(superActor, u.id, { roleId: other.id }),
    ).rejects.toMatchObject({ kind: 'conflict', code: 'LAST_ADMIN' });
  });

  it('deactivates a user and revokes their refresh tokens', async () => {
    const admin = roles.add({ name: 'Administrador', isSystem: true });
    users.add({ email: 'admin@b.co', role: admin });
    const target = users.add({ email: 'x@b.co', role: roles.add({ name: 'R' }) });
    await refresh.create({ userId: target.id, tokenHash: 'x', expiresAt: new Date('2030-01-01') });
    const result = await new SetUserStatusUseCase(users, roles, refresh, log).execute(
      superActor,
      target.id,
      false,
    );
    expect(result.isActive).toBe(false);
    expect(refresh.activeFor(target.id)).toBe(0);
  });

  it('rejects duplicate emails ignoring case and unknown roles', async () => {
    const role = roles.add({ name: 'R' });
    const create = new CreateUserUseCase(users, roles, hasher, log);
    const input = { email: 'Dup@b.co', password: 'Secret123', fullName: 'Dup', roleId: role.id };
    await create.execute(superActor, input);
    await expect(create.execute(superActor, { ...input, email: 'dup@B.co' })).rejects.toMatchObject(
      {
        kind: 'conflict',
      },
    );
    await expect(
      create.execute(superActor, {
        ...input,
        email: 'new@b.co',
        roleId: '00000000-0000-4000-8000-000000000000',
      }),
    ).rejects.toMatchObject({ kind: 'validation' });
    expect(JSON.stringify(log.events)).not.toContain('Secret123');
  });
});

describe('role administration', () => {
  it('rejects unknown permission codes and protects the system role', async () => {
    const catalog = new FakePermissions(['users.read', 'users.create']);
    const role = roles.add({ name: 'R' });
    const admin = roles.add({ name: 'Administrador', isSystem: true });
    const useCase = new SetRolePermissionsUseCase(roles, catalog, log);
    await expect(
      useCase.execute(superActor, role.id, ['users.read', 'nope.x']),
    ).rejects.toMatchObject({
      kind: 'validation',
    });
    await expect(useCase.execute(superActor, admin.id, [])).rejects.toMatchObject({
      kind: 'conflict',
    });
    const updated = await useCase.execute(superActor, role.id, ['users.read', 'users.read']);
    expect(updated.permissions).toEqual(['users.read']);
  });

  it('refuses to delete roles in use or the system role', async () => {
    const admin = roles.add({ name: 'Administrador', isSystem: true });
    const used = roles.add({ name: 'Used' });
    const free = roles.add({ name: 'Free' });
    users.add({ email: 'x@b.co', role: used });
    const del = new DeleteRoleUseCase(roles, users, log);
    await expect(del.execute(superActor, admin.id)).rejects.toMatchObject({ kind: 'conflict' });
    await expect(del.execute(superActor, used.id)).rejects.toMatchObject({
      kind: 'conflict',
      code: 'ROLE_IN_USE',
    });
    await del.execute(superActor, free.id);
    expect(await roles.findById(free.id)).toBeNull();
  });
});

describe('anti-escalation rule (CA-21)', () => {
  const catalog = new FakePermissions(ALL);
  let adminRole: ReturnType<FakeRoles['add']>;
  let manager: Actor;
  let managerRole: ReturnType<FakeRoles['add']>;

  beforeEach(() => {
    adminRole = roles.add({ name: 'Administrador', isSystem: true, permissions: ALL });
    managerRole = roles.add({ name: 'Gestor', permissions: ['users.read', 'users.update'] });
    manager = { id: 'mgr', roleId: managerRole.id, permissions: managerRole.permissions };
  });

  it('denies assigning a role with more permissions, on create and on update, and logs it', async () => {
    const u = users.add({ email: 'x@b.co', role: managerRole });
    await expect(
      new CreateUserUseCase(users, roles, hasher, log).execute(manager, {
        email: 'n@b.co',
        password: 'Secret123',
        fullName: 'N',
        roleId: adminRole.id,
      }),
    ).rejects.toMatchObject({ kind: 'forbidden', code: 'PRIVILEGE_ESCALATION' });
    await expect(
      new UpdateUserUseCase(users, roles, log).execute(manager, u.id, { roleId: adminRole.id }),
    ).rejects.toMatchObject({ kind: 'forbidden', code: 'PRIVILEGE_ESCALATION' });
    expect(log.events.filter((e) => e.event === 'privilege.escalation.denied')).toHaveLength(2);
    expect((await users.findById(u.id))!.role.id).toBe(managerRole.id);
  });

  it('allows assigning a role within the actor permissions', async () => {
    const reader = roles.add({ name: 'Lector', permissions: ['users.read'] });
    const u = users.add({ email: 'x@b.co', role: managerRole });
    const updated = await new UpdateUserUseCase(users, roles, log).execute(manager, u.id, {
      roleId: reader.id,
    });
    expect(updated.role.id).toBe(reader.id);
  });

  it('denies editing, resetting the password or changing the status of an administrator', async () => {
    const admin = users.add({ email: 'a@b.co', role: adminRole });
    users.add({ email: 'a2@b.co', role: adminRole });
    const expected = { kind: 'forbidden', code: 'PRIVILEGE_ESCALATION' };
    await expect(
      new UpdateUserUseCase(users, roles, log).execute(manager, admin.id, { email: 'z@b.co' }),
    ).rejects.toMatchObject(expected);
    await expect(
      new ResetUserPasswordUseCase(users, roles, hasher, refresh, log).execute(
        manager,
        admin.id,
        'Hacked12345',
      ),
    ).rejects.toMatchObject(expected);
    await expect(
      new SetUserStatusUseCase(users, roles, refresh, log).execute(
        { ...manager, permissions: [...manager.permissions, 'users.deactivate'] },
        admin.id,
        false,
      ),
    ).rejects.toMatchObject(expected);
    expect((await users.findWithPasswordHashById(admin.id))!.passwordHash).toBe('hash:Secret123');
  });

  it('allows managing users whose role is within the actor permissions and the administrator does everything', async () => {
    const peer = users.add({ email: 'p@b.co', role: managerRole });
    await new ResetUserPasswordUseCase(users, roles, hasher, refresh, log).execute(
      manager,
      peer.id,
      'NewPass123',
    );
    const admin = users.add({ email: 'a@b.co', role: adminRole });
    const adminActor: Actor = { id: admin.id, roleId: adminRole.id, permissions: ALL };
    const other = users.add({ email: 'a2@b.co', role: adminRole });
    await new ResetUserPasswordUseCase(users, roles, hasher, refresh, log).execute(
      adminActor,
      other.id,
      'NewPass123',
    );
    const updated = await new UpdateUserUseCase(users, roles, log).execute(adminActor, peer.id, {
      roleId: adminRole.id,
    });
    expect(updated.role.id).toBe(adminRole.id);
  });

  it('denies modifying the own role in every way, and permissions the actor lacks', async () => {
    const roleActor: Actor = {
      id: 'ra',
      roleId: managerRole.id,
      permissions: ['roles.read', 'roles.update', 'users.read'],
    };
    roles.roles.set(managerRole.id, {
      ...managerRole,
      permissions: roleActor.permissions as string[],
    });
    const other = roles.add({ name: 'Otro', permissions: ['users.read'] });
    const expected = { kind: 'forbidden', code: 'PRIVILEGE_ESCALATION' };
    await expect(
      new SetRolePermissionsUseCase(roles, catalog, log).execute(roleActor, managerRole.id, ALL),
    ).rejects.toMatchObject(expected);
    await expect(
      new UpdateRoleUseCase(roles, log).execute(roleActor, managerRole.id, { description: 'x' }),
    ).rejects.toMatchObject(expected);
    await expect(
      new DeleteRoleUseCase(roles, users, log).execute(roleActor, managerRole.id),
    ).rejects.toMatchObject(expected);
    // another role: granting a permission the actor does not have is denied, within its own is fine
    await expect(
      new SetRolePermissionsUseCase(roles, catalog, log).execute(roleActor, other.id, [
        'users.read',
        'users.create',
      ]),
    ).rejects.toMatchObject(expected);
    const ok = await new SetRolePermissionsUseCase(roles, catalog, log).execute(
      roleActor,
      other.id,
      ['users.read', 'roles.read'],
    );
    expect(ok.permissions).toEqual(['users.read', 'roles.read']);
  });

  it('denies editing a role that holds permissions the actor lacks', async () => {
    await expect(
      new UpdateRoleUseCase(roles, log).execute(manager, adminRole.id, { description: 'x' }),
    ).rejects.toMatchObject({ kind: 'forbidden', code: 'PRIVILEGE_ESCALATION' });
    await expect(
      new SetRolePermissionsUseCase(roles, catalog, log).execute(manager, adminRole.id, []),
    ).rejects.toMatchObject({ kind: 'forbidden', code: 'PRIVILEGE_ESCALATION' });
  });
});

describe('last administrator (CA-13) with exclusive execution', () => {
  it('rolls back the writes of a failed exclusive block', async () => {
    const admin = roles.add({ name: 'Administrador', isSystem: true });
    const u = users.add({ email: 'a@b.co', role: admin });
    await expect(
      users.runExclusive(async (tx) => {
        await tx.setActive(u.id, false);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect((await users.findById(u.id))!.isActive).toBe(true);
  });
});

describe('self password reset (CA-22)', () => {
  it('rejects resetting the own password and leaves it untouched', async () => {
    const role = roles.add({ name: 'Administrador', isSystem: true, permissions: ALL });
    const me = users.add({ email: 'me@b.co', role });
    const actor: Actor = { id: me.id, roleId: role.id, permissions: ALL };
    await expect(
      new ResetUserPasswordUseCase(users, roles, hasher, refresh, log).execute(
        actor,
        me.id,
        'NewPass123',
      ),
    ).rejects.toMatchObject({
      kind: 'conflict',
      code: 'USE_CHANGE_PASSWORD',
      message: expect.stringContaining('/auth/change-password'),
    });
    expect((await users.findWithPasswordHashById(me.id))!.passwordHash).not.toBe('hash:NewPass123');
  });
});

describe('password reset', () => {
  function active(email = 'a@b.co') {
    const role = roles.add({ name: `R-${email}` });
    return users.add({ email, password: 'Secret123', role });
  }
  const tokenOf = (link: string) => link.split('#token=')[1]!;

  it('mails a fragment link for an active user and stores only the hash', async () => {
    const u = active();
    const request = new RequestPasswordResetUseCase(resetDeps());
    await request.execute({ email: ' A@B.co ', ip: '1.1.1.1' });
    await request.drain();
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.link).toMatch(/^http:\/\/localhost:5173\/restablecer#token=rt-1$/);
    expect(mailer.sent[0]!.to).toBe('a@b.co');
    expect(resetTokens.tokens[0]!.tokenHash).toBe('h(rt-1)');
    expect(JSON.stringify(resetTokens.tokens)).not.toContain('"rt-1"');
    expect(resetTokens.activeFor(u.id)).toBe(1);
    expect(JSON.stringify(log.events)).not.toContain('rt-1');
  });

  it('sends nothing for unknown or inactive accounts', async () => {
    const off = active('off@b.co');
    await users.setActive(off.id, false);
    const request = new RequestPasswordResetUseCase(resetDeps());
    await request.execute({ email: 'nobody@b.co' });
    await request.execute({ email: 'off@b.co' });
    await request.drain();
    expect(mailer.sent).toHaveLength(0);
    expect(resetTokens.tokens).toHaveLength(0);
  });

  it('rejects a malformed e-mail with a validation error', async () => {
    await expect(
      new RequestPasswordResetUseCase(resetDeps()).execute({ email: 'not-an-email' }),
    ).rejects.toMatchObject({ kind: 'validation' });
  });

  it('a new request invalidates the previous token', async () => {
    const u = active();
    const request = new RequestPasswordResetUseCase(resetDeps());
    await request.execute({ email: 'a@b.co' });
    await request.execute({ email: 'a@b.co' });
    await request.drain();
    expect(resetTokens.activeFor(u.id)).toBe(1);
    const confirm = new ConfirmPasswordResetUseCase(resetDeps());
    await expect(
      confirm.execute({ token: tokenOf(mailer.sent[0]!.link), newPassword: 'NewPass123' }),
    ).rejects.toMatchObject({ code: 'INVALID_RESET_TOKEN' });
    await expect(
      confirm.execute({ token: tokenOf(mailer.sent[1]!.link), newPassword: 'NewPass123' }),
    ).resolves.toBeUndefined();
  });

  it('over the limit it stays silent: no token, no mail, a throttled log', async () => {
    active();
    const request = new RequestPasswordResetUseCase(resetDeps());
    for (let i = 0; i < RESET_MAX_REQUESTS_EMAIL + 2; i++) {
      await request.execute({ email: 'a@b.co', ip: '2.2.2.2' });
    }
    await request.drain();
    expect(mailer.sent).toHaveLength(RESET_MAX_REQUESTS_EMAIL);
    expect(log.events.map((e) => e.event)).toContain('auth.password_reset.throttled');
  });

  it('a mail failure is logged as auth.mail.failed without the link and does not throw', async () => {
    active();
    mailer.failWith = new Error('connect ECONNREFUSED smtp.example');
    const request = new RequestPasswordResetUseCase(resetDeps());
    await expect(request.execute({ email: 'a@b.co' })).resolves.toBeUndefined();
    await request.drain();
    expect(log.events.map((e) => e.event)).toContain('auth.mail.failed');
    expect(JSON.stringify(log.events)).not.toMatch(/rt-1|restablecer|ECONNREFUSED/);
  });

  it('confirm changes the password once, consumes the token and revokes sessions', async () => {
    const u = active();
    await refresh.create({ userId: u.id, tokenHash: 'x', expiresAt: new Date('2030-01-01') });
    const request = new RequestPasswordResetUseCase(resetDeps());
    await request.execute({ email: 'a@b.co' });
    await request.drain();
    const token = tokenOf(mailer.sent[0]!.link);
    const confirm = new ConfirmPasswordResetUseCase(resetDeps());
    await confirm.execute({ token, newPassword: 'NewPass123' });
    expect((await users.findWithPasswordHashById(u.id))!.passwordHash).toBe('hash:NewPass123');
    expect(refresh.activeFor(u.id)).toBe(0);
    expect(log.events.map((e) => e.event)).toContain('auth.password_reset.completed');
    await expect(confirm.execute({ token, newPassword: 'Other1234' })).rejects.toMatchObject({
      kind: 'validation',
      code: 'INVALID_RESET_TOKEN',
    });
  });

  it('rejects expired, unknown and inactive-user tokens with the same generic error', async () => {
    const u = active();
    const request = new RequestPasswordResetUseCase(resetDeps());
    await request.execute({ email: 'a@b.co' });
    await request.drain();
    const token = tokenOf(mailer.sent[0]!.link);
    const confirm = new ConfirmPasswordResetUseCase(resetDeps());
    const errors = [];
    errors.push(
      await confirm.execute({ token: 'forged', newPassword: 'NewPass123' }).catch((e) => e),
    );
    await users.setActive(u.id, false);
    errors.push(await confirm.execute({ token, newPassword: 'NewPass123' }).catch((e) => e));
    await users.setActive(u.id, true);
    now = new Date(now.getTime() + 1801_000);
    errors.push(await confirm.execute({ token, newPassword: 'NewPass123' }).catch((e) => e));
    for (const error of errors) expect(error).toMatchObject({ code: 'INVALID_RESET_TOKEN' });
    expect(new Set(errors.map((e) => e.message)).size).toBe(1);
    expect((await users.findWithPasswordHashById(u.id))!.passwordHash).toBe('hash:Secret123');
  });

  it('a policy violation is a 400 with details and does not burn the token', async () => {
    const u = active();
    const request = new RequestPasswordResetUseCase(resetDeps());
    await request.execute({ email: 'a@b.co' });
    await request.drain();
    const token = tokenOf(mailer.sent[0]!.link);
    const confirm = new ConfirmPasswordResetUseCase(resetDeps());
    await expect(confirm.execute({ token, newPassword: 'short' })).rejects.toMatchObject({
      kind: 'validation',
      details: [{ field: 'newPassword' }],
    });
    expect(resetTokens.activeFor(u.id)).toBe(1);
    await expect(confirm.execute({ token, newPassword: 'NewPass123' })).resolves.toBeUndefined();
  });
});
