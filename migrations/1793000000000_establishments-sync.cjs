/* Offline sync support for establishments (ADR-0002): per-record version and change feed position. */
exports.shorthands = undefined;

exports.up = (pgm) => {
  // Existing rows get version 1 and the xid8 of this migration's transaction.
  pgm.sql(`ALTER TABLE establishments
    ADD COLUMN version integer NOT NULL DEFAULT 1,
    ADD COLUMN change_xid xid8 NOT NULL DEFAULT pg_current_xact_id()`);
  pgm.sql('CREATE INDEX establishments_change_xid_id_idx ON establishments (change_xid, id)');
};

exports.down = (pgm) => {
  pgm.sql('DROP INDEX establishments_change_xid_id_idx');
  pgm.sql('ALTER TABLE establishments DROP COLUMN change_xid, DROP COLUMN version');
};
