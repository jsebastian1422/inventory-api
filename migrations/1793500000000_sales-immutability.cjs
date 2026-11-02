/* Sales immutability (sprint 010, ADR-0006): sales and sale_items cannot be updated or deleted. Every UPDATE/DELETE of a row raises SQLSTATE P0V01 and aborts the transaction. No session bypass. Bulk table cleanup is not blocked (test database only). */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createFunction(
    'sales_immutable',
    [],
    { returns: 'trigger', language: 'plpgsql', replace: true },
    `BEGIN
  RAISE EXCEPTION 'Las ventas son inmutables (tabla %, operación %)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'P0V01';
END;`,
  );
  pgm.createTrigger('sales', 'sales_immutable_trg', {
    when: 'BEFORE',
    operation: ['UPDATE', 'DELETE'],
    level: 'ROW',
    function: 'sales_immutable',
  });
  pgm.createTrigger('sale_items', 'sale_items_immutable_trg', {
    when: 'BEFORE',
    operation: ['UPDATE', 'DELETE'],
    level: 'ROW',
    function: 'sales_immutable',
  });
};

exports.down = (pgm) => {
  pgm.dropTrigger('sale_items', 'sale_items_immutable_trg');
  pgm.dropTrigger('sales', 'sales_immutable_trg');
  pgm.dropFunction('sales_immutable', []);
};
