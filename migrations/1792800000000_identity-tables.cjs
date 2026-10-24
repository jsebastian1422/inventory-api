/* Identity tables: roles, permissions, role_permissions, users, refresh_tokens. */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('roles', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    name: { type: 'varchar(100)', notNull: true },
    description: { type: 'varchar(500)', notNull: true, default: '' },
    is_system: { type: 'boolean', notNull: true, default: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.sql('CREATE UNIQUE INDEX roles_name_lower_key ON roles (lower(name))');

  pgm.createTable('permissions', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    code: { type: 'varchar(100)', notNull: true, unique: true },
    module: { type: 'varchar(50)', notNull: true },
    action: { type: 'varchar(50)', notNull: true },
    description: { type: 'varchar(255)', notNull: true, default: '' },
  });

  pgm.createTable('role_permissions', {
    role_id: { type: 'uuid', notNull: true, references: 'roles', onDelete: 'CASCADE' },
    permission_id: { type: 'uuid', notNull: true, references: 'permissions', onDelete: 'CASCADE' },
  });
  pgm.addConstraint('role_permissions', 'role_permissions_pkey', {
    primaryKey: ['role_id', 'permission_id'],
  });
  pgm.createIndex('role_permissions', 'permission_id');

  pgm.createTable('users', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    email: { type: 'varchar(254)', notNull: true },
    password_hash: { type: 'text', notNull: true },
    full_name: { type: 'varchar(150)', notNull: true },
    role_id: { type: 'uuid', notNull: true, references: 'roles', onDelete: 'RESTRICT' },
    is_active: { type: 'boolean', notNull: true, default: true },
    last_login_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.sql('CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email))');
  pgm.createIndex('users', 'role_id');

  pgm.createTable('refresh_tokens', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'RESTRICT' },
    token_hash: { type: 'varchar(128)', notNull: true },
    expires_at: { type: 'timestamptz', notNull: true },
    revoked_at: { type: 'timestamptz' },
    replaced_by: { type: 'uuid' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('refresh_tokens', 'token_hash');
  pgm.createIndex('refresh_tokens', 'user_id');
};

exports.down = (pgm) => {
  pgm.dropTable('refresh_tokens');
  pgm.dropTable('users');
  pgm.dropTable('role_permissions');
  pgm.dropTable('permissions');
  pgm.dropTable('roles');
};
