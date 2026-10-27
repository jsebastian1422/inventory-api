/* Carts (sprint 007): carts and cart items, with offline sync columns (ADR-0002) and exact decimals (ADR-0003). created_by/cancelled_by have no FK (ADR-0001: identity tables are read-only for core). */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('carts', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    establishment_id: {
      type: 'uuid',
      notNull: true,
      references: 'establishments',
      onDelete: 'RESTRICT',
    },
    created_by: { type: 'uuid', notNull: true },
    status: { type: 'varchar(16)', notNull: true, default: 'open' },
    cancelled_by: { type: 'uuid' },
    cancelled_at: { type: 'timestamptz' },
    version: { type: 'integer', notNull: true, default: 1 },
    change_xid: { type: 'xid8', notNull: true, default: pgm.func('pg_current_xact_id()') },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('carts', 'carts_status_check', {
    check: "status IN ('open', 'cancelled')",
  });
  pgm.addConstraint('carts', 'carts_cancelled_check', {
    check:
      "(status = 'cancelled' AND cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL) OR (status = 'open' AND cancelled_at IS NULL AND cancelled_by IS NULL)",
  });
  pgm.createIndex('carts', ['created_by', 'status']);
  pgm.createIndex('carts', 'establishment_id');
  pgm.sql('CREATE INDEX carts_change_xid_id_idx ON carts (change_xid, id)');

  pgm.createTable('cart_items', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    cart_id: {
      type: 'uuid',
      notNull: true,
      references: 'carts',
      onDelete: 'RESTRICT',
    },
    inventory_line_id: {
      type: 'uuid',
      notNull: true,
      references: 'inventory_lines',
      onDelete: 'RESTRICT',
    },
    quantity: { type: 'numeric(14,3)', notNull: true },
    is_active: { type: 'boolean', notNull: true, default: true },
    version: { type: 'integer', notNull: true, default: 1 },
    change_xid: { type: 'xid8', notNull: true, default: pgm.func('pg_current_xact_id()') },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('cart_items', 'cart_items_quantity_check', {
    check: 'quantity > 0',
  });
  pgm.addConstraint('cart_items', 'cart_items_cart_line_key', {
    unique: ['cart_id', 'inventory_line_id'],
  });
  pgm.createIndex('cart_items', 'cart_id');
  pgm.createIndex('cart_items', 'inventory_line_id');
  pgm.sql('CREATE INDEX cart_items_change_xid_id_idx ON cart_items (change_xid, id)');
};

exports.down = (pgm) => {
  pgm.dropTable('cart_items');
  pgm.dropTable('carts');
};
