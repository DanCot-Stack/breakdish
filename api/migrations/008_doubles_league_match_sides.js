export const up = (pgm) => pgm.sql(`
  DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM matches WHERE match_type = 'doubles_league') THEN
      RAISE EXCEPTION 'Migration 008 requires review of existing Doubles League matches before assigning entry sides.';
    END IF;
  END;
  $$;

  CREATE TABLE match_doubles_league_sides (
    match_id uuid NOT NULL REFERENCES matches(id) ON DELETE RESTRICT,
    side smallint NOT NULL CHECK (side IN (1, 2)),
    entry_id uuid NOT NULL REFERENCES competition_entries(id) ON DELETE RESTRICT,
    assigned_by text NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
    assigned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (match_id, side),
    UNIQUE (match_id, entry_id)
  );
  CREATE INDEX match_doubles_league_sides_entry_history ON match_doubles_league_sides(entry_id, match_id);

  CREATE FUNCTION breakdish_immutable_linked_doubles_entry_identity() RETURNS trigger AS $$
  BEGIN
    IF (NEW.entry_type IS DISTINCT FROM OLD.entry_type OR NEW.league_id IS DISTINCT FROM OLD.league_id
      OR NEW.season_id IS DISTINCT FROM OLD.season_id)
      AND EXISTS (SELECT 1 FROM match_doubles_league_sides WHERE entry_id = OLD.id) THEN
      RAISE EXCEPTION 'A Doubles League entry linked to match history cannot change its competition identity.'
        USING ERRCODE = '55000', CONSTRAINT = 'competition_entry_doubles_identity_immutable';
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;
  CREATE TRIGGER competition_entries_doubles_identity_immutable
    BEFORE UPDATE OF entry_type, league_id, season_id ON competition_entries
    FOR EACH ROW EXECUTE FUNCTION breakdish_immutable_linked_doubles_entry_identity();

  CREATE FUNCTION breakdish_lock_doubles_entry_roster() RETURNS trigger AS $$
  DECLARE entry_record record;
  DECLARE entry_keys uuid[];
  BEGIN
    IF TG_OP = 'UPDATE' THEN
      entry_keys := ARRAY[OLD.entry_id, NEW.entry_id];
    ELSIF TG_OP = 'DELETE' THEN
      entry_keys := ARRAY[OLD.entry_id];
    ELSE
      entry_keys := ARRAY[NEW.entry_id];
    END IF;
    FOR entry_record IN
      SELECT id, entry_type FROM competition_entries
      WHERE id = ANY(entry_keys) ORDER BY id FOR UPDATE
    LOOP
      IF entry_record.entry_type = 'doubles_league' THEN
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END IF;
    END LOOP;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;
  CREATE TRIGGER competition_entry_participants_lock_doubles_roster
    BEFORE INSERT OR UPDATE OR DELETE ON competition_entry_participants
    FOR EACH ROW EXECUTE FUNCTION breakdish_lock_doubles_entry_roster();

  CREATE FUNCTION breakdish_validate_doubles_league_side() RETURNS trigger AS $$
  DECLARE match_record matches%ROWTYPE;
  DECLARE entry_record competition_entries%ROWTYPE;
  DECLARE actor_id text;
  DECLARE roster_count integer;
  DECLARE eligible_count integer := 0;
  DECLARE roster_user text;
  DECLARE member_status text;
  BEGIN
    actor_id := nullif(current_setting('breakdish.actor_user_id', true), '');
    SELECT * INTO match_record FROM matches WHERE id = NEW.match_id FOR UPDATE;
    IF match_record.match_type <> 'doubles_league' OR match_record.status <> 'scheduled' OR match_record.started_at IS NOT NULL THEN
      RAISE EXCEPTION 'Doubles League sides can be assigned only to a scheduled Doubles League fixture.'
        USING ERRCODE = '23514', CONSTRAINT = 'match_doubles_side_match_eligibility';
    END IF;
    IF actor_id IS NULL OR NEW.assigned_by IS DISTINCT FROM actor_id OR NOT EXISTS (
      SELECT 1 FROM league_memberships lm WHERE lm.league_id = match_record.league_id
        AND lm.user_id = actor_id AND lm.status = 'active' AND lm.role IN ('owner', 'administrator')
    ) THEN
      RAISE EXCEPTION 'Assigning Doubles League sides requires an active league owner or administrator.'
        USING ERRCODE = '23514', CONSTRAINT = 'match_doubles_side_manager_required';
    END IF;

    SELECT * INTO entry_record FROM competition_entries WHERE id = NEW.entry_id FOR KEY SHARE;
    IF entry_record.id IS NULL OR entry_record.entry_type <> 'doubles_league' OR entry_record.status <> 'approved'
      OR entry_record.league_id IS DISTINCT FROM match_record.league_id
      OR entry_record.season_id IS DISTINCT FROM match_record.season_id THEN
      RAISE EXCEPTION 'Each Doubles League fixture side must use a different approved pair from the same league and season.'
        USING ERRCODE = '23514', CONSTRAINT = 'match_doubles_side_entry_eligibility';
    END IF;

    SELECT count(*)::integer INTO roster_count
      FROM competition_entry_participants WHERE entry_id = entry_record.id;
    IF roster_count <> 2 THEN
      RAISE EXCEPTION 'An approved Doubles League entry must contain exactly two players.'
        USING ERRCODE = '23514', CONSTRAINT = 'doubles_entry_exactly_two_players';
    END IF;
    FOR roster_user IN
      SELECT user_id FROM competition_entry_participants WHERE entry_id = entry_record.id ORDER BY user_id
    LOOP
      member_status := NULL;
      SELECT status INTO member_status FROM league_memberships
        WHERE league_id = match_record.league_id AND user_id = roster_user FOR SHARE;
      IF member_status IS DISTINCT FROM 'active' THEN
        RAISE EXCEPTION 'Both players in a Doubles League pair must be active league members.'
          USING ERRCODE = '23514', CONSTRAINT = 'doubles_entry_active_members_only';
      END IF;
      eligible_count := eligible_count + 1;
    END LOOP;
    IF eligible_count <> 2 THEN
      RAISE EXCEPTION 'An approved Doubles League entry must contain exactly two eligible players.'
        USING ERRCODE = '23514', CONSTRAINT = 'doubles_entry_exactly_two_eligible_players';
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;
  CREATE TRIGGER match_doubles_league_sides_validate
    BEFORE INSERT ON match_doubles_league_sides
    FOR EACH ROW EXECUTE FUNCTION breakdish_validate_doubles_league_side();

  CREATE FUNCTION breakdish_immutable_doubles_league_side() RETURNS trigger AS $$
  BEGIN
    RAISE EXCEPTION 'Doubles League fixture sides are permanent historical records.'
      USING ERRCODE = '55000', CONSTRAINT = 'match_doubles_league_sides_immutable';
  END;
  $$ LANGUAGE plpgsql;
  CREATE TRIGGER match_doubles_league_sides_immutable
    BEFORE UPDATE OR DELETE ON match_doubles_league_sides
    FOR EACH ROW EXECUTE FUNCTION breakdish_immutable_doubles_league_side();

  CREATE FUNCTION breakdish_validate_doubles_match_participant() RETURNS trigger AS $$
  DECLARE match_type_name text;
  DECLARE participant_entry uuid;
  BEGIN
    IF TG_OP = 'DELETE' THEN
      SELECT match_type INTO match_type_name FROM matches WHERE id = OLD.match_id;
      IF match_type_name = 'doubles_league' THEN
        RAISE EXCEPTION 'Doubles League match participant snapshots cannot be changed or deleted.'
          USING ERRCODE = '55000', CONSTRAINT = 'match_doubles_participants_immutable';
      END IF;
      RETURN OLD;
    END IF;
    IF TG_OP = 'UPDATE' THEN
      SELECT match_type INTO match_type_name FROM matches WHERE id = OLD.match_id;
      IF match_type_name = 'doubles_league' THEN
        RAISE EXCEPTION 'Doubles League match participant snapshots cannot be changed or deleted.'
          USING ERRCODE = '55000', CONSTRAINT = 'match_doubles_participants_immutable';
      END IF;
    END IF;

    participant_entry := NULL;
    SELECT m.match_type, s.entry_id INTO match_type_name, participant_entry
      FROM matches m LEFT JOIN match_doubles_league_sides s ON s.match_id = m.id AND s.side = NEW.side
      WHERE m.id = NEW.match_id;
    IF match_type_name = 'doubles_league' AND (
      NEW.team_registration_id IS NOT NULL OR participant_entry IS NULL OR NOT EXISTS (
        SELECT 1 FROM competition_entry_participants ep
        WHERE ep.entry_id = participant_entry AND ep.user_id = NEW.user_id
      )
    ) THEN
      RAISE EXCEPTION 'A Doubles League match participant must be part of that side’s approved entry.'
        USING ERRCODE = '23514', CONSTRAINT = 'match_doubles_participant_entry_eligibility';
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;
  CREATE TRIGGER match_doubles_participants_validate
    BEFORE INSERT OR UPDATE OR DELETE ON match_participants
    FOR EACH ROW EXECUTE FUNCTION breakdish_validate_doubles_match_participant();

  CREATE FUNCTION breakdish_validate_doubles_match_complete() RETURNS trigger AS $$
  DECLARE match_key uuid;
    DECLARE match_type_name text;
    DECLARE side_count integer;
    DECLARE participant_count integer;
    DECLARE side_row record;
  BEGIN
    IF TG_TABLE_NAME = 'matches' THEN
      match_key := NEW.id;
    ELSE
      match_key := NEW.match_id;
    END IF;
    SELECT match_type INTO match_type_name FROM matches WHERE id = match_key;
    SELECT count(*)::integer INTO side_count FROM match_doubles_league_sides WHERE match_id = match_key;
    IF match_type_name = 'doubles_league' THEN
      IF side_count <> 2 THEN
        RAISE EXCEPTION 'A Doubles League fixture requires two approved entry sides.'
          USING ERRCODE = '23514', CONSTRAINT = 'match_doubles_exactly_two_sides';
      END IF;
      FOR side_row IN SELECT side FROM match_doubles_league_sides WHERE match_id = match_key LOOP
        SELECT count(*)::integer INTO participant_count FROM match_participants
          WHERE match_id = match_key AND side = side_row.side;
        IF participant_count <> 2 THEN
          RAISE EXCEPTION 'Each Doubles League match side requires a two-player historical snapshot.'
            USING ERRCODE = '23514', CONSTRAINT = 'match_doubles_exactly_two_participants_per_side';
        END IF;
      END LOOP;
    ELSIF side_count <> 0 THEN
      RAISE EXCEPTION 'Only Doubles League matches can have doubles entry sides.'
        USING ERRCODE = '23514', CONSTRAINT = 'match_doubles_sides_category';
    END IF;
    IF TG_TABLE_NAME = 'matches' THEN RETURN NEW; END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;
  CREATE CONSTRAINT TRIGGER matches_doubles_fixture_complete
    AFTER INSERT OR UPDATE ON matches DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION breakdish_validate_doubles_match_complete();
  CREATE CONSTRAINT TRIGGER match_doubles_sides_fixture_complete
    AFTER INSERT ON match_doubles_league_sides DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION breakdish_validate_doubles_match_complete();
`);

