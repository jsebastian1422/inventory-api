/* Inventories (sprint 005): inventories, inventory lines and line history, with offline sync columns (ADR-0002) and exact decimals (ADR-0003). */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('inventories', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    establishment_id: {
      type: 'uuid',
      notNull: true,
      references: 'establishments',
      onDelete: 'RESTRICT',
    },
    name: { type: 'varchar(150)', notNull: true },
    start_date: { type: 'date', notNull: true },
    end_date: { type: 'date', notNull: true },
    origin: { type: 'varchar(255)', notNull: true },
    notes: { type: 'varchar(1000)' },
    is_active: { type: 'boolean', notNull: true, default: true },
    version: { type: 'integer', notNull: true, default: 1 },
    change_xid: { type: 'xid8', notNull: true, default: pgm.func('pg_current_xact_id()') },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('inventories', 'inventories_dates_check', {
    check: 'end_date >= start_date',
  });
  pgm.createIndex('inventories', 'establishment_id');
  pgm.sql('CREATE INDEX inventories_change_xid_id_idx ON inventories (change_xid, id)');

  pgm.createTable('inventory_lines', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    inventory_id: {
      type: 'uuid',
      notNull: true,
      references: 'inventories',
      onDelete: 'RESTRICT',
    },
    product_id: {
      type: 'uuid',
      notNull: true,
      references: 'products',
      onDelete: 'RESTRICT',
    },
    barcode: { type: 'varchar(64)', notNull: true },
    expires_on: { type: 'date' },
    quantity_initial: { type: 'numeric(14,3)', notNull: true },
    quantity_alert: { type: 'numeric(14,3)', notNull: true },
    quantity_current: { type: 'numeric(14,3)', notNull: true },
    is_active: { type: 'boolean', notNull: true, default: true },
    version: { type: 'integer', notNull: true, default: 1 },
    change_xid: { type: 'xid8', notNull: true, default: pgm.func('pg_current_xact_id()') },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('inventory_lines', 'inventory_lines_quantity_initial_check', {
    check: 'quantity_initial >= 0',
  });
  pgm.addConstraint('inventory_lines', 'inventory_lines_quantity_alert_check', {
    check: 'quantity_alert >= 0',
  });
  pgm.addConstraint('inventory_lines', 'inventory_lines_quantity_current_check', {
    check: 'quantity_current >= 0',
  });
  pgm.sql(`ALTER TABLE inventory_lines
    ADD CONSTRAINT inventory_lines_inventory_barcode_expires_key
    UNIQUE NULLS NOT DISTINCT (inventory_id, barcode, expires_on)`);
  pgm.createIndex('inventory_lines', 'inventory_id');
  pgm.createIndex('inventory_lines', 'product_id');
  pgm.createIndex('inventory_lines', 'barcode');
  pgm.sql('CREATE INDEX inventory_lines_change_xid_id_idx ON inventory_lines (change_xid, id)');

  pgm.createTable('inventory_line_history', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    line_id: {
      type: 'uuid',
      notNull: true,
      references: 'inventory_lines',
      onDelete: 'RESTRICT',
    },
    reason: { type: 'varchar(32)', notNull: true },
    initial_before: { type: 'numeric(14,3)' },
    initial_after: { type: 'numeric(14,3)', notNull: true },
    current_before: { type: 'numeric(14,3)' },
    current_after: { type: 'numeric(14,3)', notNull: true },
    delta: { type: 'numeric(14,3)' },
    actor_id: { type: 'uuid', notNull: true },
    changed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('inventory_line_history', 'inventory_line_history_reason_check', {
    check: "reason IN ('created', 'initial_adjusted')",
  });
  pgm.createIndex('inventory_line_history', ['line_id', 'changed_at']);
};

exports.down = (pgm) => {
  pgm.dropTable('inventory_line_history');
  pgm.dropTable('inventory_lines');
  pgm.dropTable('inventories');
};
