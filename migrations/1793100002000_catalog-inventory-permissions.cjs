/* Seed: categories, products and inventories permissions, assigned to the system role (Administrador). */
exports.shorthands = undefined;

const PERMISSIONS = [
  ['categories.read', 'categories', 'read', 'Ver categorías'],
  ['categories.create', 'categories', 'create', 'Crear categorías'],
  ['categories.update', 'categories', 'update', 'Editar categorías'],
  ['categories.deactivate', 'categories', 'deactivate', 'Activar y desactivar categorías'],
  ['products.read', 'products', 'read', 'Ver productos'],
  ['products.create', 'products', 'create', 'Crear productos'],
  ['products.update', 'products', 'update', 'Editar productos'],
  ['products.deactivate', 'products', 'deactivate', 'Activar y desactivar productos'],
  ['inventories.read', 'inventories', 'read', 'Ver inventarios y sus líneas'],
  ['inventories.create', 'inventories', 'create', 'Crear inventarios'],
  ['inventories.update', 'inventories', 'update', 'Editar inventarios y agregar o editar líneas'],
  [
    'inventories.deactivate',
    'inventories',
    'deactivate',
    'Activar y desactivar inventarios y líneas',
  ],
];

exports.up = (pgm) => {
  for (const [code, module, action, description] of PERMISSIONS) {
    pgm.sql(
      `INSERT INTO permissions (code, module, action, description)
       VALUES ('${code}', '${module}', '${action}', '${description}')`,
    );
  }
  pgm.sql(
    `INSERT INTO role_permissions (role_id, permission_id)
     SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
     WHERE r.is_system = true AND p.module IN ('categories', 'products', 'inventories')`,
  );
};

exports.down = (pgm) => {
  const codes = PERMISSIONS.map(([code]) => `'${code}'`).join(', ');
  pgm.sql(
    `DELETE FROM role_permissions WHERE permission_id IN (SELECT id FROM permissions WHERE code IN (${codes}))`,
  );
  pgm.sql(`DELETE FROM permissions WHERE code IN (${codes})`);
};
