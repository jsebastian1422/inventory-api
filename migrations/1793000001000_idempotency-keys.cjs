/* Idempotency keys of core writes (ADR-0002). actor_id has no FK: identity tables are read-only for core (ADR-0001). */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('idempotency_keys', {
    actor_id: { type: 'uuid', notNull: true },
    key: { type: 'uuid', notNull: true },
    request_hash: { type: 'char(64)', notNull: true },
    state: { type: 'varchar(16)', notNull: true },
    status_code: { type: 'smallint' },
    response: { type: 'jsonb' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    expires_at: { type: 'timestamptz', notNull: true },
  });
  pgm.addConstraint('idempotency_keys', 'idempotency_keys_pkey', {
    primaryKey: ['actor_id', 'key'],
  });
  pgm.addConstraint('idempotency_keys', 'idempotency_keys_state_check', {
    check: "state IN ('in_progress', 'completed')",
  });
  pgm.createIndex('idempotency_keys', 'expires_at');
};

exports.down = (pgm) => {
  pgm.dropTable('idempotency_keys');
};
