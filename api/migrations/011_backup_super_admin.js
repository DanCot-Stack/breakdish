export const up = (pgm) => {
  pgm.sql("DROP INDEX platform_roles_single_super_admin");
  pgm.dropConstraint("platform_roles", "platform_roles_bootstrap_grantor");
  pgm.addColumn("platform_roles", {
    assignment_type: { type: "varchar(16)" }
  });
  pgm.sql("UPDATE platform_roles SET assignment_type = 'founder' WHERE role = 'super_admin'");
  pgm.addConstraint("platform_roles", "platform_roles_assignment_type_allowed", {
    check: "(role = 'super_admin' AND assignment_type IS NOT NULL AND assignment_type IN ('founder', 'recovery')) OR (role = 'platform_admin' AND assignment_type IS NULL)"
  });
  pgm.addConstraint("platform_roles", "platform_roles_super_admin_grantor", {
    check: "(role = 'super_admin' AND ((assignment_type = 'founder' AND granted_by IS NULL) OR (assignment_type = 'recovery' AND granted_by IS NOT NULL))) OR (role = 'platform_admin' AND granted_by IS NOT NULL)"
  });
  pgm.createIndex("platform_roles", ["role", "assignment_type"], {
    unique: true,
    where: "role = 'super_admin'",
    name: "platform_roles_super_admin_slot_unique"
  });

  pgm.addColumn("platform_role_events", {
    assignment_type: { type: "varchar(16)" }
  });
  pgm.dropConstraint("platform_role_events", "platform_role_events_action_allowed");
  pgm.addConstraint("platform_role_events", "platform_role_events_action_allowed", {
    check: "(role = 'super_admin' AND ((action = 'bootstrap' AND assignment_type IS NULL AND actor_user_id IS NULL) OR (action = 'recovery_grant' AND assignment_type = 'recovery' AND actor_user_id IS NOT NULL))) OR (role = 'platform_admin' AND assignment_type IS NULL AND action IN ('grant', 'revoke') AND actor_user_id IS NOT NULL)"
  });

  pgm.sql(`
    CREATE FUNCTION breakdish_super_admin_assignment_guard() RETURNS trigger AS $$
    DECLARE
      active_count integer;
      founder_count integer;
      founder_user_id text;
    BEGIN
      IF TG_OP = 'UPDATE' THEN
        IF OLD.role = 'super_admin' OR NEW.role = 'super_admin' THEN
          RAISE EXCEPTION 'Super Admin assignments cannot be edited directly.'
            USING ERRCODE = '55000', CONSTRAINT = 'platform_roles_super_admin_immutable';
        END IF;
        RETURN NEW;
      END IF;

      IF TG_OP = 'DELETE' THEN
        IF OLD.role = 'super_admin' THEN
          RAISE EXCEPTION 'Super Admin removal requires a separately reviewed recovery procedure.'
            USING ERRCODE = '55000', CONSTRAINT = 'platform_roles_super_admin_removal_review';
        END IF;
        RETURN OLD;
      END IF;

      IF NEW.role <> 'super_admin' THEN
        RETURN NEW;
      END IF;

      IF NEW.assignment_type IS NULL OR NEW.assignment_type NOT IN ('founder', 'recovery') THEN
        RAISE EXCEPTION 'A Super Admin assignment must use a valid assignment slot.'
          USING ERRCODE = '23514', CONSTRAINT = 'platform_roles_assignment_type_allowed';
      END IF;

      PERFORM pg_advisory_xact_lock(1363351362, 10);
      SELECT count(*)::integer,
        count(*) FILTER (WHERE assignment_type = 'founder')::integer,
        min(user_id) FILTER (WHERE assignment_type = 'founder')
      INTO active_count, founder_count, founder_user_id
      FROM platform_roles
      WHERE role = 'super_admin';

      IF NEW.assignment_type = 'founder' AND active_count <> 0 THEN
        RAISE EXCEPTION 'The founder Super Admin can only be bootstrapped before any Super Admin exists.'
          USING ERRCODE = '23505', CONSTRAINT = 'platform_roles_super_admin_slot_unique';
      END IF;

      IF NEW.assignment_type = 'recovery' AND
         (active_count <> 1 OR founder_count <> 1 OR NEW.granted_by IS DISTINCT FROM founder_user_id) THEN
        RAISE EXCEPTION 'A recovery Super Admin requires exactly one active founder authoriser.'
          USING ERRCODE = '23514', CONSTRAINT = 'platform_roles_recovery_requires_founder';
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER platform_roles_super_admin_guard
      BEFORE INSERT OR UPDATE OR DELETE ON platform_roles
      FOR EACH ROW EXECUTE FUNCTION breakdish_super_admin_assignment_guard();

    CREATE FUNCTION breakdish_super_admin_event_guard() RETURNS trigger AS $$
    DECLARE
      current_assignment_type text;
      current_grantor text;
    BEGIN
      IF NEW.role <> 'super_admin' THEN
        RETURN NEW;
      END IF;

      SELECT assignment_type, granted_by
      INTO current_assignment_type, current_grantor
      FROM platform_roles
      WHERE user_id = NEW.target_user_id AND role = 'super_admin';

      IF NOT FOUND OR
         (current_assignment_type = 'founder' AND
          (NEW.action <> 'bootstrap' OR NEW.assignment_type IS NOT NULL OR NEW.actor_user_id IS NOT NULL OR current_grantor IS NOT NULL)) OR
         (current_assignment_type = 'recovery' AND
          (NEW.action <> 'recovery_grant' OR NEW.assignment_type <> 'recovery' OR NEW.actor_user_id IS DISTINCT FROM current_grantor)) THEN
        RAISE EXCEPTION 'A Super Admin audit event must match an active assignment.'
          USING ERRCODE = '23514', CONSTRAINT = 'platform_role_events_super_admin_assignment_required';
      END IF;

      IF current_assignment_type IS NULL OR current_assignment_type NOT IN ('founder', 'recovery') THEN
        RAISE EXCEPTION 'A Super Admin assignment must use a valid assignment slot.'
          USING ERRCODE = '23514', CONSTRAINT = 'platform_roles_assignment_type_allowed';
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER platform_role_events_super_admin_guard
      BEFORE INSERT ON platform_role_events
      FOR EACH ROW EXECUTE FUNCTION breakdish_super_admin_event_guard();

    CREATE FUNCTION breakdish_super_admin_audit_required() RETURNS trigger AS $$
    DECLARE
      event_exists boolean;
    BEGIN
      IF NEW.role = 'super_admin' THEN
        IF NEW.assignment_type = 'founder' THEN
          SELECT EXISTS (
            SELECT 1 FROM platform_role_events
            WHERE target_user_id = NEW.user_id AND role = 'super_admin'
              AND action = 'bootstrap' AND actor_user_id IS NULL
          ) INTO event_exists;
        ELSE
          SELECT EXISTS (
            SELECT 1 FROM platform_role_events
            WHERE target_user_id = NEW.user_id AND role = 'super_admin'
              AND action = 'recovery_grant' AND assignment_type = 'recovery'
              AND actor_user_id = NEW.granted_by
          ) INTO event_exists;
        END IF;

        IF NOT event_exists THEN
          RAISE EXCEPTION 'A Super Admin assignment requires its matching audit event.'
            USING ERRCODE = '23514', CONSTRAINT = 'platform_roles_super_admin_audit_required';
        END IF;
      END IF;
      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql;

    CREATE CONSTRAINT TRIGGER platform_roles_super_admin_audit_required
      AFTER INSERT OR UPDATE ON platform_roles
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION breakdish_super_admin_audit_required();
  `);
};

