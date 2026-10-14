export const up = (pgm) => {
  pgm.sql(`
    -- Matches refer to registration history rather than today's roster. Ending a
    -- registration therefore never invalidates an already-recorded appearance.
    ALTER TABLE team_registrations
      ADD CONSTRAINT team_registrations_match_identity_unique
      UNIQUE (id, user_id, league_id, season_id, team_id);

    CREATE TABLE tournament_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name varchar(160) NOT NULL CHECK (length(trim(name)) > 0),
      description text,
      venue varchar(160),
      starts_at timestamptz,
      status varchar(20) NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'registration_open', 'in_progress', 'completed', 'cancelled')),
      created_by text NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    -- Each template version is immutable. Editing a league format creates a
    -- version and changes the league's pointer; existing match snapshots do not move.
    CREATE TABLE league_match_format_templates (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      league_id uuid NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
      version integer NOT NULL CHECK (version > 0),
      name varchar(120) NOT NULL CHECK (length(trim(name)) > 0),
      created_by text NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (league_id, version),
      UNIQUE (id, league_id)
    );
    CREATE TABLE league_match_format_template_frames (
      template_id uuid NOT NULL REFERENCES league_match_format_templates(id) ON DELETE RESTRICT,
      frame_number smallint NOT NULL CHECK (frame_number > 0),
      frame_type varchar(12) NOT NULL CHECK (frame_type IN ('singles', 'doubles')),
      PRIMARY KEY (template_id, frame_number)
    );
    CREATE TABLE league_match_format_defaults (
      league_id uuid PRIMARY KEY REFERENCES leagues(id) ON DELETE RESTRICT,
      template_id uuid NOT NULL,
      changed_by text NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
      changed_at timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (template_id, league_id)
        REFERENCES league_match_format_templates(id, league_id) ON DELETE RESTRICT
    );
    CREATE TABLE league_match_format_default_events (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      league_id uuid NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
      previous_template_id uuid REFERENCES league_match_format_templates(id) ON DELETE RESTRICT,
      new_template_id uuid NOT NULL REFERENCES league_match_format_templates(id) ON DELETE RESTRICT,
      changed_by text NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
      changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
    );

    CREATE TABLE matches (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      match_type varchar(24) NOT NULL CHECK (match_type IN (
        'team_league', 'singles_league', 'doubles_league',
        'tournament_flyer', 'money_match', 'practice'
      )),
      status varchar(24) NOT NULL DEFAULT 'scheduled' CHECK (status IN (
        'scheduled', 'in_progress', 'awaiting_confirmation', 'disputed', 'completed', 'cancelled'
      )),
      is_official boolean GENERATED ALWAYS AS (match_type <> 'practice') STORED,
      league_id uuid,
      season_id uuid,
      division_id uuid,
      home_team_id uuid,
      away_team_id uuid,
      tournament_event_id uuid REFERENCES tournament_events(id) ON DELETE RESTRICT,
      confirmation_mode varchar(20) NOT NULL DEFAULT 'both_sides'
        CHECK (confirmation_mode = 'both_sides'),
      created_by text NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      scheduled_at timestamptz,
      venue varchar(160),
      started_at timestamptz,
      completed_at timestamptz,
      cancelled_at timestamptz,
      CHECK ((league_id IS NULL) = (season_id IS NULL)),
      CHECK (division_id IS NULL OR season_id IS NOT NULL),
      CHECK (home_team_id IS NULL OR away_team_id IS NULL OR home_team_id <> away_team_id),
      CHECK (
        (match_type = 'team_league' AND league_id IS NOT NULL AND season_id IS NOT NULL AND home_team_id IS NOT NULL AND away_team_id IS NOT NULL AND tournament_event_id IS NULL)
        OR (match_type IN ('singles_league', 'doubles_league') AND league_id IS NOT NULL AND season_id IS NOT NULL AND home_team_id IS NULL AND away_team_id IS NULL AND tournament_event_id IS NULL)
        OR (match_type = 'tournament_flyer' AND tournament_event_id IS NOT NULL AND league_id IS NULL AND season_id IS NULL AND division_id IS NULL AND home_team_id IS NULL AND away_team_id IS NULL)
        OR (match_type IN ('money_match', 'practice') AND league_id IS NULL AND season_id IS NULL AND division_id IS NULL AND tournament_event_id IS NULL AND home_team_id IS NULL AND away_team_id IS NULL)
      ),
      CHECK (
        (status = 'completed' AND completed_at IS NOT NULL)
        OR (status <> 'completed' AND completed_at IS NULL)
      ),
      CHECK (
        (status = 'cancelled' AND cancelled_at IS NOT NULL)
        OR (status <> 'cancelled' AND cancelled_at IS NULL)
      ),
      FOREIGN KEY (season_id, league_id) REFERENCES seasons(id, league_id) ON DELETE RESTRICT,
      FOREIGN KEY (division_id, season_id) REFERENCES divisions(id, season_id) ON DELETE RESTRICT,
      FOREIGN KEY (home_team_id, league_id, season_id) REFERENCES teams(id, league_id, season_id) ON DELETE RESTRICT,
      FOREIGN KEY (away_team_id, league_id, season_id) REFERENCES teams(id, league_id, season_id) ON DELETE RESTRICT
    );
    CREATE INDEX matches_category_status_created ON matches(match_type, status, created_at DESC);
    CREATE INDEX matches_league_schedule ON matches(league_id, season_id, status, created_at);
    CREATE INDEX matches_tournament_schedule ON matches(tournament_event_id, status, created_at);

    CREATE TABLE match_format_snapshots (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      match_id uuid NOT NULL UNIQUE REFERENCES matches(id) ON DELETE RESTRICT,
      template_id uuid REFERENCES league_match_format_templates(id) ON DELETE RESTRICT,
      template_version integer CHECK (template_version IS NULL OR template_version > 0),
      name varchar(120) NOT NULL CHECK (length(trim(name)) > 0),
      created_by text NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      CHECK ((template_id IS NULL) = (template_version IS NULL))
    );
    CREATE TABLE match_format_snapshot_frames (
      snapshot_id uuid NOT NULL REFERENCES match_format_snapshots(id) ON DELETE RESTRICT,
      frame_number smallint NOT NULL CHECK (frame_number > 0),
      frame_type varchar(12) NOT NULL CHECK (frame_type IN ('singles', 'doubles')),
      PRIMARY KEY (snapshot_id, frame_number)
    );
    CREATE TABLE match_frames (
      match_id uuid NOT NULL REFERENCES matches(id) ON DELETE RESTRICT,
      snapshot_id uuid NOT NULL,
      frame_number smallint NOT NULL CHECK (frame_number > 0),
      status varchar(16) NOT NULL DEFAULT 'scheduled'
        CHECK (status IN ('scheduled', 'in_progress', 'completed')),
      outcome_type varchar(16) CHECK (outcome_type IN ('played', 'bye', 'forfeit')),
      winner_side smallint CHECK (winner_side IN (1, 2)),
      forfeiting_side smallint CHECK (forfeiting_side IN (1, 2)),
      completed_by text REFERENCES "user"(id) ON DELETE RESTRICT,
      completed_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (match_id, frame_number),
      CHECK (
        (status = 'completed' AND outcome_type IS NOT NULL AND winner_side IS NOT NULL AND completed_by IS NOT NULL AND completed_at IS NOT NULL)
        OR (status <> 'completed' AND outcome_type IS NULL AND winner_side IS NULL AND forfeiting_side IS NULL AND completed_by IS NULL AND completed_at IS NULL)
      ),
      CHECK ((outcome_type = 'forfeit' AND forfeiting_side IN (1, 2) AND winner_side = 3 - forfeiting_side) OR (outcome_type IS DISTINCT FROM 'forfeit' AND forfeiting_side IS NULL)),
      FOREIGN KEY (snapshot_id, frame_number)
        REFERENCES match_format_snapshot_frames(snapshot_id, frame_number) ON DELETE CASCADE
    );

    CREATE TABLE match_participants (
      match_id uuid NOT NULL REFERENCES matches(id) ON DELETE RESTRICT,
      user_id text NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
      side smallint NOT NULL CHECK (side IN (1, 2)),
      team_registration_id uuid REFERENCES team_registrations(id) ON DELETE RESTRICT,
      added_by text NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
      added_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (match_id, user_id),
      UNIQUE (match_id, user_id, side),
      -- Eligibility and historical team scope are checked by a database trigger.
      CHECK (side IN (1, 2))
    );
    CREATE INDEX match_participants_user_history ON match_participants(user_id, match_id);

    CREATE TABLE match_frame_players (
      match_id uuid NOT NULL,
      frame_number smallint NOT NULL,
      side smallint NOT NULL CHECK (side IN (1, 2)),
      slot_number smallint NOT NULL CHECK (slot_number IN (1, 2)),
      user_id text,
      is_bye boolean NOT NULL DEFAULT false,
      selected_by text NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
      selected_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (match_id, frame_number, side, slot_number),
      CHECK ((user_id IS NOT NULL AND is_bye = false) OR (user_id IS NULL AND is_bye = true)),
      FOREIGN KEY (match_id, frame_number) REFERENCES match_frames(match_id, frame_number) ON DELETE RESTRICT,
      FOREIGN KEY (match_id, user_id, side) REFERENCES match_participants(match_id, user_id, side) ON DELETE RESTRICT
    );
    CREATE UNIQUE INDEX match_frame_players_one_slot_per_player
      ON match_frame_players(match_id, frame_number, user_id) WHERE user_id IS NOT NULL;
    CREATE INDEX match_frame_players_player_history ON match_frame_players(user_id, match_id) WHERE user_id IS NOT NULL;

    CREATE TABLE match_frame_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      match_id uuid NOT NULL,
      frame_number smallint NOT NULL,
      user_id text NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
      event_type varchar(16) NOT NULL CHECK (event_type IN ('dish', 'counter_dish')),
      recorded_by text NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
      recorded_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (match_id, frame_number)
    );

    CREATE TABLE match_confirmations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      match_id uuid NOT NULL REFERENCES matches(id) ON DELETE RESTRICT,
      side smallint NOT NULL CHECK (side IN (1, 2)),
      action varchar(12) NOT NULL CHECK (action IN ('confirmed', 'retracted')),
      confirmed_by text NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
      occurred_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX match_confirmations_latest ON match_confirmations(match_id, side, occurred_at DESC, id DESC);

    -- Disputes and their resolutions are immutable events; a dispute cannot be
    -- erased to make a result final. New confirmations after resolution are required.
    CREATE TABLE match_disputes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      match_id uuid NOT NULL REFERENCES matches(id) ON DELETE RESTRICT,
      frame_number smallint,
      raised_by text NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
      reason varchar(1000) NOT NULL CHECK (length(trim(reason)) > 0),
      created_at timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (match_id, frame_number) REFERENCES match_frames(match_id, frame_number) ON DELETE RESTRICT
    );
    CREATE TABLE match_dispute_resolutions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      dispute_id uuid NOT NULL UNIQUE REFERENCES match_disputes(id) ON DELETE RESTRICT,
      resolved_by text NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
      resolution varchar(1000) NOT NULL CHECK (length(trim(resolution)) > 0),
      created_at timestamptz NOT NULL DEFAULT now()
    );

    -- The registration workflow records manual statuses only. It performs no
    -- payment processing or custody, and Practice Match has no entry type.
    CREATE TABLE competition_entries (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      entry_type varchar(24) NOT NULL CHECK (entry_type IN (
        'team_league', 'singles_league', 'doubles_league', 'tournament_flyer', 'money_match'
      )),
      status varchar(24) NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending', 'payment_confirmed', 'approved', 'rejected', 'withdrawn'
      )),
      league_id uuid,
      season_id uuid,
      team_id uuid,
      tournament_event_id uuid REFERENCES tournament_events(id) ON DELETE RESTRICT,
      match_id uuid REFERENCES matches(id) ON DELETE RESTRICT,
      created_by text NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (season_id, league_id) REFERENCES seasons(id, league_id) ON DELETE RESTRICT,
      FOREIGN KEY (team_id, league_id, season_id) REFERENCES teams(id, league_id, season_id) ON DELETE RESTRICT,
      CHECK (
        (entry_type = 'team_league' AND league_id IS NOT NULL AND season_id IS NOT NULL AND team_id IS NOT NULL AND tournament_event_id IS NULL AND match_id IS NULL)
        OR (entry_type IN ('singles_league', 'doubles_league') AND league_id IS NOT NULL AND season_id IS NOT NULL AND team_id IS NULL AND tournament_event_id IS NULL AND match_id IS NULL)
        OR (entry_type = 'tournament_flyer' AND tournament_event_id IS NOT NULL AND league_id IS NULL AND season_id IS NULL AND team_id IS NULL AND match_id IS NULL)
        OR (entry_type = 'money_match' AND match_id IS NOT NULL AND league_id IS NULL AND season_id IS NULL AND team_id IS NULL AND tournament_event_id IS NULL)
      )
    );
    CREATE TABLE competition_entry_participants (
      entry_id uuid NOT NULL REFERENCES competition_entries(id) ON DELETE RESTRICT,
      user_id text NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
      added_by text NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
      added_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (entry_id, user_id)
    );
    CREATE TABLE competition_entry_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      entry_id uuid NOT NULL REFERENCES competition_entries(id) ON DELETE RESTRICT,
      old_status varchar(24),
      new_status varchar(24) NOT NULL CHECK (new_status IN ('pending', 'payment_confirmed', 'approved', 'rejected', 'withdrawn')),
      actor_user_id text NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
      note varchar(1000),
      occurred_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE money_match_terms (
      match_id uuid PRIMARY KEY REFERENCES matches(id) ON DELETE RESTRICT,
      player_a_id text NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
      player_b_id text NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
      wager_amount numeric(10,2) NOT NULL CHECK (wager_amount > 0),
      currency char(3) NOT NULL DEFAULT 'GBP' CHECK (currency = 'GBP'),
      appointed_admin_id text NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
      format_snapshot_id uuid NOT NULL REFERENCES match_format_snapshots(id) ON DELETE RESTRICT,
      winner_takes_wager boolean NOT NULL DEFAULT true CHECK (winner_takes_wager),
      created_by text NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      CHECK (player_a_id <> player_b_id AND appointed_admin_id NOT IN (player_a_id, player_b_id))
    );
    CREATE TABLE money_match_acknowledgements (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      match_id uuid NOT NULL REFERENCES money_match_terms(match_id) ON DELETE RESTRICT,
      acknowledgement_type varchar(36) NOT NULL CHECK (acknowledgement_type IN (
        'player_a_terms', 'player_b_terms', 'admin_role', 'admin_stake_confirmed',
        'player_a_winner_takes_wager', 'player_b_winner_takes_wager',
        'player_a_result', 'player_b_result', 'admin_final_confirmation'
      )),
      acknowledged_by text NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
      acknowledged_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE match_audit_events (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      match_id uuid NOT NULL REFERENCES matches(id) ON DELETE RESTRICT,
      frame_number smallint,
      actor_user_id text NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
      action_type varchar(48) NOT NULL,
      previous_value jsonb,
      new_value jsonb,
      occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
    );
    CREATE INDEX match_audit_events_timeline ON match_audit_events(match_id, occurred_at, id);

    CREATE FUNCTION breakdish_match_audit_append_only() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'Match audit history is append-only.' USING ERRCODE = '55000';
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER match_audit_events_append_only
      BEFORE UPDATE OR DELETE ON match_audit_events
      FOR EACH ROW EXECUTE FUNCTION breakdish_match_audit_append_only();

    CREATE FUNCTION breakdish_match_audit_row() RETURNS trigger AS $$
    DECLARE actor_id text;
    DECLARE action_name text;
    DECLARE match_key uuid;
    DECLARE frame_key smallint;
    BEGIN
      actor_id := nullif(current_setting('breakdish.actor_user_id', true), '');
      IF TG_TABLE_NAME = 'matches' AND TG_OP = 'INSERT' THEN
        actor_id := coalesce(actor_id, NEW.created_by);
      END IF;
      IF actor_id IS NULL THEN
        RAISE EXCEPTION 'A match action requires an authenticated audit actor.' USING ERRCODE = '23514';
      END IF;
      IF TG_TABLE_NAME = 'matches' THEN
        IF TG_OP = 'INSERT' AND NEW.created_by <> actor_id THEN RAISE EXCEPTION 'The match creator must match the authenticated audit actor.' USING ERRCODE = '23514'; END IF;
      ELSIF TG_TABLE_NAME = 'match_participants' THEN
        IF NEW.added_by <> actor_id THEN RAISE EXCEPTION 'Participant changes must be attributed to the authenticated audit actor.' USING ERRCODE = '23514'; END IF;
      ELSIF TG_TABLE_NAME = 'match_frame_players' THEN
        IF NEW.selected_by <> actor_id THEN RAISE EXCEPTION 'Player selections must be attributed to the authenticated audit actor.' USING ERRCODE = '23514'; END IF;
      ELSIF TG_TABLE_NAME = 'match_frames' THEN
        IF TG_OP <> 'DELETE' AND NEW.status = 'completed' AND NEW.completed_by <> actor_id THEN RAISE EXCEPTION 'Frame results must be attributed to the authenticated audit actor.' USING ERRCODE = '23514'; END IF;
      ELSIF TG_TABLE_NAME = 'match_frame_events' THEN
        IF NEW.recorded_by <> actor_id THEN RAISE EXCEPTION 'Frame events must be attributed to the authenticated audit actor.' USING ERRCODE = '23514'; END IF;
      ELSIF TG_TABLE_NAME = 'match_confirmations' THEN
        IF NEW.confirmed_by <> actor_id THEN RAISE EXCEPTION 'Confirmations must be attributed to the authenticated audit actor.' USING ERRCODE = '23514'; END IF;
      ELSIF TG_TABLE_NAME = 'match_disputes' THEN
        IF NEW.raised_by <> actor_id THEN RAISE EXCEPTION 'Disputes must be attributed to the authenticated audit actor.' USING ERRCODE = '23514'; END IF;
      ELSIF TG_TABLE_NAME = 'match_format_snapshots' THEN
        IF TG_OP = 'INSERT' AND NEW.created_by <> actor_id THEN RAISE EXCEPTION 'Format snapshots must be attributed to the authenticated audit actor.' USING ERRCODE = '23514'; END IF;
      END IF;
      action_name := nullif(current_setting('breakdish.audit_action', true), '');
      IF TG_TABLE_NAME = 'matches' THEN
        match_key := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
      ELSIF TG_TABLE_NAME = 'match_format_snapshots' THEN
        match_key := CASE WHEN TG_OP = 'DELETE' THEN OLD.match_id ELSE NEW.match_id END;
      ELSIF TG_TABLE_NAME = 'match_format_snapshot_frames' THEN
        SELECT match_id INTO match_key FROM match_format_snapshots
          WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.snapshot_id ELSE NEW.snapshot_id END;
      ELSE
        match_key := CASE WHEN TG_OP = 'DELETE' THEN OLD.match_id ELSE NEW.match_id END;
      END IF;
      IF TG_TABLE_NAME IN ('match_frames', 'match_frame_players', 'match_frame_events', 'match_format_snapshot_frames') THEN
        frame_key := CASE WHEN TG_OP = 'DELETE' THEN OLD.frame_number ELSE NEW.frame_number END;
      ELSIF TG_TABLE_NAME = 'match_disputes' THEN
        frame_key := CASE WHEN TG_OP = 'DELETE' THEN OLD.frame_number ELSE NEW.frame_number END;
      END IF;
      IF action_name IS NULL THEN
        IF TG_TABLE_NAME = 'matches' THEN
          IF TG_OP = 'INSERT' THEN action_name := 'match_created';
          ELSIF NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'awaiting_confirmation' THEN action_name := 'awaiting_confirmation';
          ELSIF NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'completed' THEN action_name := 'match_finalized';
          ELSIF NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'disputed' THEN action_name := 'match_disputed';
          ELSE action_name := 'match_changed'; END IF;
        ELSIF TG_TABLE_NAME = 'match_format_snapshots' THEN action_name := 'format_snapshot_changed';
        ELSIF TG_TABLE_NAME = 'match_format_snapshot_frames' THEN action_name := 'format_snapshot_frame_changed';
        ELSIF TG_TABLE_NAME = 'match_participants' THEN action_name := 'match_participant_changed';
        ELSIF TG_TABLE_NAME = 'match_frame_players' THEN action_name := 'player_selection_changed';
        ELSIF TG_TABLE_NAME = 'match_frames' THEN
          IF TG_OP <> 'DELETE' AND NEW.status = 'completed' THEN action_name := 'frame_result_entered'; ELSE action_name := 'match_frame_changed'; END IF;
        ELSIF TG_TABLE_NAME = 'match_frame_events' THEN action_name := 'frame_decoration_changed';
        ELSIF TG_TABLE_NAME = 'match_confirmations' THEN action_name := 'confirmation_' || NEW.action;
        ELSIF TG_TABLE_NAME = 'match_disputes' THEN action_name := 'dispute_raised';
        ELSE action_name := 'match_changed'; END IF;
      END IF;
      INSERT INTO match_audit_events(match_id, frame_number, actor_user_id, action_type, previous_value, new_value)
      VALUES (
        match_key, frame_key, actor_id, action_name,
        CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) ELSE NULL END,
        CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) ELSE NULL END
      );
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER matches_audit AFTER INSERT OR UPDATE ON matches
      FOR EACH ROW EXECUTE FUNCTION breakdish_match_audit_row();
    CREATE TRIGGER match_participants_audit AFTER INSERT OR UPDATE ON match_participants
      FOR EACH ROW EXECUTE FUNCTION breakdish_match_audit_row();
    CREATE TRIGGER match_format_snapshots_audit AFTER INSERT OR UPDATE ON match_format_snapshots
      FOR EACH ROW EXECUTE FUNCTION breakdish_match_audit_row();
    CREATE TRIGGER match_format_snapshot_frames_audit AFTER INSERT OR UPDATE OR DELETE ON match_format_snapshot_frames
      FOR EACH ROW EXECUTE FUNCTION breakdish_match_audit_row();
    CREATE TRIGGER match_frames_audit AFTER INSERT OR UPDATE OR DELETE ON match_frames
      FOR EACH ROW EXECUTE FUNCTION breakdish_match_audit_row();
    CREATE TRIGGER match_frame_players_audit AFTER INSERT OR UPDATE OR DELETE ON match_frame_players
      FOR EACH ROW EXECUTE FUNCTION breakdish_match_audit_row();
    CREATE TRIGGER match_frame_events_audit AFTER INSERT OR UPDATE OR DELETE ON match_frame_events
      FOR EACH ROW EXECUTE FUNCTION breakdish_match_audit_row();
    CREATE TRIGGER match_confirmations_audit AFTER INSERT ON match_confirmations
      FOR EACH ROW EXECUTE FUNCTION breakdish_match_audit_row();
    CREATE TRIGGER match_disputes_audit AFTER INSERT ON match_disputes
      FOR EACH ROW EXECUTE FUNCTION breakdish_match_audit_row();

    CREATE FUNCTION breakdish_audit_dispute_resolution() RETURNS trigger AS $$
    DECLARE actor_id text;
    DECLARE match_key uuid;
    BEGIN
      actor_id := nullif(current_setting('breakdish.actor_user_id', true), '');
      IF actor_id IS NULL THEN RAISE EXCEPTION 'A dispute resolution requires an authenticated audit actor.' USING ERRCODE = '23514'; END IF;
      SELECT match_id INTO match_key FROM match_disputes WHERE id = NEW.dispute_id;
      INSERT INTO match_audit_events(match_id, actor_user_id, action_type, previous_value, new_value)
        VALUES(match_key, actor_id, 'dispute_resolved', NULL, to_jsonb(NEW));
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER match_dispute_resolutions_audit AFTER INSERT ON match_dispute_resolutions
      FOR EACH ROW EXECUTE FUNCTION breakdish_audit_dispute_resolution();

    CREATE FUNCTION breakdish_record_format_default_change() RETURNS trigger AS $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM league_match_format_template_frames WHERE template_id = NEW.template_id) THEN
        RAISE EXCEPTION 'A league default format must contain at least one frame.' USING ERRCODE = '23514';
      END IF;
      INSERT INTO league_match_format_default_events(league_id, previous_template_id, new_template_id, changed_by)
        VALUES(NEW.league_id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.template_id END, NEW.template_id, NEW.changed_by);
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER league_match_format_defaults_audit AFTER INSERT OR UPDATE ON league_match_format_defaults
      FOR EACH ROW EXECUTE FUNCTION breakdish_record_format_default_change();
    CREATE TRIGGER league_match_format_default_events_append_only BEFORE UPDATE OR DELETE ON league_match_format_default_events
      FOR EACH ROW EXECUTE FUNCTION breakdish_match_audit_append_only();

    CREATE FUNCTION breakdish_validate_template_frame_insert() RETURNS trigger AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM league_match_format_defaults WHERE template_id = NEW.template_id)
         OR EXISTS (SELECT 1 FROM match_format_snapshots WHERE template_id = NEW.template_id) THEN
        RAISE EXCEPTION 'A published match format version is immutable; create a new version.' USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER league_match_format_template_frames_insert_guard BEFORE INSERT ON league_match_format_template_frames
      FOR EACH ROW EXECUTE FUNCTION breakdish_validate_template_frame_insert();

    CREATE FUNCTION breakdish_audit_money_match_row() RETURNS trigger AS $$
    DECLARE actor_id text;
    DECLARE match_key uuid;
    DECLARE action_name text;
    BEGIN
      actor_id := nullif(current_setting('breakdish.actor_user_id', true), '');
      IF actor_id IS NULL THEN RAISE EXCEPTION 'A Money Match action requires an authenticated audit actor.' USING ERRCODE = '23514'; END IF;
      match_key := CASE WHEN TG_TABLE_NAME = 'money_match_terms' THEN NEW.match_id ELSE NEW.match_id END;
      action_name := CASE WHEN TG_TABLE_NAME = 'money_match_terms' THEN 'money_terms_recorded' ELSE 'money_terms_acknowledged' END;
      INSERT INTO match_audit_events(match_id, actor_user_id, action_type, previous_value, new_value)
        VALUES(match_key, actor_id, action_name, NULL, to_jsonb(NEW));
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER money_match_terms_audit AFTER INSERT ON money_match_terms
      FOR EACH ROW EXECUTE FUNCTION breakdish_audit_money_match_row();
    CREATE TRIGGER money_match_acknowledgements_audit AFTER INSERT ON money_match_acknowledgements
      FOR EACH ROW EXECUTE FUNCTION breakdish_audit_money_match_row();
    CREATE TRIGGER match_confirmations_append_only BEFORE UPDATE OR DELETE ON match_confirmations
      FOR EACH ROW EXECUTE FUNCTION breakdish_match_audit_append_only();
    CREATE TRIGGER match_disputes_append_only BEFORE UPDATE OR DELETE ON match_disputes
      FOR EACH ROW EXECUTE FUNCTION breakdish_match_audit_append_only();
    CREATE TRIGGER match_dispute_resolutions_append_only BEFORE UPDATE OR DELETE ON match_dispute_resolutions
      FOR EACH ROW EXECUTE FUNCTION breakdish_match_audit_append_only();
    CREATE TRIGGER money_match_acknowledgements_append_only BEFORE UPDATE OR DELETE ON money_match_acknowledgements
      FOR EACH ROW EXECUTE FUNCTION breakdish_match_audit_append_only();
    CREATE TRIGGER money_match_terms_immutable BEFORE UPDATE OR DELETE ON money_match_terms
      FOR EACH ROW EXECUTE FUNCTION breakdish_match_audit_append_only();

    CREATE FUNCTION breakdish_check_match_snapshot_editable() RETURNS trigger AS $$
    DECLARE match_key uuid;
    DECLARE current_status text;
    DECLARE match_started timestamptz;
    BEGIN
      IF TG_TABLE_NAME = 'match_format_snapshots' THEN
        match_key := CASE WHEN TG_OP = 'DELETE' THEN OLD.match_id ELSE NEW.match_id END;
      ELSE
        SELECT match_id INTO match_key FROM match_format_snapshots
          WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.snapshot_id ELSE NEW.snapshot_id END;
      END IF;
      SELECT status, started_at INTO current_status, match_started FROM matches WHERE id = match_key FOR UPDATE;
      IF current_status <> 'scheduled' OR match_started IS NOT NULL OR EXISTS (
        SELECT 1 FROM match_frame_players WHERE match_id = match_key
      ) OR EXISTS (SELECT 1 FROM match_frames WHERE match_id = match_key AND status <> 'scheduled') THEN
        RAISE EXCEPTION 'A match format snapshot is editable only for an unstarted fixture without player selections.'
          USING ERRCODE = '23514', CONSTRAINT = 'match_snapshot_unplayed_only';
      END IF;
      IF TG_OP = 'DELETE' THEN
        IF TG_TABLE_NAME = 'match_format_snapshots' THEN
          RAISE EXCEPTION 'A match format snapshot cannot be deleted; update its scheduled frame list instead.' USING ERRCODE = '55000';
        END IF;
        RETURN OLD;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER match_format_snapshots_edit_guard BEFORE UPDATE OR DELETE ON match_format_snapshots
      FOR EACH ROW EXECUTE FUNCTION breakdish_check_match_snapshot_editable();
    CREATE TRIGGER match_format_snapshot_frames_edit_guard BEFORE UPDATE OR DELETE ON match_format_snapshot_frames
      FOR EACH ROW EXECUTE FUNCTION breakdish_check_match_snapshot_editable();

    CREATE FUNCTION breakdish_validate_snapshot_frame() RETURNS trigger AS $$
    DECLARE match_key uuid;
    DECLARE match_state text;
    BEGIN
      SELECT m.id, m.status INTO match_key, match_state
        FROM match_format_snapshots s JOIN matches m ON m.id = s.match_id WHERE s.id = NEW.snapshot_id FOR UPDATE OF m;
      IF match_state <> 'scheduled' THEN
        RAISE EXCEPTION 'Snapshot frames can only be created for a scheduled match.' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER match_format_snapshot_frames_validate BEFORE INSERT ON match_format_snapshot_frames
      FOR EACH ROW EXECUTE FUNCTION breakdish_validate_snapshot_frame();

    CREATE FUNCTION breakdish_validate_match_snapshot() RETURNS trigger AS $$
    DECLARE m matches%ROWTYPE;
    DECLARE template league_match_format_templates%ROWTYPE;
    BEGIN
      SELECT * INTO m FROM matches WHERE id = NEW.match_id FOR KEY SHARE;
      IF m.status <> 'scheduled' OR m.started_at IS NOT NULL THEN
        RAISE EXCEPTION 'A format snapshot must be created before a match starts.' USING ERRCODE = '23514';
      END IF;
      IF NEW.template_id IS NOT NULL THEN
        SELECT * INTO template FROM league_match_format_templates WHERE id = NEW.template_id;
        IF m.league_id IS NULL OR template.league_id <> m.league_id THEN
          RAISE EXCEPTION 'A league match snapshot must use a template from its league.' USING ERRCODE = '23514';
        END IF;
        IF NEW.template_version <> template.version THEN
          RAISE EXCEPTION 'The snapshot template version must match its immutable template.' USING ERRCODE = '23514';
        END IF;
      ELSIF m.match_type IN ('team_league', 'singles_league', 'doubles_league') THEN
        RAISE EXCEPTION 'League matches require a snapshot of their league format template.' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER match_format_snapshots_validate BEFORE INSERT ON match_format_snapshots
      FOR EACH ROW EXECUTE FUNCTION breakdish_validate_match_snapshot();

    CREATE FUNCTION breakdish_create_snapshotted_frame() RETURNS trigger AS $$
    DECLARE match_key uuid;
    BEGIN
      SELECT match_id INTO match_key FROM match_format_snapshots WHERE id = NEW.snapshot_id;
      INSERT INTO match_frames(match_id, snapshot_id, frame_number) VALUES (match_key, NEW.snapshot_id, NEW.frame_number);
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER match_format_snapshot_frames_create AFTER INSERT ON match_format_snapshot_frames
      FOR EACH ROW EXECUTE FUNCTION breakdish_create_snapshotted_frame();

    CREATE FUNCTION breakdish_validate_frame_snapshot_match() RETURNS trigger AS $$
    DECLARE expected_match uuid;
    BEGIN
      SELECT match_id INTO expected_match FROM match_format_snapshots WHERE id = NEW.snapshot_id;
      IF expected_match IS DISTINCT FROM NEW.match_id THEN
        RAISE EXCEPTION 'A frame must belong to the match that owns its format snapshot.' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER match_frames_snapshot_match BEFORE INSERT OR UPDATE ON match_frames
      FOR EACH ROW EXECUTE FUNCTION breakdish_validate_frame_snapshot_match();

    CREATE FUNCTION breakdish_immutable_match_category() RETURNS trigger AS $$
    BEGIN
      IF NEW.match_type IS DISTINCT FROM OLD.match_type OR
         NEW.league_id IS DISTINCT FROM OLD.league_id OR NEW.season_id IS DISTINCT FROM OLD.season_id OR
         NEW.division_id IS DISTINCT FROM OLD.division_id OR NEW.home_team_id IS DISTINCT FROM OLD.home_team_id OR
         NEW.away_team_id IS DISTINCT FROM OLD.away_team_id OR NEW.tournament_event_id IS DISTINCT FROM OLD.tournament_event_id THEN
        RAISE EXCEPTION 'Match category and competition identity are immutable.'
          USING ERRCODE = '23514', CONSTRAINT = 'matches_identity_immutable';
      END IF;
      IF OLD.status IN ('completed', 'cancelled') AND current_setting('breakdish.allow_admin_amendment', true) IS DISTINCT FROM 'on'
         AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'Final or cancelled matches require an audited administrator amendment.'
          USING ERRCODE = '23514', CONSTRAINT = 'matches_final_immutable';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER matches_identity_immutable BEFORE UPDATE ON matches
      FOR EACH ROW EXECUTE FUNCTION breakdish_immutable_match_category();

    CREATE FUNCTION breakdish_match_state_transition() RETURNS trigger AS $$
    DECLARE frame_count integer;
    DECLARE complete_count integer;
    DECLARE confirmation_count integer;
    DECLARE open_dispute_count integer;
    DECLARE latest_resolution timestamptz;
    DECLARE latest_score_change timestamptz;
    DECLARE money_ack_count integer;
    BEGIN
      IF NEW.status IS DISTINCT FROM OLD.status THEN
        IF NOT (
          (OLD.status = 'scheduled' AND NEW.status IN ('in_progress', 'cancelled')) OR
          (OLD.status = 'in_progress' AND NEW.status IN ('awaiting_confirmation', 'cancelled')) OR
          (OLD.status = 'awaiting_confirmation' AND NEW.status IN ('disputed', 'completed', 'cancelled')) OR
          (OLD.status = 'disputed' AND NEW.status IN ('awaiting_confirmation', 'cancelled'))
        ) THEN
          RAISE EXCEPTION 'Invalid match state transition.' USING ERRCODE = '23514', CONSTRAINT = 'matches_status_transition';
        END IF;
        IF NEW.status = 'in_progress' THEN NEW.started_at := coalesce(NEW.started_at, clock_timestamp()); END IF;
        IF NEW.status IN ('in_progress', 'awaiting_confirmation', 'disputed', 'completed') AND NOT EXISTS (
          SELECT 1 FROM match_format_snapshots s
          JOIN match_format_snapshot_frames sf ON sf.snapshot_id = s.id
          WHERE s.match_id = NEW.id
        ) THEN
          RAISE EXCEPTION 'A match requires a non-empty format snapshot before it starts.'
            USING ERRCODE = '23514', CONSTRAINT = 'matches_format_snapshot_required';
        END IF;
        IF NEW.status = 'cancelled' THEN NEW.cancelled_at := coalesce(NEW.cancelled_at, clock_timestamp()); END IF;
        IF NEW.status <> 'cancelled' THEN NEW.cancelled_at := NULL; END IF;
        IF NEW.status = 'completed' THEN
          NEW.completed_at := coalesce(NEW.completed_at, clock_timestamp());
          SELECT count(*), count(*) FILTER (WHERE status = 'completed')
            INTO frame_count, complete_count FROM match_frames WHERE match_id = NEW.id;
          IF frame_count = 0 OR complete_count <> frame_count THEN
            RAISE EXCEPTION 'Every snapshotted frame must be complete before finalization.' USING ERRCODE = '23514', CONSTRAINT = 'matches_all_frames_complete';
          END IF;
          SELECT count(*) INTO open_dispute_count FROM match_disputes d
            WHERE d.match_id = NEW.id AND NOT EXISTS (SELECT 1 FROM match_dispute_resolutions r WHERE r.dispute_id = d.id);
          IF open_dispute_count > 0 THEN
            RAISE EXCEPTION 'A disputed match cannot be finalized.' USING ERRCODE = '23514', CONSTRAINT = 'matches_no_open_dispute';
          END IF;
          SELECT max(r.created_at) INTO latest_resolution FROM match_dispute_resolutions r
            JOIN match_disputes d ON d.id = r.dispute_id WHERE d.match_id = NEW.id;
          SELECT max(occurred_at) INTO latest_score_change FROM match_audit_events
            WHERE match_id = NEW.id AND action_type IN (
              'frame_result_entered', 'player_selection_changed', 'frame_decoration_changed',
              'bye_entered', 'frame_result_changed', 'admin_amendment'
            );
          WITH latest AS (
            SELECT DISTINCT ON (side) side, action, occurred_at
            FROM match_confirmations WHERE match_id = NEW.id
            ORDER BY side, occurred_at DESC, id DESC
          )
          SELECT count(*) INTO confirmation_count FROM latest
            WHERE action = 'confirmed'
              AND (latest_resolution IS NULL OR occurred_at > latest_resolution)
              AND (latest_score_change IS NULL OR occurred_at > latest_score_change);
          IF confirmation_count < 2 THEN
            RAISE EXCEPTION 'Both sides must confirm after the most recent dispute resolution.' USING ERRCODE = '23514', CONSTRAINT = 'matches_both_sides_confirmed';
          END IF;
          IF NEW.match_type = 'money_match' THEN
            SELECT count(DISTINCT acknowledgement_type) INTO money_ack_count FROM money_match_acknowledgements
             WHERE match_id = NEW.id AND acknowledgement_type IN ('player_a_terms', 'player_b_terms', 'admin_role', 'admin_stake_confirmed', 'player_a_winner_takes_wager', 'player_b_winner_takes_wager', 'player_a_result', 'player_b_result', 'admin_final_confirmation');
            IF money_ack_count < 9 THEN
              RAISE EXCEPTION 'Money Match terms, stake acknowledgement and result confirmations must be complete.' USING ERRCODE = '23514', CONSTRAINT = 'money_match_acknowledgements_complete';
            END IF;
          END IF;
        ELSE
          NEW.completed_at := NULL;
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER matches_state_transition BEFORE UPDATE OF status ON matches
      FOR EACH ROW EXECUTE FUNCTION breakdish_match_state_transition();

    CREATE FUNCTION breakdish_validate_match_participant() RETURNS trigger AS $$
    DECLARE m matches%ROWTYPE;
    DECLARE r team_registrations%ROWTYPE;
    DECLARE expected_team uuid;
    BEGIN
      SELECT * INTO m FROM matches WHERE id = NEW.match_id FOR KEY SHARE;
      IF m.status IN ('completed', 'cancelled') THEN
        RAISE EXCEPTION 'Participants cannot be changed after a match is final.' USING ERRCODE = '23514';
      END IF;
      IF m.match_type = 'team_league' THEN
        expected_team := CASE NEW.side WHEN 1 THEN m.home_team_id ELSE m.away_team_id END;
        IF NEW.team_registration_id IS NULL THEN
          RAISE EXCEPTION 'Team match participants require a historical team registration.' USING ERRCODE = '23514';
        END IF;
        SELECT * INTO r FROM team_registrations WHERE id = NEW.team_registration_id;
        IF r.user_id IS DISTINCT FROM NEW.user_id OR r.league_id IS DISTINCT FROM m.league_id OR
           r.season_id IS DISTINCT FROM m.season_id OR r.team_id IS DISTINCT FROM expected_team OR
           r.ended_at IS NOT NULL THEN
          RAISE EXCEPTION 'Select a player currently registered to the correct team.' USING ERRCODE = '23514', CONSTRAINT = 'match_participant_team_eligibility';
        END IF;
      ELSIF NEW.team_registration_id IS NOT NULL THEN
        RAISE EXCEPTION 'Standalone match participants do not use team registrations.' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER match_participants_eligible BEFORE INSERT OR UPDATE ON match_participants
      FOR EACH ROW EXECUTE FUNCTION breakdish_validate_match_participant();

    CREATE FUNCTION breakdish_validate_frame_player() RETURNS trigger AS $$
    DECLARE frame_type text;
    DECLARE match_status text;
    BEGIN
      SELECT sf.frame_type, m.status INTO frame_type, match_status
      FROM match_frames f JOIN match_format_snapshots s ON s.match_id = f.match_id
      JOIN match_format_snapshot_frames sf ON sf.snapshot_id = s.id AND sf.frame_number = f.frame_number
      JOIN matches m ON m.id = f.match_id
      WHERE f.match_id = NEW.match_id AND f.frame_number = NEW.frame_number;
      IF match_status IN ('completed', 'cancelled') AND current_setting('breakdish.allow_admin_amendment', true) IS DISTINCT FROM 'on' THEN
        RAISE EXCEPTION 'Final match player selections require an audited administrator amendment.' USING ERRCODE = '23514';
      END IF;
      IF frame_type = 'singles' AND NEW.slot_number <> 1 THEN
        RAISE EXCEPTION 'Singles frames have one player slot per side.' USING ERRCODE = '23514', CONSTRAINT = 'match_frame_singles_slots';
      END IF;
      IF frame_type = 'doubles' AND NEW.slot_number NOT IN (1, 2) THEN
        RAISE EXCEPTION 'Doubles frames have two player slots per side.' USING ERRCODE = '23514', CONSTRAINT = 'match_frame_doubles_slots';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER match_frame_players_validate BEFORE INSERT OR UPDATE ON match_frame_players
      FOR EACH ROW EXECUTE FUNCTION breakdish_validate_frame_player();

    CREATE FUNCTION breakdish_check_bye_pairing() RETURNS trigger AS $$
    DECLARE match_key uuid;
    DECLARE frame_key smallint;
    DECLARE side_key smallint;
    DECLARE frame_type text;
    DECLARE bye_count integer;
    DECLARE player_count integer;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        match_key := OLD.match_id; frame_key := OLD.frame_number; side_key := OLD.side;
      ELSE
        match_key := NEW.match_id; frame_key := NEW.frame_number; side_key := NEW.side;
      END IF;
      SELECT sf.frame_type INTO frame_type FROM match_format_snapshot_frames sf
       JOIN match_format_snapshots s ON s.id = sf.snapshot_id
       WHERE s.match_id = match_key AND sf.frame_number = frame_key;
      SELECT count(*) FILTER (WHERE is_bye), count(*) FILTER (WHERE user_id IS NOT NULL)
        INTO bye_count, player_count FROM match_frame_players
        WHERE match_id = match_key AND frame_number = frame_key AND side = side_key;
      IF bye_count > 0 AND player_count > 0 THEN
        RAISE EXCEPTION 'A side cannot combine a player and Bye in the same frame.' USING ERRCODE = '23514', CONSTRAINT = 'match_frame_no_partial_bye';
      END IF;
      IF frame_type = 'doubles' AND bye_count > 0 AND bye_count <> 2 THEN
        RAISE EXCEPTION 'A doubles Bye occupies both slots; partial doubles Byes are unresolved.' USING ERRCODE = '23514', CONSTRAINT = 'match_frame_full_doubles_bye';
      END IF;
      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql;
    CREATE CONSTRAINT TRIGGER match_frame_players_bye_pairing
      AFTER INSERT OR UPDATE OR DELETE ON match_frame_players DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION breakdish_check_bye_pairing();

    CREATE FUNCTION breakdish_validate_frame_completion() RETURNS trigger AS $$
    DECLARE m matches%ROWTYPE;
    DECLARE frame_type text;
    DECLARE home_players integer;
    DECLARE away_players integer;
    DECLARE home_byes integer;
    DECLARE away_byes integer;
    DECLARE expected_slots integer;
    BEGIN
      IF NEW.status <> 'completed' THEN RETURN NEW; END IF;
      SELECT * INTO m FROM matches WHERE id = NEW.match_id FOR KEY SHARE;
      IF m.status IN ('completed', 'cancelled') AND current_setting('breakdish.allow_admin_amendment', true) IS DISTINCT FROM 'on' THEN
        RAISE EXCEPTION 'Final frame results require an audited administrator amendment.' USING ERRCODE = '23514';
      END IF;
      SELECT sf.frame_type INTO frame_type FROM match_format_snapshot_frames sf
        JOIN match_format_snapshots s ON s.id = sf.snapshot_id
        WHERE s.match_id = NEW.match_id AND sf.frame_number = NEW.frame_number;
      expected_slots := CASE frame_type WHEN 'singles' THEN 1 ELSE 2 END;
      SELECT count(*) FILTER (WHERE side = 1 AND user_id IS NOT NULL), count(*) FILTER (WHERE side = 2 AND user_id IS NOT NULL),
             count(*) FILTER (WHERE side = 1 AND is_bye), count(*) FILTER (WHERE side = 2 AND is_bye)
        INTO home_players, away_players, home_byes, away_byes
        FROM match_frame_players WHERE match_id = NEW.match_id AND frame_number = NEW.frame_number;
      IF NEW.outcome_type = 'played' AND (home_players <> expected_slots OR away_players <> expected_slots OR home_byes > 0 OR away_byes > 0) THEN
        RAISE EXCEPTION 'Played frames require the full player selection on both sides.' USING ERRCODE = '23514', CONSTRAINT = 'match_frame_players_required';
      END IF;
      IF NEW.outcome_type = 'bye' AND NOT (
        (home_byes = expected_slots AND away_players = expected_slots AND away_byes = 0 AND NEW.winner_side = 2)
        OR (away_byes = expected_slots AND home_players = expected_slots AND home_byes = 0 AND NEW.winner_side = 1)
      ) THEN
        RAISE EXCEPTION 'Bye frames require a complete Bye side and a valid opposing player or pair.' USING ERRCODE = '23514', CONSTRAINT = 'match_frame_bye_valid';
      END IF;
      IF NEW.outcome_type = 'forfeit' AND (home_byes > 0 OR away_byes > 0) THEN
        RAISE EXCEPTION 'Forfeit frames do not also record Bye slots.' USING ERRCODE = '23514';
      END IF;
      IF NEW.outcome_type IN ('bye', 'forfeit') AND EXISTS (
        SELECT 1 FROM match_frame_events WHERE match_id = NEW.match_id AND frame_number = NEW.frame_number
      ) THEN
        RAISE EXCEPTION 'Bye and forfeit frames cannot receive Dish or Counter Dish events.' USING ERRCODE = '23514', CONSTRAINT = 'match_frame_no_decoration_on_bye';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER match_frames_validate_completion BEFORE INSERT OR UPDATE ON match_frames
      FOR EACH ROW EXECUTE FUNCTION breakdish_validate_frame_completion();

    CREATE FUNCTION breakdish_validate_frame_event() RETURNS trigger AS $$
    DECLARE frame_row match_frames%ROWTYPE;
    DECLARE event_side smallint;
    BEGIN
      SELECT * INTO frame_row FROM match_frames WHERE match_id = NEW.match_id AND frame_number = NEW.frame_number;
      IF frame_row.status <> 'completed' OR frame_row.outcome_type <> 'played' THEN
        RAISE EXCEPTION 'Dish and Counter Dish only apply to a completed played frame.' USING ERRCODE = '23514', CONSTRAINT = 'match_frame_event_played_only';
      END IF;
      SELECT side INTO event_side FROM match_frame_players
        WHERE match_id = NEW.match_id AND frame_number = NEW.frame_number AND user_id = NEW.user_id;
      IF event_side IS DISTINCT FROM frame_row.winner_side THEN
        RAISE EXCEPTION 'Dish and Counter Dish belong to a selected player on the winning side.' USING ERRCODE = '23514', CONSTRAINT = 'match_frame_event_winner_only';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER match_frame_events_validate BEFORE INSERT OR UPDATE ON match_frame_events
      FOR EACH ROW EXECUTE FUNCTION breakdish_validate_frame_event();

    CREATE FUNCTION breakdish_auto_await_confirmation() RETURNS trigger AS $$
    DECLARE total_frames integer;
    DECLARE completed_frames integer;
    BEGIN
      IF NEW.status = 'completed' THEN
        SELECT count(*), count(*) FILTER (WHERE status = 'completed')
          INTO total_frames, completed_frames FROM match_frames WHERE match_id = NEW.match_id;
        IF total_frames > 0 AND total_frames = completed_frames THEN
          UPDATE matches SET status = 'awaiting_confirmation', updated_at = now()
           WHERE id = NEW.match_id AND status = 'in_progress';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER match_frames_all_complete AFTER INSERT OR UPDATE ON match_frames
      FOR EACH ROW EXECUTE FUNCTION breakdish_auto_await_confirmation();

    CREATE FUNCTION breakdish_validate_confirmation() RETURNS trigger AS $$
    DECLARE m matches%ROWTYPE;
    DECLARE expected_team uuid;
    DECLARE latest_action text;
    BEGIN
      SELECT * INTO m FROM matches WHERE id = NEW.match_id FOR KEY SHARE;
      IF m.status <> 'awaiting_confirmation' AND m.status <> 'disputed' THEN
        RAISE EXCEPTION 'A result can only be confirmed while awaiting confirmation or under dispute.' USING ERRCODE = '23514';
      END IF;
      IF NEW.action = 'confirmed' AND m.status = 'disputed' THEN
        RAISE EXCEPTION 'A side can confirm only after the dispute has been resolved.' USING ERRCODE = '23514';
      END IF;
      IF m.match_type = 'team_league' THEN
        expected_team := CASE NEW.side WHEN 1 THEN m.home_team_id ELSE m.away_team_id END;
        IF NOT EXISTS (
          SELECT 1 FROM team_memberships tm
          WHERE tm.team_id = expected_team AND tm.user_id = NEW.confirmed_by
            AND tm.role = 'captain' AND tm.status = 'active'
        ) AND NOT EXISTS (
          SELECT 1 FROM league_memberships lm
          WHERE lm.league_id = m.league_id AND lm.user_id = NEW.confirmed_by
            AND lm.role IN ('owner', 'administrator') AND lm.status = 'active'
        ) THEN
          RAISE EXCEPTION 'A team captain or league administrator may confirm for this side.' USING ERRCODE = '23514', CONSTRAINT = 'match_confirmation_own_side';
        END IF;
      ELSIF NOT EXISTS (
        SELECT 1 FROM match_participants WHERE match_id = NEW.match_id AND user_id = NEW.confirmed_by AND side = NEW.side
      ) THEN
        RAISE EXCEPTION 'A player may only confirm for their recorded side.' USING ERRCODE = '23514', CONSTRAINT = 'match_confirmation_own_side';
      END IF;
      IF EXISTS (SELECT 1 FROM match_confirmations WHERE match_id = NEW.match_id AND confirmed_by = NEW.confirmed_by AND side <> NEW.side) THEN
        RAISE EXCEPTION 'One user cannot confirm both sides of a match.' USING ERRCODE = '23514', CONSTRAINT = 'match_confirmation_distinct_users';
      END IF;
      SELECT action INTO latest_action FROM match_confirmations
       WHERE match_id = NEW.match_id AND side = NEW.side ORDER BY occurred_at DESC, id DESC LIMIT 1;
      IF NEW.action = 'confirmed' AND latest_action = 'confirmed' THEN
        RAISE EXCEPTION 'This side has already confirmed; retract it before confirming again.' USING ERRCODE = '23514';
      ELSIF NEW.action = 'retracted' AND latest_action IS DISTINCT FROM 'confirmed' THEN
        RAISE EXCEPTION 'There is no current side confirmation to retract.' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER match_confirmations_validate BEFORE INSERT ON match_confirmations
      FOR EACH ROW EXECUTE FUNCTION breakdish_validate_confirmation();

    CREATE FUNCTION breakdish_validate_dispute() RETURNS trigger AS $$
    DECLARE m matches%ROWTYPE;
    BEGIN
      SELECT * INTO m FROM matches WHERE id = NEW.match_id FOR UPDATE;
      IF m.status NOT IN ('awaiting_confirmation', 'disputed') THEN
        RAISE EXCEPTION 'A result can only be disputed after its frames are complete.' USING ERRCODE = '23514';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM match_participants WHERE match_id = NEW.match_id AND user_id = NEW.raised_by) THEN
        RAISE EXCEPTION 'Only a match participant may dispute its result.' USING ERRCODE = '23514';
      END IF;
      UPDATE matches SET status = 'disputed', updated_at = now() WHERE id = NEW.match_id AND status = 'awaiting_confirmation';
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER match_disputes_validate BEFORE INSERT ON match_disputes
      FOR EACH ROW EXECUTE FUNCTION breakdish_validate_dispute();

    CREATE FUNCTION breakdish_resolve_dispute() RETURNS trigger AS $$
    DECLARE unresolved integer;
    DECLARE match_row matches%ROWTYPE;
    DECLARE authorised boolean := false;
    BEGIN
      SELECT m.* INTO match_row FROM matches m JOIN match_disputes d ON d.match_id = m.id WHERE d.id = NEW.dispute_id FOR UPDATE OF m;
      IF match_row.league_id IS NOT NULL THEN
        SELECT EXISTS (SELECT 1 FROM league_memberships WHERE league_id = match_row.league_id AND user_id = NEW.resolved_by AND status = 'active' AND role IN ('owner', 'administrator')) INTO authorised;
      ELSIF match_row.tournament_event_id IS NOT NULL THEN
        SELECT EXISTS (SELECT 1 FROM tournament_events WHERE id = match_row.tournament_event_id AND created_by = NEW.resolved_by) INTO authorised;
      ELSIF match_row.match_type = 'money_match' THEN
        SELECT EXISTS (SELECT 1 FROM money_match_terms WHERE match_id = match_row.id AND appointed_admin_id = NEW.resolved_by) INTO authorised;
      ELSE
        authorised := match_row.created_by = NEW.resolved_by;
      END IF;
      IF NOT authorised THEN
        RAISE EXCEPTION 'Only the competition administrator or organiser may resolve this dispute.' USING ERRCODE = '23514', CONSTRAINT = 'match_dispute_resolution_permission';
      END IF;
      SELECT count(*) INTO unresolved FROM match_disputes d
       WHERE d.match_id = match_row.id
         AND d.id <> NEW.dispute_id
         AND NOT EXISTS (SELECT 1 FROM match_dispute_resolutions r WHERE r.dispute_id = d.id);
      IF unresolved = 0 THEN
        UPDATE matches SET status = 'awaiting_confirmation', updated_at = now()
         WHERE id = match_row.id AND status = 'disputed';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER match_dispute_resolutions_validate BEFORE INSERT ON match_dispute_resolutions
      FOR EACH ROW EXECUTE FUNCTION breakdish_resolve_dispute();

    CREATE FUNCTION breakdish_validate_money_match() RETURNS trigger AS $$
    DECLARE match_row matches%ROWTYPE;
    DECLARE format_row match_format_snapshots%ROWTYPE;
    BEGIN
      SELECT * INTO match_row FROM matches WHERE id = NEW.match_id;
      SELECT * INTO format_row FROM match_format_snapshots WHERE id = NEW.format_snapshot_id;
      IF match_row.match_type <> 'money_match' OR format_row.match_id <> NEW.match_id THEN
        RAISE EXCEPTION 'Money Match terms must reference this match and its agreed format snapshot.' USING ERRCODE = '23514';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM match_participants WHERE match_id = NEW.match_id AND user_id = NEW.player_a_id AND side = 1)
         OR NOT EXISTS (SELECT 1 FROM match_participants WHERE match_id = NEW.match_id AND user_id = NEW.player_b_id AND side = 2) THEN
        RAISE EXCEPTION 'Money Match players must be recorded on their respective sides.' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER money_match_terms_validate BEFORE INSERT OR UPDATE ON money_match_terms
      FOR EACH ROW EXECUTE FUNCTION breakdish_validate_money_match();

    CREATE FUNCTION breakdish_validate_money_ack() RETURNS trigger AS $$
    DECLARE term money_match_terms%ROWTYPE;
    DECLARE expected_user text;
    BEGIN
      SELECT * INTO term FROM money_match_terms WHERE match_id = NEW.match_id FOR KEY SHARE;
      expected_user := CASE NEW.acknowledgement_type
        WHEN 'player_a_terms' THEN term.player_a_id
        WHEN 'player_a_winner_takes_wager' THEN term.player_a_id
        WHEN 'player_a_result' THEN term.player_a_id
        WHEN 'player_b_terms' THEN term.player_b_id
        WHEN 'player_b_winner_takes_wager' THEN term.player_b_id
        WHEN 'player_b_result' THEN term.player_b_id
        ELSE term.appointed_admin_id END;
      IF NEW.acknowledged_by <> expected_user THEN
        RAISE EXCEPTION 'This Money Match acknowledgement must be recorded by the appointed participant.' USING ERRCODE = '23514';
      END IF;
      IF NEW.acknowledgement_type IN ('player_a_result', 'player_b_result', 'admin_final_confirmation') AND NOT EXISTS (
        SELECT 1 FROM money_match_acknowledgements a WHERE a.match_id = NEW.match_id
          AND a.acknowledgement_type IN ('player_a_terms','player_b_terms','admin_role','admin_stake_confirmed','player_a_winner_takes_wager','player_b_winner_takes_wager')
        GROUP BY a.match_id HAVING count(DISTINCT acknowledgement_type) = 6
      ) THEN
        RAISE EXCEPTION 'Terms and manual stake acknowledgements are required before result confirmation.' USING ERRCODE = '23514';
      END IF;
      IF NEW.acknowledgement_type = 'admin_final_confirmation' AND NOT EXISTS (
        SELECT 1 FROM money_match_acknowledgements WHERE match_id = NEW.match_id
          AND acknowledgement_type IN ('player_a_result','player_b_result') GROUP BY match_id HAVING count(DISTINCT acknowledgement_type) = 2
      ) THEN RAISE EXCEPTION 'Both players must confirm the result before the Match Admin.' USING ERRCODE = '23514'; END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER money_match_acknowledgements_validate BEFORE INSERT ON money_match_acknowledgements
      FOR EACH ROW EXECUTE FUNCTION breakdish_validate_money_ack();

    CREATE FUNCTION breakdish_validate_entry_type() RETURNS trigger AS $$
    BEGIN
      IF NEW.entry_type = 'money_match' AND NOT EXISTS (
        SELECT 1 FROM matches WHERE id = NEW.match_id AND match_type = 'money_match'
      ) THEN RAISE EXCEPTION 'Money Match entries require a Money Match.' USING ERRCODE = '23514'; END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER competition_entries_validate BEFORE INSERT OR UPDATE ON competition_entries
      FOR EACH ROW EXECUTE FUNCTION breakdish_validate_entry_type();

    CREATE FUNCTION breakdish_entry_status_history() RETURNS trigger AS $$
    DECLARE actor_id text;
    BEGIN
      actor_id := coalesce(nullif(current_setting('breakdish.actor_user_id', true), ''), NEW.created_by);
      IF TG_OP = 'INSERT' THEN
        INSERT INTO competition_entry_events(entry_id, old_status, new_status, actor_user_id)
          VALUES(NEW.id, NULL, NEW.status, actor_id);
      ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
        IF NOT (
          (OLD.status = 'pending' AND NEW.status IN ('payment_confirmed','rejected','withdrawn')) OR
          (OLD.status = 'payment_confirmed' AND NEW.status IN ('approved','rejected','withdrawn')) OR
          (OLD.status = 'approved' AND NEW.status = 'withdrawn')
        ) THEN RAISE EXCEPTION 'Invalid competition entry status transition.' USING ERRCODE = '23514'; END IF;
        IF nullif(current_setting('breakdish.actor_user_id', true), '') IS NULL THEN
          RAISE EXCEPTION 'Entry status changes require an authenticated actor.' USING ERRCODE = '23514';
        END IF;
        INSERT INTO competition_entry_events(entry_id, old_status, new_status, actor_user_id)
          VALUES(NEW.id, OLD.status, NEW.status, actor_id);
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER competition_entries_status_history AFTER INSERT OR UPDATE OF status ON competition_entries
      FOR EACH ROW EXECUTE FUNCTION breakdish_entry_status_history();
    CREATE TRIGGER competition_entry_events_append_only BEFORE UPDATE OR DELETE ON competition_entry_events
      FOR EACH ROW EXECUTE FUNCTION breakdish_match_audit_append_only();

    CREATE FUNCTION breakdish_immutable_format_history() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'Published league match format versions are immutable; create a new version.' USING ERRCODE = '55000';
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER league_match_format_templates_immutable BEFORE UPDATE OR DELETE ON league_match_format_templates
      FOR EACH ROW EXECUTE FUNCTION breakdish_immutable_format_history();
    CREATE TRIGGER league_match_format_template_frames_immutable BEFORE UPDATE OR DELETE ON league_match_format_template_frames
      FOR EACH ROW EXECUTE FUNCTION breakdish_immutable_format_history();
    CREATE VIEW match_scoreboard AS
    SELECT m.id AS match_id, m.match_type, m.status, m.league_id, m.season_id, m.division_id,
      m.home_team_id, m.away_team_id, m.tournament_event_id, m.is_official,
      m.scheduled_at, m.venue,
      count(f.frame_number)::integer AS frames_total,
      count(f.frame_number) FILTER (WHERE f.status = 'completed')::integer AS frames_completed,
      (count(f.frame_number) - count(f.frame_number) FILTER (WHERE f.status = 'completed'))::integer AS frames_remaining,
      count(f.frame_number) FILTER (WHERE f.status = 'completed' AND f.winner_side = 1)::integer AS home_score,
      count(f.frame_number) FILTER (WHERE f.status = 'completed' AND f.winner_side = 2)::integer AS away_score,
      CASE WHEN count(f.frame_number) FILTER (WHERE f.status = 'completed' AND f.winner_side = 1) > count(f.frame_number) FILTER (WHERE f.status = 'completed' AND f.winner_side = 2) THEN 1
           WHEN count(f.frame_number) FILTER (WHERE f.status = 'completed' AND f.winner_side = 2) > count(f.frame_number) FILTER (WHERE f.status = 'completed' AND f.winner_side = 1) THEN 2 END AS winner_side,
      m.created_at, m.started_at, m.completed_at
    FROM matches m LEFT JOIN match_frames f ON f.match_id = m.id
    GROUP BY m.id;

    CREATE VIEW match_player_statistics AS
    WITH frame_totals AS (
      SELECT fp.match_id, fp.user_id,
        count(*) FILTER (WHERE fp.user_id IS NOT NULL AND f.status = 'completed')::integer AS frames_played,
        count(*) FILTER (WHERE fp.user_id IS NOT NULL AND f.status = 'completed' AND f.winner_side = fp.side)::integer AS frames_won,
        count(*) FILTER (WHERE fp.user_id IS NOT NULL AND f.status = 'completed' AND f.winner_side <> fp.side)::integer AS frames_lost,
        count(*) FILTER (WHERE fp.user_id IS NOT NULL AND f.status = 'completed' AND f.winner_side = fp.side AND e.event_type = 'dish')::integer AS dishes,
        count(*) FILTER (WHERE fp.user_id IS NOT NULL AND f.status = 'completed' AND f.winner_side = fp.side AND e.event_type = 'counter_dish')::integer AS counter_dishes
      FROM match_frame_players fp JOIN match_frames f USING (match_id, frame_number)
      LEFT JOIN match_frame_events e ON e.match_id = fp.match_id AND e.frame_number = fp.frame_number AND e.user_id = fp.user_id
      WHERE fp.user_id IS NOT NULL GROUP BY fp.match_id, fp.user_id
    ), player_rows AS (
      SELECT mp.match_id, mp.user_id, mp.side, m.match_type, m.is_official, m.status,
        (m.status = 'completed') AS match_completed,
        CASE WHEN m.status = 'completed' AND coalesce(ft.frames_played, 0) > 0 THEN sb.winner_side = mp.side END AS match_won,
        CASE WHEN m.status = 'completed' AND coalesce(ft.frames_played, 0) > 0 THEN sb.winner_side IS NOT NULL AND sb.winner_side <> mp.side END AS match_lost,
        coalesce(ft.frames_played, 0) AS frames_played, coalesce(ft.frames_won, 0) AS frames_won,
        coalesce(ft.frames_lost, 0) AS frames_lost, coalesce(ft.dishes, 0) AS dishes,
        coalesce(ft.counter_dishes, 0) AS counter_dishes
      FROM match_participants mp JOIN matches m ON m.id = mp.match_id
      JOIN match_scoreboard sb ON sb.match_id = m.id
      LEFT JOIN frame_totals ft ON ft.match_id = mp.match_id AND ft.user_id = mp.user_id
    )
    SELECT user_id, match_type, is_official,
      count(*) FILTER (WHERE match_completed AND frames_played > 0)::integer AS matches_played,
      count(*) FILTER (WHERE match_won)::integer AS matches_won,
      count(*) FILTER (WHERE match_lost)::integer AS matches_lost,
      coalesce(sum(frames_played) FILTER (WHERE match_completed), 0)::bigint AS frames_played,
      coalesce(sum(frames_won) FILTER (WHERE match_completed), 0)::bigint AS frames_won,
      coalesce(sum(frames_lost) FILTER (WHERE match_completed), 0)::bigint AS frames_lost,
      coalesce(sum(dishes) FILTER (WHERE match_completed), 0)::bigint AS dishes,
      coalesce(sum(counter_dishes) FILTER (WHERE match_completed), 0)::bigint AS counter_dishes,
      round(100.0 * count(*) FILTER (WHERE match_won) /
        nullif(count(*) FILTER (WHERE match_completed AND frames_played > 0), 0), 2) AS win_percentage
    FROM player_rows GROUP BY user_id, match_type, is_official;

    CREATE VIEW practice_player_statistics AS
    SELECT user_id, sum(matches_played)::bigint AS matches_played, sum(matches_won)::bigint AS matches_won,
      sum(matches_lost)::bigint AS matches_lost, sum(frames_played)::bigint AS frames_played,
      sum(frames_won)::bigint AS frames_won, sum(frames_lost)::bigint AS frames_lost,
      sum(dishes)::bigint AS dishes, sum(counter_dishes)::bigint AS counter_dishes,
      round(100.0 * sum(matches_won) / nullif(sum(matches_played), 0), 2) AS practice_win_percentage
    FROM match_player_statistics WHERE match_type = 'practice' GROUP BY user_id;

    CREATE VIEW official_competitive_player_statistics AS
    SELECT user_id, sum(matches_played)::bigint AS matches_played, sum(matches_won)::bigint AS matches_won,
      sum(matches_lost)::bigint AS matches_lost, sum(frames_played)::bigint AS frames_played,
      sum(frames_won)::bigint AS frames_won, sum(frames_lost)::bigint AS frames_lost,
      sum(dishes)::bigint AS dishes, sum(counter_dishes)::bigint AS counter_dishes,
      round(100.0 * sum(matches_won) / nullif(sum(matches_played), 0), 2) AS competitive_win_percentage
    FROM match_player_statistics WHERE is_official GROUP BY user_id;
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM matches) OR EXISTS (SELECT 1 FROM tournament_events) OR
         EXISTS (SELECT 1 FROM league_match_format_templates) OR EXISTS (SELECT 1 FROM competition_entries) THEN
        RAISE EXCEPTION 'Cannot roll back migration 007 while match, event, template or entry history exists.';
      END IF;
    END;
    $$;
    DROP VIEW official_competitive_player_statistics;
    DROP VIEW practice_player_statistics;
    DROP VIEW match_player_statistics;
    DROP VIEW match_scoreboard;
    DROP TABLE money_match_acknowledgements;
    DROP TABLE money_match_terms;
    DROP TABLE competition_entry_events;
    DROP TABLE competition_entry_participants;
    DROP TABLE competition_entries;
    DROP TABLE match_audit_events;
    DROP TABLE match_dispute_resolutions;
    DROP TABLE match_disputes;
    DROP TABLE match_confirmations;
    DROP TABLE match_frame_events;
    DROP TABLE match_frame_players;
    DROP TABLE match_frames;
    DROP TABLE match_participants;
    DROP TABLE match_format_snapshot_frames;
    DROP TABLE match_format_snapshots;
    DROP TABLE matches;
    DROP TABLE league_match_format_defaults;
    DROP TABLE league_match_format_default_events;
    DROP TABLE league_match_format_template_frames;
    DROP TABLE league_match_format_templates;
    DROP TABLE tournament_events;
    DROP FUNCTION breakdish_validate_money_ack();
    DROP FUNCTION breakdish_audit_money_match_row();
    DROP FUNCTION breakdish_audit_dispute_resolution();
    DROP FUNCTION breakdish_validate_money_match();
    DROP FUNCTION breakdish_validate_entry_type();
    DROP FUNCTION breakdish_entry_status_history();
    DROP FUNCTION breakdish_validate_dispute();
    DROP FUNCTION breakdish_resolve_dispute();
    DROP FUNCTION breakdish_validate_confirmation();
    DROP FUNCTION breakdish_auto_await_confirmation();
    DROP FUNCTION breakdish_validate_frame_event();
    DROP FUNCTION breakdish_validate_frame_completion();
    DROP FUNCTION breakdish_check_bye_pairing();
    DROP FUNCTION breakdish_validate_frame_player();
    DROP FUNCTION breakdish_validate_match_participant();
    DROP FUNCTION breakdish_match_state_transition();
    DROP FUNCTION breakdish_immutable_match_category();
    DROP FUNCTION breakdish_match_audit_row();
    DROP FUNCTION breakdish_immutable_format_history();
    DROP FUNCTION breakdish_validate_template_frame_insert();
    DROP FUNCTION breakdish_validate_snapshot_frame();
    DROP FUNCTION breakdish_validate_match_snapshot();
    DROP FUNCTION breakdish_create_snapshotted_frame();
    DROP FUNCTION breakdish_validate_frame_snapshot_match();
    DROP FUNCTION breakdish_check_match_snapshot_editable();
    DROP FUNCTION breakdish_record_format_default_change();
    DROP FUNCTION breakdish_match_audit_append_only();
    ALTER TABLE team_registrations DROP CONSTRAINT team_registrations_match_identity_unique;
  `);
};
