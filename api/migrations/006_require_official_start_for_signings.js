export const up = (pgm) => {
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM team_registrations r JOIN seasons s ON s.id=r.season_id
        WHERE s.starts_on IS NULL AND s.status <> 'completed'
      ) THEN
        RAISE EXCEPTION 'Migration 006 stopped: an unfinished season has team registration history but no official start date.';
      END IF;
    END; $$;

    CREATE FUNCTION require_official_start_date_for_registration() RETURNS trigger AS $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM seasons WHERE id=NEW.season_id AND starts_on IS NOT NULL) THEN
        RAISE EXCEPTION 'Set the official season start date before registering a player.'
          USING ERRCODE='23514', CONSTRAINT='season_start_required_for_signing';
      END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER team_registrations_require_start_date
      BEFORE INSERT ON team_registrations
      FOR EACH ROW EXECUTE FUNCTION require_official_start_date_for_registration();
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP TRIGGER team_registrations_require_start_date ON team_registrations;
    DROP FUNCTION require_official_start_date_for_registration();
  `);
};