export const down = (pgm) => pgm.sql(`
  DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM match_doubles_league_sides) THEN
      RAISE EXCEPTION 'Cannot roll back migration 008 while Doubles League fixture history exists.';
    END IF;
  END;
  $$;
  DROP TRIGGER match_doubles_sides_fixture_complete ON match_doubles_league_sides;
  DROP TRIGGER matches_doubles_fixture_complete ON matches;
  DROP TRIGGER match_doubles_participants_validate ON match_participants;
  DROP TRIGGER match_doubles_league_sides_immutable ON match_doubles_league_sides;
  DROP TRIGGER match_doubles_league_sides_validate ON match_doubles_league_sides;
  DROP TRIGGER competition_entry_participants_lock_doubles_roster ON competition_entry_participants;
  DROP TRIGGER competition_entries_doubles_identity_immutable ON competition_entries;
  DROP FUNCTION breakdish_validate_doubles_match_complete();
  DROP FUNCTION breakdish_validate_doubles_match_participant();
  DROP FUNCTION breakdish_immutable_linked_doubles_entry_identity();
  DROP FUNCTION breakdish_immutable_doubles_league_side();
  DROP FUNCTION breakdish_validate_doubles_league_side();
  DROP FUNCTION breakdish_lock_doubles_entry_roster();
  DROP TABLE match_doubles_league_sides;
`);
