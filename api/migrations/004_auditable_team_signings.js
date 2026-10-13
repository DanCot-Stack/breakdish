export const up = (pgm) => {
  pgm.addConstraint("teams", "teams_id_league_season_unique", { unique: ["id", "league_id", "season_id"] });
  pgm.addColumn("seasons", {
    status_changed_by: { type: "text", references: '"user"', onDelete: "RESTRICT" }
  });

  pgm.createTable("team_registrations", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    league_id: { type: "uuid", notNull: true },
    season_id: { type: "uuid", notNull: true },
    team_id: { type: "uuid", notNull: true },
    user_id: { type: "text", notNull: true, references: '"user"', onDelete: "RESTRICT" },
    started_at: { type: "timestamptz", notNull: true, default: pgm.func("clock_timestamp()") },
    ended_at: { type: "timestamptz" },
    signing_type: { type: "varchar(24)", notNull: true },
    authorized_by: { type: "text", references: '"user"', onDelete: "RESTRICT" },
    reason: { type: "varchar(500)" },
    end_event_type: { type: "varchar(24)" },
    ended_by: { type: "text", references: '"user"', onDelete: "RESTRICT" },
    end_reason: { type: "varchar(500)" },
    legacy_import: { type: "boolean", notNull: true, default: false }
  }, {
    constraints: {
      foreignKeys: [
        { columns: ["team_id", "league_id", "season_id"], references: "teams(id, league_id, season_id)", onDelete: "RESTRICT", referencesConstraintName: "team_registrations_team_scope_fk" }
      ]
    }
  });
  pgm.addConstraint("team_registrations", "team_registrations_dates_ordered", { check: "ended_at IS NULL OR ended_at >= started_at" });
  pgm.addConstraint("team_registrations", "team_registrations_signing_type_allowed", {
    check: "signing_type IN ('preseason', 'new_signing', 'return_signing', 'transfer')"
  });
  pgm.addConstraint("team_registrations", "team_registrations_end_type_allowed", {
    check: "end_event_type IS NULL OR end_event_type IN ('transferred_out', 'removed', 'season_closed', 'legacy_closure')"
  });
  pgm.addConstraint("team_registrations", "team_registrations_end_fields_consistent", {
    check: "(ended_at IS NULL AND end_event_type IS NULL AND ended_by IS NULL) OR (ended_at IS NOT NULL AND end_event_type IS NOT NULL)"
  });
  pgm.sql("CREATE UNIQUE INDEX team_registrations_one_active_per_competition ON team_registrations (league_id, season_id, user_id) WHERE ended_at IS NULL;");
  pgm.createIndex("team_registrations", ["team_id", "started_at"]);
  pgm.createIndex("team_registrations", ["league_id", "season_id", "user_id"]);

  pgm.createTable("team_registration_events", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    registration_id: { type: "uuid", notNull: true, references: '"team_registrations"', onDelete: "RESTRICT" },
    event_type: { type: "varchar(24)", notNull: true },
    occurred_at: { type: "timestamptz", notNull: true, default: pgm.func("clock_timestamp()") },
    authorized_by: { type: "text", references: '"user"', onDelete: "RESTRICT" },
    reason: { type: "varchar(500)" },
    signing_type: { type: "varchar(24)" },
    legacy_import: { type: "boolean", notNull: true, default: false }
  });
  pgm.addConstraint("team_registration_events", "team_registration_events_type_allowed", {
    check: "event_type IN ('signed', 'transferred_out', 'removed', 'season_closed', 'legacy_closure')"
  });
  pgm.createIndex("team_registration_events", ["registration_id", "occurred_at"]);

  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM team_memberships tm JOIN teams t ON t.id = tm.team_id
        WHERE tm.status = 'active'
        GROUP BY tm.user_id, t.league_id, t.season_id HAVING count(*) > 1
      ) THEN
        RAISE EXCEPTION 'Migration 004 stopped: a player has active registrations on multiple teams in one league season.';
      END IF;
      IF EXISTS (
        SELECT 1 FROM team_memberships tm JOIN teams t ON t.id = tm.team_id
        JOIN seasons s ON s.id = t.season_id
        WHERE tm.status = 'active' AND NOT EXISTS (
          SELECT 1 FROM league_memberships lm WHERE lm.league_id=t.league_id AND lm.user_id=tm.user_id AND lm.status='active'
        )
      ) THEN
        RAISE EXCEPTION 'Migration 004 stopped: an active team member lacks active membership in its league.';
      END IF;
      IF EXISTS (
        SELECT 1 FROM team_memberships tm JOIN teams t ON t.id=tm.team_id JOIN seasons s ON s.id=t.season_id
        WHERE s.status <> 'completed' AND s.starts_on IS NOT NULL
        GROUP BY tm.team_id, s.starts_on
        HAVING count(*) FILTER (WHERE tm.created_at >= (s.starts_on::timestamp AT TIME ZONE 'UTC')) > 3
      ) THEN
        RAISE EXCEPTION 'Migration 004 stopped: an existing active team already exceeds the post-start signing limit.';
      END IF;
    END;
    $$;

    INSERT INTO team_registrations (
      league_id, season_id, team_id, user_id, started_at, ended_at, signing_type,
      end_event_type, legacy_import
    )
    SELECT t.league_id, t.season_id, tm.team_id, tm.user_id, tm.created_at,
      CASE WHEN tm.status='active' AND s.status <> 'completed' THEN NULL
           WHEN tm.status='active' THEN greatest(tm.created_at, s.updated_at)
           ELSE greatest(tm.created_at, tm.updated_at) END,
      CASE WHEN s.starts_on IS NULL OR tm.created_at < (s.starts_on::timestamp AT TIME ZONE 'UTC') THEN 'preseason'
           WHEN EXISTS (SELECT 1 FROM team_memberships prior WHERE prior.team_id=tm.team_id AND prior.user_id=tm.user_id AND prior.created_at < tm.created_at) THEN 'return_signing'
           ELSE 'new_signing' END,
      CASE WHEN tm.status='active' AND s.status='completed' THEN 'legacy_closure'
           WHEN tm.status='left' THEN 'legacy_closure' ELSE NULL END,
      true
    FROM team_memberships tm JOIN teams t ON t.id=tm.team_id JOIN seasons s ON s.id=t.season_id;

    INSERT INTO team_registration_events (registration_id, event_type, occurred_at, reason, signing_type, legacy_import)
    SELECT id, 'signed', started_at, 'Imported from the previous team roster. Original author and reason were not recorded.', signing_type, true
    FROM team_registrations;
    INSERT INTO team_registration_events (registration_id, event_type, occurred_at, reason, legacy_import)
    SELECT id, end_event_type, ended_at,
      'Imported from the previous team roster. Original author and reason were not recorded.', true
    FROM team_registrations WHERE ended_at IS NOT NULL;

    CREATE FUNCTION reject_team_registration_history_mutation() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'Team registration event history is append-only.' USING ERRCODE='55000';
    END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER team_registration_events_append_only
      BEFORE UPDATE OR DELETE ON team_registration_events
      FOR EACH ROW EXECUTE FUNCTION reject_team_registration_history_mutation();

    CREATE FUNCTION enforce_team_registration() RETURNS trigger AS $$
    DECLARE
      season_row seasons%ROWTYPE;
      team_row teams%ROWTYPE;
      active_league_member boolean;
      prior_team_registration boolean;
      prior_competition_registration boolean;
      poststart_count integer;
    BEGIN
      IF TG_OP = 'UPDATE' THEN
        IF NEW.id IS DISTINCT FROM OLD.id OR NEW.league_id IS DISTINCT FROM OLD.league_id OR
          NEW.season_id IS DISTINCT FROM OLD.season_id OR NEW.team_id IS DISTINCT FROM OLD.team_id OR
          NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.started_at IS DISTINCT FROM OLD.started_at OR
          NEW.signing_type IS DISTINCT FROM OLD.signing_type OR NEW.authorized_by IS DISTINCT FROM OLD.authorized_by OR
          NEW.reason IS DISTINCT FROM OLD.reason OR NEW.legacy_import IS DISTINCT FROM OLD.legacy_import OR
          OLD.ended_at IS NOT NULL OR NEW.ended_at IS NULL THEN
          RAISE EXCEPTION 'A registration may only be ended once; its signed history cannot be rewritten.'
            USING ERRCODE='23514', CONSTRAINT='team_registration_history_immutable';
        END IF;
        IF NEW.end_event_type NOT IN ('transferred_out','removed','season_closed') OR NEW.ended_by IS NULL THEN
          RAISE EXCEPTION 'A registration end requires an allowed event and authorising user.'
            USING ERRCODE='23514', CONSTRAINT='team_registration_end_authorized';
        END IF;
        RETURN NEW;
      END IF;

      SELECT * INTO season_row FROM seasons WHERE id=NEW.season_id FOR UPDATE;
      SELECT * INTO team_row FROM teams WHERE id=NEW.team_id FOR UPDATE;
      IF NOT FOUND OR team_row.league_id IS DISTINCT FROM NEW.league_id OR team_row.season_id IS DISTINCT FROM NEW.season_id THEN
        RAISE EXCEPTION 'Registration must target a team in the same league and season.' USING ERRCODE='23514', CONSTRAINT='team_registration_team_scope';
      END IF;
      IF team_row.status <> 'active' OR season_row.status='completed' THEN
        RAISE EXCEPTION 'Players may only register to active teams in draft or active seasons.' USING ERRCODE='23514', CONSTRAINT='team_membership_team_available';
      END IF;
      IF NEW.authorized_by IS NULL OR NEW.legacy_import THEN
        IF NOT NEW.legacy_import THEN
          RAISE EXCEPTION 'New registrations require an authorising user.' USING ERRCODE='23514', CONSTRAINT='team_registration_authorized';
        END IF;
      END IF;
      SELECT EXISTS (SELECT 1 FROM league_memberships WHERE league_id=NEW.league_id AND user_id=NEW.user_id AND status='active') INTO active_league_member;
      IF NOT active_league_member THEN
        RAISE EXCEPTION 'A player must be active in the league before joining a team.' USING ERRCODE='23514', CONSTRAINT='team_member_active_league_membership';
      END IF;
      NEW.started_at := clock_timestamp();
      IF season_row.starts_on IS NULL OR NEW.started_at < (season_row.starts_on::timestamp AT TIME ZONE 'UTC') THEN
        NEW.signing_type := 'preseason';
      ELSE
        SELECT EXISTS (SELECT 1 FROM team_registrations WHERE team_id=NEW.team_id AND user_id=NEW.user_id) INTO prior_team_registration;
        SELECT EXISTS (SELECT 1 FROM team_registrations WHERE league_id=NEW.league_id AND season_id=NEW.season_id AND user_id=NEW.user_id) INTO prior_competition_registration;
        NEW.signing_type := CASE WHEN prior_team_registration THEN 'return_signing'
          WHEN prior_competition_registration THEN 'transfer' ELSE 'new_signing' END;
        SELECT count(*) INTO poststart_count FROM team_registrations
          WHERE team_id=NEW.team_id AND started_at >= (season_row.starts_on::timestamp AT TIME ZONE 'UTC');
        IF poststart_count >= 3 THEN
          RAISE EXCEPTION 'This team has used all three post-start signing events for this season.'
            USING ERRCODE='23514', CONSTRAINT='team_poststart_signing_limit';
        END IF;
      END IF;
      IF NEW.reason IS NOT NULL THEN NEW.reason := left(trim(NEW.reason), 500); END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER team_registrations_validate
      BEFORE INSERT OR UPDATE ON team_registrations
      FOR EACH ROW EXECUTE FUNCTION enforce_team_registration();

    CREATE FUNCTION record_team_registration_event() RETURNS trigger AS $$
    BEGIN
      IF TG_OP='INSERT' THEN
        INSERT INTO team_registration_events(registration_id,event_type,authorized_by,reason,signing_type,legacy_import)
          VALUES(NEW.id,'signed',NEW.authorized_by,NEW.reason,NEW.signing_type,NEW.legacy_import);
        INSERT INTO team_memberships(team_id,user_id,role,status)
          VALUES(NEW.team_id,NEW.user_id,'player','active')
          ON CONFLICT(team_id,user_id) DO UPDATE SET role='player',status='active',updated_at=now()
          WHERE team_memberships.status='left';
        RETURN NEW;
      END IF;
      INSERT INTO team_registration_events(registration_id,event_type,authorized_by,reason,legacy_import)
        VALUES(NEW.id,NEW.end_event_type,NEW.ended_by,NEW.end_reason,NEW.legacy_import);
      UPDATE team_memberships SET role='player',status='left',updated_at=now()
        WHERE team_id=NEW.team_id AND user_id=NEW.user_id AND status='active';
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER team_registrations_record_events
      AFTER INSERT OR UPDATE OF ended_at ON team_registrations
      FOR EACH ROW EXECUTE FUNCTION record_team_registration_event();

    CREATE OR REPLACE FUNCTION enforce_team_membership_eligibility() RETURNS trigger AS $$
    DECLARE current_team_status text; current_season_status text; current_league_id uuid; eligible boolean;
    BEGIN
      IF TG_OP='DELETE' THEN
        IF OLD.status='active' AND EXISTS(SELECT 1 FROM team_registrations WHERE team_id=OLD.team_id AND user_id=OLD.user_id AND ended_at IS NULL) THEN
          RAISE EXCEPTION 'End the team registration before deleting its roster mirror.' USING ERRCODE='23514', CONSTRAINT='team_membership_registration_required';
        END IF;
        RETURN OLD;
      END IF;
      IF NEW.status <> 'active' THEN
        IF TG_OP='UPDATE' AND OLD.status='active' AND EXISTS(SELECT 1 FROM team_registrations WHERE team_id=OLD.team_id AND user_id=OLD.user_id AND ended_at IS NULL) THEN
          RAISE EXCEPTION 'End the team registration through the registration workflow.' USING ERRCODE='23514', CONSTRAINT='team_membership_registration_required';
        END IF;
        RETURN NEW;
      END IF;
      SELECT t.status,s.status,t.league_id INTO current_team_status,current_season_status,current_league_id
        FROM teams t JOIN seasons s ON s.id=t.season_id WHERE t.id=NEW.team_id FOR KEY SHARE OF t,s;
      IF current_league_id IS NULL OR current_team_status<>'active' OR current_season_status='completed' THEN
        RAISE EXCEPTION 'Players can only join active teams in draft or active seasons.' USING ERRCODE='23514', CONSTRAINT='team_membership_team_available';
      END IF;
      SELECT EXISTS(SELECT 1 FROM league_memberships WHERE league_id=current_league_id AND user_id=NEW.user_id AND status='active') INTO eligible;
      IF NOT eligible THEN
        RAISE EXCEPTION 'A team member must have an active membership in the team league.' USING ERRCODE='23514', CONSTRAINT='team_member_active_league_membership';
      END IF;
      IF NOT EXISTS(SELECT 1 FROM team_registrations WHERE team_id=NEW.team_id AND user_id=NEW.user_id AND ended_at IS NULL) THEN
        RAISE EXCEPTION 'Active roster rows require an active team registration.' USING ERRCODE='23514', CONSTRAINT='team_membership_registration_required';
      END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
    DROP TRIGGER team_memberships_require_eligible_player ON team_memberships;
    CREATE TRIGGER team_memberships_require_eligible_player BEFORE INSERT OR UPDATE OR DELETE ON team_memberships
      FOR EACH ROW EXECUTE FUNCTION enforce_team_membership_eligibility();

    CREATE FUNCTION protect_season_signing_rules() RETURNS trigger AS $$
    BEGIN
      IF OLD.status='draft' AND NEW.status='active' AND NEW.starts_on IS NULL THEN
        RAISE EXCEPTION 'Set an official season start date before activating the season.' USING ERRCODE='23514', CONSTRAINT='season_start_required_for_activation';
      END IF;
      IF NEW.status IS DISTINCT FROM OLD.status THEN NEW.status_changed_by := coalesce(NEW.status_changed_by, current_setting('breakdish.actor_id',true)); END IF;
      IF NEW.starts_on IS DISTINCT FROM OLD.starts_on AND EXISTS(SELECT 1 FROM team_registrations WHERE season_id=OLD.id) THEN
        RAISE EXCEPTION 'The official start date cannot change after team registrations begin.' USING ERRCODE='23514', CONSTRAINT='season_start_date_frozen';
      END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER seasons_signing_rules BEFORE UPDATE OF status,starts_on ON seasons
      FOR EACH ROW EXECUTE FUNCTION protect_season_signing_rules();

    CREATE FUNCTION close_season_team_registrations() RETURNS trigger AS $$
    BEGIN
      IF OLD.status IS DISTINCT FROM NEW.status AND NEW.status='completed' THEN
        UPDATE team_registrations SET ended_at=clock_timestamp(),end_event_type='season_closed',ended_by=NEW.status_changed_by,
          end_reason='Season completed.'
          WHERE season_id=NEW.id AND ended_at IS NULL;
      END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER seasons_close_team_registrations AFTER UPDATE OF status ON seasons
      FOR EACH ROW EXECUTE FUNCTION close_season_team_registrations();
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM team_registrations) THEN
        RAISE EXCEPTION 'Cannot roll back migration 004 while team registration history exists.';
      END IF;
    END; $$;
    DROP TRIGGER seasons_close_team_registrations ON seasons;
    DROP FUNCTION close_season_team_registrations();
    DROP TRIGGER seasons_signing_rules ON seasons;
    DROP FUNCTION protect_season_signing_rules();
    DROP TRIGGER team_memberships_require_eligible_player ON team_memberships;
    DROP FUNCTION enforce_team_membership_eligibility();
    DROP TRIGGER team_registrations_record_events ON team_registrations;
    DROP FUNCTION record_team_registration_event();
    DROP TRIGGER team_registrations_validate ON team_registrations;
    DROP FUNCTION enforce_team_registration();
    DROP TRIGGER team_registration_events_append_only ON team_registration_events;
    DROP FUNCTION reject_team_registration_history_mutation();
  `);
  pgm.dropTable("team_registration_events");
  pgm.dropTable("team_registrations");
  pgm.dropColumn("seasons", "status_changed_by");
  pgm.dropConstraint("teams", "teams_id_league_season_unique");
};
