/* Seed: identity permissions and the system role "Administrador" with all of them. */
exports.shorthands = undefined;

const PERMISSIONS = [
  ['users.read', 'users', 'read', 'Ver usuarios'],
  ['users.create', 'users', 'create', 'Crear usuarios'],
  ['users.update', 'users', 'update', 'Editar usuarios y restablecer contraseñas'],
  ['users.deactivate', 'users', 'deactivate', 'Activar y desactivar usuarios'],
  ['roles.read', 'roles', 'read', 'Ver roles y el catálogo de permisos'],
  ['roles.create', 'roles', 'create', 'Crear roles'],
  ['roles.update', 'roles', 'update', 'Editar roles y sus permisos'],
  ['roles.delete', 'roles', 'delete', 'Eliminar roles'],
];

exports.up = (pgm) => {
  for (const [code, module, action, description] of PERMISSIONS) {
    pgm.sql(
      `INSERT INTO permissions (code, module, action, description)
       VALUES ('${code}', '${module}', '${action}', '${description}')`,
    );
  }
  pgm.sql(
    `INSERT INTO roles (name, description, is_system)
     VALUES ('Administrador', 'Rol de sistema con todos los permisos', true)`,
  );
  pgm.sql(
    `INSERT INTO role_permissions (role_id, permission_id)
     SELECT r.id, p.id FROM roles r CROSS JOIN permissions p WHERE r.is_system = true`,
  );
};

exports.down = (pgm) => {
  pgm.sql('DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE is_system)');
  pgm.sql('DELETE FROM roles WHERE is_system = true');
  const codes = PERMISSIONS.map(([code]) => `'${code}'`).join(', ');
  pgm.sql(`DELETE FROM permissions WHERE code IN (${codes})`);
};
