export const up = (pgm) => {
  pgm.createTable("platform_roles", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    user_id: { type: "text", notNull: true, references: '"user"', onDelete: "RESTRICT" },
    role: { type: "varchar(32)", notNull: true },
    granted_at: { type: "timestamptz", notNull: true, default: pgm.func("clock_timestamp()") },
    granted_by: { type: "text", references: '"user"', onDelete: "RESTRICT" }
  });
  pgm.addConstraint("platform_roles", "platform_roles_role_allowed", {
    check: "role IN ('super_admin', 'platform_admin')"
  });
  pgm.addConstraint("platform_roles", "platform_roles_bootstrap_grantor", {
    check: "(role = 'super_admin' AND granted_by IS NULL) OR (role = 'platform_admin' AND granted_by IS NOT NULL)"
  });
  pgm.createIndex("platform_roles", "user_id", { unique: true, name: "platform_roles_one_role_per_user" });
  pgm.createIndex("platform_roles", "role", {
    unique: true,
    where: "role = 'super_admin'",
    name: "platform_roles_single_super_admin"
  });
  pgm.createIndex("platform_roles", "role", { name: "platform_roles_role_lookup" });

  pgm.createTable("platform_role_events", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    target_user_id: { type: "text", notNull: true, references: '"user"', onDelete: "RESTRICT" },
    role: { type: "varchar(32)", notNull: true },
    action: { type: "varchar(16)", notNull: true },
    actor_user_id: { type: "text", references: '"user"', onDelete: "RESTRICT" },
    reason: { type: "varchar(500)" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("clock_timestamp()") }
  });
  pgm.addConstraint("platform_role_events", "platform_role_events_action_allowed", {
    check: "(role = 'super_admin' AND action = 'bootstrap' AND actor_user_id IS NULL) OR (role = 'platform_admin' AND action IN ('grant', 'revoke') AND actor_user_id IS NOT NULL)"
  });
  pgm.addConstraint("platform_role_events", "platform_role_events_role_allowed", {
    check: "role IN ('super_admin', 'platform_admin')"
  });
  pgm.addConstraint("platform_role_events", "platform_role_events_reason_length", {
    check: "reason IS NULL OR length(reason) <= 500"
  });
  pgm.createIndex("platform_role_events", ["target_user_id", "created_at"]);
  pgm.createIndex("platform_role_events", "created_at");

  pgm.sql(`
    CREATE FUNCTION breakdish_platform_role_events_append_only() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'Platform role history is append-only.'
        USING ERRCODE = '55000', CONSTRAINT = 'platform_role_events_append_only';
      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER platform_role_events_no_update_or_delete
      BEFORE UPDATE OR DELETE ON platform_role_events
      FOR EACH ROW EXECUTE FUNCTION breakdish_platform_role_events_append_only();
    CREATE TRIGGER platform_role_events_no_truncate
      BEFORE TRUNCATE ON platform_role_events
      FOR EACH STATEMENT EXECUTE FUNCTION breakdish_platform_role_events_append_only();
  `);
};

export const down = (pgm) => pgm.sql(`
  DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM platform_roles) OR EXISTS (SELECT 1 FROM platform_role_events) THEN
      RAISE EXCEPTION 'Cannot roll back migration 010 while platform role assignments or history exist.';
    END IF;
  END;
  $$;
  DROP TRIGGER platform_role_events_no_truncate ON platform_role_events;
  DROP TRIGGER platform_role_events_no_update_or_delete ON platform_role_events;
  DROP FUNCTION breakdish_platform_role_events_append_only();
  DROP TABLE platform_role_events;
  DROP TABLE platform_roles;
`);
