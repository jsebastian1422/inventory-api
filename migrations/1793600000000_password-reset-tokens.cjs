/* Password reset tokens (sprint 011, ADR-0008): only the SHA-256 hash is stored; one use; short life. Written by identity only. */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('password_reset_tokens', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    token_hash: { type: 'text', notNull: true, unique: true },
    expires_at: { type: 'timestamptz', notNull: true },
    used_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('password_reset_tokens', 'user_id');
};

exports.down = (pgm) => {
  pgm.dropTable('password_reset_tokens');
};
