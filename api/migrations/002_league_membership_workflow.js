export const up = (pgm) => {
  pgm.addColumn("leagues", {
    join_policy: { type: "varchar(16)", notNull: true, default: "approval" }
  });
  pgm.addConstraint("leagues", "leagues_join_policy_allowed", {
    check: "join_policy IN ('open', 'approval')"
  });

  pgm.dropConstraint("league_memberships", "league_memberships_status_allowed");
  pgm.addConstraint("league_memberships", "league_memberships_status_allowed", {
    check: "status IN ('pending', 'active', 'suspended', 'left', 'declined')"
  });

  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM leagues l
        WHERE l.status = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM league_memberships m
            WHERE m.league_id = l.id AND m.role = 'owner' AND m.status = 'active'
          )
      ) THEN
        RAISE EXCEPTION 'Cannot install league owner protection: an active league has no active owner.';
      END IF;
    END;
    $$;

    CREATE FUNCTION protect_active_league_owner() RETURNS trigger AS $$
    DECLARE
      target_league_id uuid;
      league_status text;
      active_owner_count integer;
      removes_active_owner boolean := false;
    BEGIN
      target_league_id := OLD.league_id;
      IF TG_OP = 'DELETE' THEN
        removes_active_owner := OLD.role = 'owner' AND OLD.status = 'active';
      ELSE
        removes_active_owner := OLD.role = 'owner' AND OLD.status = 'active'
          AND (NEW.role IS DISTINCT FROM 'owner' OR NEW.status IS DISTINCT FROM 'active');
      END IF;

      IF NOT removes_active_owner THEN
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END IF;

      SELECT status INTO league_status FROM leagues WHERE id = target_league_id;
      IF league_status IS DISTINCT FROM 'active' THEN
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END IF;

      SELECT count(*) INTO active_owner_count
      FROM league_memberships
      WHERE league_id = target_league_id
        AND role = 'owner'
        AND status = 'active'
        AND id <> OLD.id;

      IF active_owner_count = 0 THEN
        RAISE EXCEPTION 'An active league must retain an active owner.'
          USING ERRCODE = '23514', CONSTRAINT = 'league_active_owner_required';
      END IF;
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER league_memberships_preserve_active_owner
    BEFORE UPDATE OR DELETE ON league_memberships
    FOR EACH ROW EXECUTE FUNCTION protect_active_league_owner();

    CREATE FUNCTION require_active_league_owner() RETURNS trigger AS $$
    BEGIN
      IF NEW.status = 'active' AND OLD.status IS DISTINCT FROM NEW.status
        AND NOT EXISTS (
          SELECT 1 FROM league_memberships m
          WHERE m.league_id = NEW.id AND m.role = 'owner' AND m.status = 'active'
        ) THEN
        RAISE EXCEPTION 'An active league must have an active owner.'
          USING ERRCODE = '23514', CONSTRAINT = 'league_active_owner_required';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER leagues_require_active_owner
    BEFORE UPDATE OF status ON leagues
    FOR EACH ROW EXECUTE FUNCTION require_active_league_owner();
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM league_memberships WHERE status = 'declined') THEN
        RAISE EXCEPTION 'Cannot roll back the league workflow migration while declined memberships exist.';
      END IF;
    END;
    $$;
    DROP TRIGGER leagues_require_active_owner ON leagues;
    DROP FUNCTION require_active_league_owner();
    DROP TRIGGER league_memberships_preserve_active_owner ON league_memberships;
    DROP FUNCTION protect_active_league_owner();
  `);
  pgm.dropConstraint("league_memberships", "league_memberships_status_allowed");
  pgm.addConstraint("league_memberships", "league_memberships_status_allowed", {
    check: "status IN ('pending', 'active', 'suspended', 'left')"
  });
  pgm.dropConstraint("leagues", "leagues_join_policy_allowed");
  pgm.dropColumn("leagues", "join_policy");
};
