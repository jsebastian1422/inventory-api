/* Establishments (sedes) of the business: table, unique name (case-insensitive) and coordinate checks. */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('establishments', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    name: { type: 'varchar(150)', notNull: true },
    address: { type: 'varchar(255)', notNull: true },
    city: { type: 'varchar(100)', notNull: true },
    department: { type: 'varchar(100)', notNull: true },
    phone: { type: 'varchar(30)' },
    latitude: { type: 'numeric(9,6)', notNull: true },
    longitude: { type: 'numeric(9,6)', notNull: true },
    is_active: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('establishments', 'establishments_latitude_check', {
    check: 'latitude BETWEEN -90 AND 90',
  });
  pgm.addConstraint('establishments', 'establishments_longitude_check', {
    check: 'longitude BETWEEN -180 AND 180',
  });
  pgm.sql('CREATE UNIQUE INDEX establishments_name_lower_key ON establishments (lower(name))');
  pgm.createIndex('establishments', 'is_active');
};

exports.down = (pgm) => {
  pgm.dropTable('establishments');
};
