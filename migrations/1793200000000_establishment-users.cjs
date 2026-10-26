/* Establishment users (sprint 006): user <-> establishment assignments with logical removal (ADR-0004). user_id has no FK (ADR-0001: identity tables are read-only for core). */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('establishment_users', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    establishment_id: {
      type: 'uuid',
      notNull: true,
      references: 'establishments',
      onDelete: 'RESTRICT',
    },
    user_id: { type: 'uuid', notNull: true },
    assigned_by: { type: 'uuid', notNull: true },
    assigned_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    removed_by: { type: 'uuid' },
    removed_at: { type: 'timestamptz' },
  });
  pgm.addConstraint('establishment_users', 'establishment_users_removed_check', {
    check:
      '(removed_at IS NULL AND removed_by IS NULL) OR (removed_at IS NOT NULL AND removed_by IS NOT NULL)',
  });
  pgm.sql(
    'CREATE UNIQUE INDEX establishment_users_active_key ON establishment_users (establishment_id, user_id) WHERE removed_at IS NULL',
  );
  pgm.sql(
    'CREATE INDEX establishment_users_user_active_idx ON establishment_users (user_id) WHERE removed_at IS NULL',
  );
};

exports.down = (pgm) => {
  pgm.dropTable('establishment_users');
};
