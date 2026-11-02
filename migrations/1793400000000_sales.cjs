/* Sales (sprint 008): invoice header, sold items with frozen data, and the per-establishment counter (ADR-0005). seller_id has no FK (ADR-0001: identity tables are read-only for core). Amounts are exact decimals (ADR-0003). */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('sales', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    cart_id: { type: 'uuid', notNull: true, references: 'carts', onDelete: 'RESTRICT' },
    establishment_id: {
      type: 'uuid',
      notNull: true,
      references: 'establishments',
      onDelete: 'RESTRICT',
    },
    seller_id: { type: 'uuid', notNull: true },
    number: { type: 'integer', notNull: true },
    customer_doc_type: { type: 'varchar(4)' },
    customer_doc_number: { type: 'varchar(20)' },
    customer_name: { type: 'varchar(150)' },
    customer_email: { type: 'varchar(254)' },
    customer_phone: { type: 'varchar(30)' },
    total: { type: 'numeric(18,2)', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    version: { type: 'integer', notNull: true, default: 1 },
    change_xid: { type: 'xid8', notNull: true, default: pgm.func('pg_current_xact_id()') },
  });
  pgm.addConstraint('sales', 'sales_cart_id_key', { unique: ['cart_id'] });
  pgm.addConstraint('sales', 'sales_establishment_number_key', {
    unique: ['establishment_id', 'number'],
  });
  pgm.addConstraint('sales', 'sales_number_check', { check: 'number > 0' });
  pgm.addConstraint('sales', 'sales_total_check', { check: 'total >= 0' });
  pgm.addConstraint('sales', 'sales_customer_doc_type_check', {
    check: "customer_doc_type IN ('CC', 'CE', 'NIT', 'PAS', 'TI')",
  });
  // Buyer: all columns null (Consumidor final) or document type, number and name together.
  pgm.addConstraint('sales', 'sales_customer_check', {
    check:
      '(customer_doc_type IS NULL AND customer_doc_number IS NULL AND customer_name IS NULL AND customer_email IS NULL AND customer_phone IS NULL) OR (customer_doc_type IS NOT NULL AND customer_doc_number IS NOT NULL AND customer_name IS NOT NULL)',
  });
  pgm.createIndex('sales', ['seller_id', 'created_at']);
  pgm.createIndex('sales', ['establishment_id', 'created_at']);
  pgm.sql('CREATE INDEX sales_change_xid_id_idx ON sales (change_xid, id)');

  pgm.createTable('sale_items', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    sale_id: { type: 'uuid', notNull: true, references: 'sales', onDelete: 'RESTRICT' },
    cart_item_id: { type: 'uuid', notNull: true, references: 'cart_items', onDelete: 'RESTRICT' },
    inventory_line_id: {
      type: 'uuid',
      notNull: true,
      references: 'inventory_lines',
      onDelete: 'RESTRICT',
    },
    product_id: { type: 'uuid', notNull: true, references: 'products', onDelete: 'RESTRICT' },
    sku: { type: 'varchar(50)', notNull: true },
    product_name: { type: 'varchar(150)', notNull: true },
    unit: { type: 'varchar(16)', notNull: true },
    barcode: { type: 'varchar(64)', notNull: true },
    expires_on: { type: 'date' },
    unit_price: { type: 'numeric(14,2)', notNull: true },
    quantity: { type: 'numeric(14,3)', notNull: true },
    subtotal: { type: 'numeric(18,2)', notNull: true },
  });
  pgm.addConstraint('sale_items', 'sale_items_quantity_check', { check: 'quantity > 0' });
  pgm.addConstraint('sale_items', 'sale_items_unit_price_check', { check: 'unit_price >= 0' });
  pgm.createIndex('sale_items', 'sale_id');

  pgm.createTable('sale_counters', {
    establishment_id: {
      type: 'uuid',
      primaryKey: true,
      references: 'establishments',
      onDelete: 'RESTRICT',
    },
    last_number: { type: 'integer', notNull: true },
  });
  pgm.addConstraint('sale_counters', 'sale_counters_last_number_check', {
    check: 'last_number > 0',
  });
};

exports.down = (pgm) => {
  pgm.dropTable('sale_counters');
  pgm.dropTable('sale_items');
  pgm.dropTable('sales');
};
