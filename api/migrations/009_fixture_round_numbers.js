export const up = (pgm) => pgm.sql(`
  ALTER TABLE matches ADD COLUMN round_number smallint;
  ALTER TABLE matches ADD CONSTRAINT matches_round_number_allowed CHECK (
    round_number IS NULL OR (
      round_number > 0
      AND match_type IN ('team_league', 'singles_league', 'doubles_league')
      AND league_id IS NOT NULL AND season_id IS NOT NULL
    )
  );
  CREATE INDEX matches_league_round_lookup
    ON matches(league_id, season_id, match_type, division_id, round_number)
    WHERE round_number IS NOT NULL;

  CREATE FUNCTION breakdish_match_round_identity_immutable() RETURNS trigger AS $$
  BEGIN
    IF NEW.round_number IS DISTINCT FROM OLD.round_number THEN
      RAISE EXCEPTION 'A fixture round number is immutable once recorded.'
        USING ERRCODE = '55000', CONSTRAINT = 'matches_round_number_immutable';
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;
  CREATE TRIGGER matches_round_number_immutable
    BEFORE UPDATE OF round_number ON matches
    FOR EACH ROW EXECUTE FUNCTION breakdish_match_round_identity_immutable();
`);

export const down = (pgm) => pgm.sql(`
  DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM matches WHERE round_number IS NOT NULL) THEN
      RAISE EXCEPTION 'Cannot roll back migration 009 while fixture round history exists.';
    END IF;
  END;
  $$;
  DROP TRIGGER matches_round_number_immutable ON matches;
  DROP FUNCTION breakdish_match_round_identity_immutable();
  DROP INDEX matches_league_round_lookup;
  ALTER TABLE matches DROP CONSTRAINT matches_round_number_allowed;
  ALTER TABLE matches DROP COLUMN round_number;
`);
