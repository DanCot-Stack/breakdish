export const up = (pgm) => {
  pgm.sql(`
    CREATE FUNCTION prevent_team_registration_delete() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'Team registration history cannot be deleted.'
        USING ERRCODE='55000', CONSTRAINT='team_registration_history_immutable';
    END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER team_registrations_no_delete
      BEFORE DELETE ON team_registrations
      FOR EACH ROW EXECUTE FUNCTION prevent_team_registration_delete();
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM team_registrations) THEN
        RAISE EXCEPTION 'Cannot remove the registration-history protection while history exists.';
      END IF;
    END; $$;
    DROP TRIGGER team_registrations_no_delete ON team_registrations;
    DROP FUNCTION prevent_team_registration_delete();
  `);
};
