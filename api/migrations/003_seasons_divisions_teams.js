export const up = (pgm) => {
  pgm.createTable("seasons", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    league_id: {
      type: "uuid", notNull: true, references: '"leagues"', onDelete: "CASCADE"
    },
    name: { type: "varchar(120)", notNull: true },
    status: { type: "varchar(16)", notNull: true, default: "draft" },
    starts_on: { type: "date" },
    ends_on: { type: "date" },
    created_by: { type: "text", notNull: true, references: '"user"', onDelete: "RESTRICT" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") }
  });
  pgm.addConstraint("seasons", "seasons_name_nonempty", { check: "length(trim(name)) > 0" });
  pgm.addConstraint("seasons", "seasons_status_allowed", { check: "status IN ('draft', 'active', 'completed')" });
  pgm.addConstraint("seasons", "seasons_dates_ordered", {
    check: "starts_on IS NULL OR ends_on IS NULL OR starts_on <= ends_on"
  });
  pgm.addConstraint("seasons", "seasons_id_league_unique", { unique: ["id", "league_id"] });
  pgm.sql("CREATE UNIQUE INDEX seasons_league_name_unique ON seasons (league_id, lower(name));");
  pgm.createIndex("seasons", ["league_id", "status"]);

  pgm.createTable("divisions", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    season_id: { type: "uuid", notNull: true, references: '"seasons"', onDelete: "CASCADE" },
    name: { type: "varchar(100)", notNull: true },
    created_by: { type: "text", notNull: true, references: '"user"', onDelete: "RESTRICT" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") }
  });
  pgm.addConstraint("divisions", "divisions_name_nonempty", { check: "length(trim(name)) > 0" });
  pgm.addConstraint("divisions", "divisions_id_season_unique", { unique: ["id", "season_id"] });
  pgm.sql("CREATE UNIQUE INDEX divisions_season_name_unique ON divisions (season_id, lower(name));");

  pgm.createTable("teams", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    league_id: { type: "uuid", notNull: true },
    season_id: { type: "uuid", notNull: true },
    division_id: { type: "uuid" },
    name: { type: "varchar(120)", notNull: true },
    home_venue: { type: "varchar(160)" },
    status: { type: "varchar(16)", notNull: true, default: "active" },
    created_by: { type: "text", notNull: true, references: '"user"', onDelete: "RESTRICT" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") }
  }, {
    constraints: {
      foreignKeys: [
        { columns: ["season_id", "league_id"], references: "seasons(id, league_id)", onDelete: "CASCADE", referencesConstraintName: "teams_season_league_fk" },
        { columns: ["division_id", "season_id"], references: "divisions(id, season_id)", referencesConstraintName: "teams_division_season_fk" }
      ]
    }
  });
  pgm.addConstraint("teams", "teams_name_nonempty", { check: "length(trim(name)) > 0" });
  pgm.addConstraint("teams", "teams_status_allowed", { check: "status IN ('active', 'inactive')" });
  pgm.sql("CREATE UNIQUE INDEX teams_season_name_unique ON teams (season_id, lower(name));");
  pgm.createIndex("teams", ["league_id", "season_id"]);
  pgm.createIndex("teams", ["division_id", "season_id"]);

  pgm.createTable("team_memberships", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    team_id: { type: "uuid", notNull: true, references: '"teams"', onDelete: "CASCADE" },
    user_id: { type: "text", notNull: true, references: '"user"', onDelete: "CASCADE" },
    role: { type: "varchar(16)", notNull: true, default: "player" },
    status: { type: "varchar(16)", notNull: true, default: "active" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") }
  });
  pgm.addConstraint("team_memberships", "team_memberships_team_user_unique", { unique: ["team_id", "user_id"] });
  pgm.addConstraint("team_memberships", "team_memberships_role_allowed", { check: "role IN ('player', 'captain')" });
  pgm.addConstraint("team_memberships", "team_memberships_status_allowed", { check: "status IN ('active', 'left')" });
  pgm.addConstraint("team_memberships", "team_memberships_captain_active", { check: "role <> 'captain' OR status = 'active'" });
  pgm.sql("CREATE UNIQUE INDEX team_memberships_single_active_captain ON team_memberships (team_id) WHERE role = 'captain' AND status = 'active';");
  pgm.createIndex("team_memberships", ["team_id", "status"]);
  pgm.createIndex("team_memberships", "user_id");

  pgm.sql(`
    CREATE FUNCTION enforce_season_status_transition() RETURNS trigger AS $$
    BEGIN
      IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
        (OLD.status = 'draft' AND NEW.status = 'active') OR
        (OLD.status = 'active' AND NEW.status = 'completed')
      ) THEN
        RAISE EXCEPTION 'Season status can only move from draft to active and active to completed.'
          USING ERRCODE = '23514', CONSTRAINT = 'seasons_status_transition_allowed';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER seasons_status_transition_guard
    BEFORE UPDATE OF status ON seasons
    FOR EACH ROW EXECUTE FUNCTION enforce_season_status_transition();

    CREATE FUNCTION enforce_team_membership_eligibility() RETURNS trigger AS $$
    DECLARE
      current_team_status text;
      current_season_status text;
      current_league_id uuid;
      eligible boolean;
    BEGIN
      IF NEW.status <> 'active' THEN
        RETURN NEW;
      END IF;

      SELECT t.status, s.status, t.league_id
      INTO current_team_status, current_season_status, current_league_id
      FROM teams t JOIN seasons s ON s.id = t.season_id
      WHERE t.id = NEW.team_id
      FOR KEY SHARE OF t, s;

      IF current_league_id IS NULL OR current_team_status <> 'active' OR current_season_status = 'completed' THEN
        RAISE EXCEPTION 'Players can only join active teams in draft or active seasons.'
          USING ERRCODE = '23514', CONSTRAINT = 'team_membership_team_available';
      END IF;

      SELECT EXISTS (
        SELECT 1 FROM league_memberships
        WHERE league_id = current_league_id AND user_id = NEW.user_id AND status = 'active'
      ) INTO eligible;

      IF NOT eligible THEN
        RAISE EXCEPTION 'A team member must have an active membership in the team league.'
          USING ERRCODE = '23514', CONSTRAINT = 'team_member_active_league_membership';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER team_memberships_require_eligible_player
    BEFORE INSERT OR UPDATE OF team_id, user_id, role, status ON team_memberships
    FOR EACH ROW EXECUTE FUNCTION enforce_team_membership_eligibility();
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP TRIGGER team_memberships_require_eligible_player ON team_memberships;
    DROP FUNCTION enforce_team_membership_eligibility();
    DROP TRIGGER seasons_status_transition_guard ON seasons;
    DROP FUNCTION enforce_season_status_transition();
  `);
  pgm.dropTable("team_memberships");
  pgm.dropTable("teams");
  pgm.dropTable("divisions");
  pgm.dropTable("seasons");
};
