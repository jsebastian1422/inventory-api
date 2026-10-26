/* Seed: scope permissions (sprint 006, ADR-0004), assigned to the system role (Administrador). */
exports.shorthands = undefined;

const PERMISSIONS = [
  [
    'establishments.assign',
    'establishments',
    'assign',
    'Asignar y retirar usuarios de locales',
  ],
  ['establishments.all', 'establishments', 'all', 'Acceso a todos los locales'],
  ['stock.search', 'stock', 'search', 'Buscar existencias en sus locales'],
];

exports.up = (pgm) => {
  for (const [code, module, action, description] of PERMISSIONS) {
    pgm.sql(
      `INSERT INTO permissions (code, module, action, description)
       VALUES ('${code}', '${module}', '${action}', '${description}')`,
    );
  }
  const codes = PERMISSIONS.map(([code]) => `'${code}'`).join(', ');
  pgm.sql(
    `INSERT INTO role_permissions (role_id, permission_id)
     SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
     WHERE r.is_system = true AND p.code IN (${codes})`,
  );
};

exports.down = (pgm) => {
  const codes = PERMISSIONS.map(([code]) => `'${code}'`).join(', ');
  pgm.sql(
    `DELETE FROM role_permissions WHERE permission_id IN (SELECT id FROM permissions WHERE code IN (${codes}))`,
  );
  pgm.sql(`DELETE FROM permissions WHERE code IN (${codes})`);
};
