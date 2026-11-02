/* Sales (sprint 008): carts gain the `sold` state (sold_at/sold_by) and inventory_line_history gains the `sale` reason with its sale_id. The CHECKs are replaced (drop + add). down() fails if sold carts or `sale` history rows exist: reverse it only on data without sales. */
exports.shorthands = undefined;

/* The name `carts_cancelled_check` is kept; its definition now covers the three states. */
const SOLD_CHECK =
  "(status = 'open' AND cancelled_at IS NULL AND cancelled_by IS NULL AND sold_at IS NULL AND sold_by IS NULL) OR (status = 'cancelled' AND cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL AND sold_at IS NULL AND sold_by IS NULL) OR (status = 'sold' AND sold_at IS NOT NULL AND sold_by IS NOT NULL AND cancelled_at IS NULL AND cancelled_by IS NULL)";
const OLD_CANCELLED_CHECK =
  "(status = 'cancelled' AND cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL) OR (status = 'open' AND cancelled_at IS NULL AND cancelled_by IS NULL)";

exports.up = (pgm) => {
  pgm.addColumns('carts', {
    sold_at: { type: 'timestamptz' },
    sold_by: { type: 'uuid' },
  });
  pgm.dropConstraint('carts', 'carts_status_check');
  pgm.addConstraint('carts', 'carts_status_check', {
    check: "status IN ('open', 'cancelled', 'sold')",
  });
  pgm.dropConstraint('carts', 'carts_cancelled_check');
  pgm.addConstraint('carts', 'carts_cancelled_check', { check: SOLD_CHECK });

  pgm.addColumns('inventory_line_history', {
    sale_id: { type: 'uuid', references: 'sales', onDelete: 'RESTRICT' },
  });
  pgm.dropConstraint('inventory_line_history', 'inventory_line_history_reason_check');
  pgm.addConstraint('inventory_line_history', 'inventory_line_history_reason_check', {
    check: "reason IN ('created', 'initial_adjusted', 'sale')",
  });
  pgm.addConstraint('inventory_line_history', 'inventory_line_history_sale_check', {
    check: "(reason = 'sale') = (sale_id IS NOT NULL)",
  });
  pgm.createIndex('inventory_line_history', 'sale_id');
};

exports.down = (pgm) => {
  pgm.dropConstraint('inventory_line_history', 'inventory_line_history_sale_check');
  pgm.dropConstraint('inventory_line_history', 'inventory_line_history_reason_check');
  pgm.addConstraint('inventory_line_history', 'inventory_line_history_reason_check', {
    check: "reason IN ('created', 'initial_adjusted')",
  });
  pgm.dropIndex('inventory_line_history', 'sale_id');
  pgm.dropColumns('inventory_line_history', ['sale_id']);

  pgm.dropConstraint('carts', 'carts_cancelled_check');
  pgm.addConstraint('carts', 'carts_cancelled_check', { check: OLD_CANCELLED_CHECK });
  pgm.dropConstraint('carts', 'carts_status_check');
  pgm.addConstraint('carts', 'carts_status_check', { check: "status IN ('open', 'cancelled')" });
  pgm.dropColumns('carts', ['sold_at', 'sold_by']);
};
