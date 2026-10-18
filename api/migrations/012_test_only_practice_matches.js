export const up = (pgm) => {
  pgm.addColumn("matches", {
    test_only: { type: "boolean", notNull: true, default: false },
    test_request_key: { type: "uuid" }
  });
  pgm.addConstraint("matches", "matches_test_only_practice_only", {
    check: "NOT test_only OR match_type = 'practice'"
  });
  pgm.addConstraint("matches", "matches_test_request_key_consistency", {
    check: "(test_only AND test_request_key IS NOT NULL) OR (NOT test_only AND test_request_key IS NULL)"
  });
  pgm.createIndex("matches", "test_request_key", {
    unique: true,
    where: "test_only",
    name: "matches_test_request_key_unique"
  });

  pgm.sql(`
    CREATE FUNCTION breakdish_test_practice_match_guard() RETURNS trigger AS $$
    DECLARE actor_id text;
    BEGIN
      IF TG_OP = 'INSERT' AND NEW.test_only THEN
        IF NEW.match_type <> 'practice' THEN
          RAISE EXCEPTION 'Only a Practice Match can be marked test-only.'
            USING ERRCODE = '23514', CONSTRAINT = 'matches_test_only_practice_only';
        END IF;
        actor_id := nullif(current_setting('breakdish.actor_user_id', true), '');
        IF actor_id IS DISTINCT FROM NEW.created_by OR NOT EXISTS (
          SELECT 1 FROM platform_roles WHERE user_id = actor_id AND role = 'super_admin'
        ) THEN
          RAISE EXCEPTION 'Creating a test-only Practice Match requires an authenticated Super Admin.'
            USING ERRCODE = '42501', CONSTRAINT = 'matches_test_only_super_admin_required';
        END IF;
      ELSIF TG_OP = 'UPDATE' AND (
        NEW.test_only IS DISTINCT FROM OLD.test_only OR
        NEW.test_request_key IS DISTINCT FROM OLD.test_request_key
      ) THEN
        RAISE EXCEPTION 'Test-only match classification is immutable.'
          USING ERRCODE = '55000', CONSTRAINT = 'matches_test_only_immutable';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER matches_test_only_guard
      BEFORE INSERT OR UPDATE OF test_only, test_request_key ON matches
      FOR EACH ROW EXECUTE FUNCTION breakdish_test_practice_match_guard();

    DROP VIEW practice_player_statistics;
    DROP VIEW official_competitive_player_statistics;
    DROP VIEW match_player_statistics;
    DROP VIEW match_scoreboard;

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
      m.created_at, m.started_at, m.completed_at, m.test_only
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
      FROM match_participants mp JOIN matches m ON m.id = mp.match_id AND m.test_only = false
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

export const down = (pgm) => pgm.sql(`
  DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM matches WHERE test_only) THEN
      RAISE EXCEPTION 'Cannot roll back migration 012 while test-only match records exist.';
    END IF;
  END;
  $$;

  DROP VIEW practice_player_statistics;
  DROP VIEW official_competitive_player_statistics;
  DROP VIEW match_player_statistics;
  DROP VIEW match_scoreboard;
  DROP TRIGGER matches_test_only_guard ON matches;
  DROP FUNCTION breakdish_test_practice_match_guard();
  DROP INDEX matches_test_request_key_unique;
  ALTER TABLE matches DROP CONSTRAINT matches_test_request_key_consistency;
  ALTER TABLE matches DROP CONSTRAINT matches_test_only_practice_only;
  ALTER TABLE matches DROP COLUMN test_request_key;
  ALTER TABLE matches DROP COLUMN test_only;

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
