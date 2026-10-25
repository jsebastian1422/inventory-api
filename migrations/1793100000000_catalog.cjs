/* Catalog (sprint 005): categories, products and product price history, with offline sync columns (ADR-0002) and exact decimals (ADR-0003). */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('categories', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    code: { type: 'varchar(30)', notNull: true },
    name: { type: 'varchar(100)', notNull: true },
    description: { type: 'varchar(500)' },
    is_active: { type: 'boolean', notNull: true, default: true },
    version: { type: 'integer', notNull: true, default: 1 },
    change_xid: { type: 'xid8', notNull: true, default: pgm.func('pg_current_xact_id()') },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('categories', 'categories_code_check', { check: "code ~ '^[A-Z0-9-]+$'" });
  pgm.addConstraint('categories', 'categories_code_key', { unique: 'code' });
  pgm.sql('CREATE UNIQUE INDEX categories_name_lower_key ON categories (lower(name))');
  pgm.sql('CREATE INDEX categories_change_xid_id_idx ON categories (change_xid, id)');

  pgm.createTable('products', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    sku: { type: 'varchar(50)', notNull: true },
    name: { type: 'varchar(150)', notNull: true },
    description: { type: 'varchar(1000)' },
    brand: { type: 'varchar(100)' },
    unit: { type: 'varchar(16)', notNull: true },
    category_id: {
      type: 'uuid',
      notNull: true,
      references: 'categories',
      onDelete: 'RESTRICT',
    },
    price: { type: 'numeric(14,2)', notNull: true },
    is_active: { type: 'boolean', notNull: true, default: true },
    version: { type: 'integer', notNull: true, default: 1 },
    change_xid: { type: 'xid8', notNull: true, default: pgm.func('pg_current_xact_id()') },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('products', 'products_unit_check', {
    check: "unit IN ('unit', 'meter', 'kilogram', 'liter', 'box', 'package')",
  });
  pgm.addConstraint('products', 'products_price_check', { check: 'price >= 0' });
  pgm.sql('CREATE UNIQUE INDEX products_sku_lower_key ON products (lower(sku))');
  pgm.createIndex('products', 'category_id');
  pgm.sql('CREATE INDEX products_change_xid_id_idx ON products (change_xid, id)');

  pgm.createTable('product_price_history', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    product_id: {
      type: 'uuid',
      notNull: true,
      references: 'products',
      onDelete: 'RESTRICT',
    },
    old_price: { type: 'numeric(14,2)' },
    new_price: { type: 'numeric(14,2)', notNull: true },
    actor_id: { type: 'uuid', notNull: true },
    changed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('product_price_history', ['product_id', 'changed_at']);
};

exports.down = (pgm) => {
  pgm.dropTable('product_price_history');
  pgm.dropTable('products');
  pgm.dropTable('categories');
};
