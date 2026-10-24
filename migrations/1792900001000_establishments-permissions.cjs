/* Seed: establishments permissions, assigned to the system role (Administrador). */
exports.shorthands = undefined;

const PERMISSIONS = [
  ['establishments.read', 'establishments', 'read', 'Ver establecimientos'],
  ['establishments.create', 'establishments', 'create', 'Crear establecimientos'],
  ['establishments.update', 'establishments', 'update', 'Editar establecimientos'],
  [
    'establishments.deactivate',
    'establishments',
    'deactivate',
    'Activar y desactivar establecimientos',
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
     WHERE r.is_system = true AND p.module = 'establishments'`,
  );
};

exports.down = (pgm) => {
  const codes = PERMISSIONS.map(([code]) => `'${code}'`).join(', ');
  pgm.sql(
    `DELETE FROM role_permissions WHERE permission_id IN (SELECT id FROM permissions WHERE code IN (${codes}))`,
  );
  pgm.sql(`DELETE FROM permissions WHERE code IN (${codes})`);
};