export const down = (pgm) => pgm.sql(`
  DO $$
  BEGIN
    IF EXISTS (
      SELECT 1 FROM platform_roles WHERE role = 'super_admin' AND assignment_type = 'recovery'
    ) OR EXISTS (
      SELECT 1 FROM platform_role_events WHERE role = 'super_admin' AND action = 'recovery_grant'
    ) THEN
      RAISE EXCEPTION 'Cannot roll back migration 011 after a recovery Super Admin assignment has been recorded.';
    END IF;
  END;
  $$;

  DROP TRIGGER platform_roles_super_admin_audit_required ON platform_roles;
  DROP TRIGGER platform_role_events_super_admin_guard ON platform_role_events;
  DROP TRIGGER platform_roles_super_admin_guard ON platform_roles;
  DROP FUNCTION breakdish_super_admin_audit_required();
  DROP FUNCTION breakdish_super_admin_event_guard();
  DROP FUNCTION breakdish_super_admin_assignment_guard();
  ALTER TABLE platform_role_events DROP CONSTRAINT platform_role_events_action_allowed;
  ALTER TABLE platform_roles DROP CONSTRAINT platform_roles_super_admin_grantor;
  ALTER TABLE platform_roles DROP CONSTRAINT platform_roles_assignment_type_allowed;
  DROP INDEX platform_roles_super_admin_slot_unique;
  ALTER TABLE platform_role_events DROP COLUMN assignment_type;
  ALTER TABLE platform_roles DROP COLUMN assignment_type;
  ALTER TABLE platform_roles
    ADD CONSTRAINT platform_roles_bootstrap_grantor
    CHECK ((role = 'super_admin' AND granted_by IS NULL) OR (role = 'platform_admin' AND granted_by IS NOT NULL));
  ALTER TABLE platform_role_events
    ADD CONSTRAINT platform_role_events_action_allowed
    CHECK ((role = 'super_admin' AND action = 'bootstrap' AND actor_user_id IS NULL) OR (role = 'platform_admin' AND action IN ('grant', 'revoke') AND actor_user_id IS NOT NULL));
  CREATE UNIQUE INDEX platform_roles_single_super_admin
    ON platform_roles(role) WHERE role = 'super_admin';
`);
