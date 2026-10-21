export const up = (pgm) => {
  // Existing templates and snapshots remain NULL and retain their original
  // all-configured-frames completion behavior. New formats must state Race-to.
  // The owner-approved 500 possible-frame ceiling means Race-to can be at
  // most 250 (499 possible frames under the 2N−1 model). Legacy rows remain
  // NULL; the limit applies to newly configured Race-to formats, not history.
  pgm.addColumn("league_match_format_templates", {
    race_to: { type: "smallint" }
  });
  pgm.addColumn("match_format_snapshots", {
    race_to: { type: "smallint" }
  });
  pgm.addConstraint("league_match_format_templates", "league_match_format_race_to_valid", {
    check: "race_to IS NULL OR race_to BETWEEN 1 AND 250"
  });
  pgm.addConstraint("match_format_snapshots", "match_format_snapshot_race_to_valid", {
    check: "race_to IS NULL OR race_to BETWEEN 1 AND 250"
  });

  pgm.sql(`
    CREATE FUNCTION breakdish_require_new_race_target() RETURNS trigger AS $$
    BEGIN
      IF NEW.race_to IS NULL OR NEW.race_to < 1 OR NEW.race_to > 250 THEN
        RAISE EXCEPTION 'New match formats require a Race-to target from 1 to 250 (at most 499 possible frames).'
          USING ERRCODE = '23514', CONSTRAINT = 'match_format_race_to_required';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER league_match_format_race_target_required
      BEFORE INSERT OR UPDATE OF race_to ON league_match_format_templates
      FOR EACH ROW EXECUTE FUNCTION breakdish_require_new_race_target();
    CREATE TRIGGER match_format_snapshot_race_target_required
      BEFORE INSERT OR UPDATE OF race_to ON match_format_snapshots
      FOR EACH ROW EXECUTE FUNCTION breakdish_require_new_race_target();

    CREATE FUNCTION breakdish_validate_race_frame_count() RETURNS trigger AS $$
    DECLARE format_id uuid;
    DECLARE target smallint;
    DECLARE frame_count integer;
    DECLARE first_frame integer;
    DECLARE last_frame integer;
    BEGIN
      IF TG_TABLE_NAME = 'league_match_format_templates' THEN
        format_id := NEW.id;
        target := NEW.race_to;
        IF target IS NULL THEN RETURN NULL; END IF;
        SELECT count(*)::integer, min(frame_number)::integer, max(frame_number)::integer
          INTO frame_count, first_frame, last_frame
          FROM league_match_format_template_frames WHERE template_id = format_id;
      ELSIF TG_TABLE_NAME = 'league_match_format_template_frames' THEN
        format_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.template_id ELSE NEW.template_id END;
        SELECT race_to INTO target FROM league_match_format_templates WHERE id = format_id;
        IF target IS NULL THEN RETURN NULL; END IF;
        SELECT count(*)::integer, min(frame_number)::integer, max(frame_number)::integer
          INTO frame_count, first_frame, last_frame
          FROM league_match_format_template_frames WHERE template_id = format_id;
      ELSIF TG_TABLE_NAME = 'match_format_snapshots' THEN
        format_id := NEW.id;
        target := NEW.race_to;
        IF target IS NULL THEN RETURN NULL; END IF;
        SELECT count(*)::integer, min(frame_number)::integer, max(frame_number)::integer
          INTO frame_count, first_frame, last_frame
          FROM match_format_snapshot_frames WHERE snapshot_id = format_id;
      ELSE
        format_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.snapshot_id ELSE NEW.snapshot_id END;
        SELECT race_to INTO target FROM match_format_snapshots WHERE id = format_id;
        IF target IS NULL THEN RETURN NULL; END IF;
        SELECT count(*)::integer, min(frame_number)::integer, max(frame_number)::integer
          INTO frame_count, first_frame, last_frame
          FROM match_format_snapshot_frames WHERE snapshot_id = format_id;
      END IF;

      IF frame_count <> (2 * target - 1) OR first_frame <> 1 OR last_frame <> frame_count THEN
        RAISE EXCEPTION 'Race-to % requires exactly % consecutively numbered frames.', target, (2 * target - 1)
          USING ERRCODE = '23514', CONSTRAINT = 'match_format_race_frame_count';
      END IF;
      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql;

    CREATE CONSTRAINT TRIGGER league_match_format_race_count
      AFTER INSERT OR UPDATE ON league_match_format_templates
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      EXECUTE FUNCTION breakdish_validate_race_frame_count();
    CREATE CONSTRAINT TRIGGER league_match_format_template_frames_race_count
      AFTER INSERT OR UPDATE OR DELETE ON league_match_format_template_frames
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      EXECUTE FUNCTION breakdish_validate_race_frame_count();
    CREATE CONSTRAINT TRIGGER match_format_snapshot_race_count
      AFTER INSERT OR UPDATE ON match_format_snapshots
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      EXECUTE FUNCTION breakdish_validate_race_frame_count();
    CREATE CONSTRAINT TRIGGER match_format_snapshot_frames_race_count
      AFTER INSERT OR UPDATE OR DELETE ON match_format_snapshot_frames
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      EXECUTE FUNCTION breakdish_validate_race_frame_count();

    CREATE FUNCTION breakdish_validate_snapshot_race_target() RETURNS trigger AS $$
    DECLARE template_target smallint;
    BEGIN
      IF NEW.template_id IS NOT NULL THEN
        SELECT race_to INTO template_target FROM league_match_format_templates WHERE id = NEW.template_id;
        IF template_target IS DISTINCT FROM NEW.race_to THEN
          RAISE EXCEPTION 'A league match snapshot must preserve its template Race-to target.'
            USING ERRCODE = '23514', CONSTRAINT = 'match_snapshot_race_target_matches_template';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER match_format_snapshot_race_target_matches_template
      BEFORE INSERT OR UPDATE OF template_id, race_to ON match_format_snapshots
      FOR EACH ROW EXECUTE FUNCTION breakdish_validate_snapshot_race_target();

    CREATE OR REPLACE FUNCTION breakdish_match_state_transition() RETURNS trigger AS $$
    DECLARE frame_count integer;
    DECLARE complete_count integer;
    DECLARE confirmation_count integer;
    DECLARE open_dispute_count integer;
    DECLARE latest_resolution timestamptz;
    DECLARE latest_score_change timestamptz;
    DECLARE money_ack_count integer;
    DECLARE race_target smallint;
    DECLARE side_one_wins integer;
    DECLARE side_two_wins integer;
    DECLARE allowed_race_reopen boolean := coalesce(current_setting('breakdish.allow_race_reopen', true) = 'on', false);
    BEGIN
      IF NEW.status IS DISTINCT FROM OLD.status THEN
        IF NOT (
          (OLD.status = 'scheduled' AND NEW.status IN ('in_progress', 'cancelled')) OR
          (OLD.status = 'in_progress' AND NEW.status IN ('awaiting_confirmation', 'cancelled')) OR
          (OLD.status = 'awaiting_confirmation' AND NEW.status IN ('disputed', 'completed', 'cancelled')) OR
          (OLD.status = 'disputed' AND NEW.status IN ('awaiting_confirmation', 'cancelled')) OR
          (OLD.status = 'disputed' AND NEW.status = 'in_progress' AND allowed_race_reopen)
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

        SELECT race_to INTO race_target FROM match_format_snapshots WHERE match_id = NEW.id;
        IF NEW.status IN ('awaiting_confirmation', 'completed') AND race_target IS NOT NULL THEN
          SELECT count(*) FILTER (WHERE winner_side = 1)::integer,
                 count(*) FILTER (WHERE winner_side = 2)::integer
            INTO side_one_wins, side_two_wins FROM match_frames
            WHERE match_id = NEW.id AND status = 'completed';
          IF (CASE WHEN side_one_wins >= race_target THEN 1 ELSE 0 END)
             + (CASE WHEN side_two_wins >= race_target THEN 1 ELSE 0 END) <> 1 THEN
            RAISE EXCEPTION 'Exactly one side must reach the configured Race-to target.'
              USING ERRCODE = '23514', CONSTRAINT = 'matches_race_target_required';
          END IF;
        ELSIF NEW.status = 'in_progress' AND OLD.status = 'disputed' AND allowed_race_reopen THEN
          SELECT race_to INTO race_target FROM match_format_snapshots WHERE match_id = NEW.id;
          SELECT count(*) FILTER (WHERE winner_side = 1)::integer,
                 count(*) FILTER (WHERE winner_side = 2)::integer
            INTO side_one_wins, side_two_wins FROM match_frames
            WHERE match_id = NEW.id AND status = 'completed';
          IF race_target IS NULL OR side_one_wins >= race_target OR side_two_wins >= race_target THEN
            RAISE EXCEPTION 'A Race-to match can reopen only when no side has reached its target.'
              USING ERRCODE = '23514', CONSTRAINT = 'matches_race_reopen_target';
          END IF;
        END IF;

        IF NEW.status = 'awaiting_confirmation' AND race_target IS NULL THEN
          SELECT count(*), count(*) FILTER (WHERE status = 'completed')
            INTO frame_count, complete_count FROM match_frames WHERE match_id = NEW.id;
          IF frame_count = 0 OR complete_count <> frame_count THEN
            RAISE EXCEPTION 'Every legacy snapshotted frame must be complete before confirmation.'
              USING ERRCODE = '23514', CONSTRAINT = 'matches_all_frames_complete';
          END IF;
        END IF;

        IF NEW.status = 'completed' THEN
          NEW.completed_at := coalesce(NEW.completed_at, clock_timestamp());
          SELECT count(*), count(*) FILTER (WHERE status = 'completed')
            INTO frame_count, complete_count FROM match_frames WHERE match_id = NEW.id;
          IF frame_count = 0 OR (race_target IS NULL AND complete_count <> frame_count) THEN
            RAISE EXCEPTION 'Every legacy snapshotted frame must be complete before finalization.'
              USING ERRCODE = '23514', CONSTRAINT = 'matches_all_frames_complete';
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
             WHERE match_id = NEW.id AND acknowledgement_type IN (
               'player_a_terms', 'player_b_terms', 'admin_role', 'admin_stake_confirmed',
               'player_a_winner_takes_wager', 'player_b_winner_takes_wager',
               'player_a_result', 'player_b_result', 'admin_final_confirmation'
             );
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

    CREATE OR REPLACE FUNCTION breakdish_auto_await_confirmation() RETURNS trigger AS $$
    DECLARE total_frames integer;
    DECLARE completed_frames integer;
    DECLARE race_target smallint;
    DECLARE side_one_wins integer;
    DECLARE side_two_wins integer;
    BEGIN
      IF NEW.status = 'completed' THEN
        SELECT race_to INTO race_target FROM match_format_snapshots WHERE match_id = NEW.match_id;
        IF race_target IS NULL THEN
          SELECT count(*), count(*) FILTER (WHERE status = 'completed')
            INTO total_frames, completed_frames FROM match_frames WHERE match_id = NEW.match_id;
          IF total_frames > 0 AND total_frames = completed_frames THEN
            UPDATE matches SET status = 'awaiting_confirmation', updated_at = now()
             WHERE id = NEW.match_id AND status = 'in_progress';
          END IF;
        ELSE
          SELECT count(*) FILTER (WHERE winner_side = 1)::integer,
                 count(*) FILTER (WHERE winner_side = 2)::integer
            INTO side_one_wins, side_two_wins FROM match_frames
            WHERE match_id = NEW.match_id AND status = 'completed';
          IF (CASE WHEN side_one_wins >= race_target THEN 1 ELSE 0 END)
             + (CASE WHEN side_two_wins >= race_target THEN 1 ELSE 0 END) = 1 THEN
            UPDATE matches SET status = 'awaiting_confirmation', updated_at = now()
             WHERE id = NEW.match_id AND status = 'in_progress';
          END IF;
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE OR REPLACE FUNCTION breakdish_resolve_dispute() RETURNS trigger AS $$
    DECLARE unresolved integer;
    DECLARE match_row matches%ROWTYPE;
    DECLARE authorised boolean := false;
    DECLARE race_target smallint;
    DECLARE side_one_wins integer;
    DECLARE side_two_wins integer;
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
       WHERE d.match_id = match_row.id AND d.id <> NEW.dispute_id
         AND NOT EXISTS (SELECT 1 FROM match_dispute_resolutions r WHERE r.dispute_id = d.id);
      IF unresolved = 0 THEN
        SELECT race_to INTO race_target FROM match_format_snapshots WHERE match_id = match_row.id;
        IF race_target IS NULL THEN
          UPDATE matches SET status = 'awaiting_confirmation', updated_at = now()
           WHERE id = match_row.id AND status = 'disputed';
        ELSE
          SELECT count(*) FILTER (WHERE winner_side = 1)::integer,
                 count(*) FILTER (WHERE winner_side = 2)::integer
            INTO side_one_wins, side_two_wins FROM match_frames
            WHERE match_id = match_row.id AND status = 'completed';
          IF side_one_wins >= race_target OR side_two_wins >= race_target THEN
            UPDATE matches SET status = 'awaiting_confirmation', updated_at = now()
             WHERE id = match_row.id AND status = 'disputed';
          ELSE
            PERFORM set_config('breakdish.allow_race_reopen', 'on', true);
            UPDATE matches SET status = 'in_progress', updated_at = now()
             WHERE id = match_row.id AND status = 'disputed';
          END IF;
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE FUNCTION breakdish_race_match_remains_won() RETURNS trigger AS $$
    DECLARE race_target smallint;
    DECLARE side_one_wins integer;
    DECLARE side_two_wins integer;
    BEGIN
      SELECT s.race_to INTO race_target FROM match_format_snapshots s WHERE s.match_id = NEW.match_id;
      IF race_target IS NOT NULL AND EXISTS (
        SELECT 1 FROM matches WHERE id = NEW.match_id AND status = 'completed'
      ) THEN
        SELECT count(*) FILTER (WHERE winner_side = 1)::integer,
               count(*) FILTER (WHERE winner_side = 2)::integer
          INTO side_one_wins, side_two_wins FROM match_frames
          WHERE match_id = NEW.match_id AND status = 'completed';
        IF (CASE WHEN side_one_wins >= race_target THEN 1 ELSE 0 END)
           + (CASE WHEN side_two_wins >= race_target THEN 1 ELSE 0 END) <> 1 THEN
          RAISE EXCEPTION 'A finalized Race-to result must retain exactly one side at the target.'
            USING ERRCODE = '23514', CONSTRAINT = 'matches_race_target_required';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE CONSTRAINT TRIGGER match_frames_final_race_winner
      AFTER UPDATE ON match_frames DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION breakdish_race_match_remains_won();
  `);
};

export const down = (pgm) => pgm.sql(`
  DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM league_match_format_templates WHERE race_to IS NOT NULL)
       OR EXISTS (SELECT 1 FROM match_format_snapshots WHERE race_to IS NOT NULL) THEN
      RAISE EXCEPTION 'Cannot roll back Race-to migration 013 after Race-to formats or match snapshots have been created.';
    END IF;
  END;
  $$;

  DROP TRIGGER match_frames_final_race_winner ON match_frames;
  DROP FUNCTION breakdish_race_match_remains_won();
  DROP TRIGGER match_format_snapshot_race_count ON match_format_snapshots;
  DROP TRIGGER match_format_snapshot_frames_race_count ON match_format_snapshot_frames;
  DROP TRIGGER league_match_format_race_count ON league_match_format_templates;
  DROP TRIGGER league_match_format_template_frames_race_count ON league_match_format_template_frames;
  DROP TRIGGER match_format_snapshot_race_target_matches_template ON match_format_snapshots;
  DROP TRIGGER league_match_format_race_target_required ON league_match_format_templates;
  DROP TRIGGER match_format_snapshot_race_target_required ON match_format_snapshots;
  DROP FUNCTION breakdish_validate_race_frame_count();
  DROP FUNCTION breakdish_validate_snapshot_race_target();
  DROP FUNCTION breakdish_require_new_race_target();

  CREATE OR REPLACE FUNCTION breakdish_match_state_transition() RETURNS trigger AS $$
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
          SELECT 1 FROM match_format_snapshots s JOIN match_format_snapshot_frames sf ON sf.snapshot_id = s.id WHERE s.match_id = NEW.id
        ) THEN RAISE EXCEPTION 'A match requires a non-empty format snapshot before it starts.' USING ERRCODE = '23514', CONSTRAINT = 'matches_format_snapshot_required'; END IF;
        IF NEW.status = 'cancelled' THEN NEW.cancelled_at := coalesce(NEW.cancelled_at, clock_timestamp()); END IF;
        IF NEW.status <> 'cancelled' THEN NEW.cancelled_at := NULL; END IF;
        IF NEW.status = 'completed' THEN
          NEW.completed_at := coalesce(NEW.completed_at, clock_timestamp());
          SELECT count(*), count(*) FILTER (WHERE status = 'completed') INTO frame_count, complete_count FROM match_frames WHERE match_id = NEW.id;
          IF frame_count = 0 OR complete_count <> frame_count THEN RAISE EXCEPTION 'Every snapshotted frame must be complete before finalization.' USING ERRCODE = '23514', CONSTRAINT = 'matches_all_frames_complete'; END IF;
          SELECT count(*) INTO open_dispute_count FROM match_disputes d WHERE d.match_id = NEW.id AND NOT EXISTS (SELECT 1 FROM match_dispute_resolutions r WHERE r.dispute_id = d.id);
          IF open_dispute_count > 0 THEN RAISE EXCEPTION 'A disputed match cannot be finalized.' USING ERRCODE = '23514', CONSTRAINT = 'matches_no_open_dispute'; END IF;
          SELECT max(r.created_at) INTO latest_resolution FROM match_dispute_resolutions r JOIN match_disputes d ON d.id = r.dispute_id WHERE d.match_id = NEW.id;
          SELECT max(occurred_at) INTO latest_score_change FROM match_audit_events WHERE match_id = NEW.id AND action_type IN ('frame_result_entered', 'player_selection_changed', 'frame_decoration_changed', 'bye_entered', 'frame_result_changed', 'admin_amendment');
          WITH latest AS (SELECT DISTINCT ON (side) side, action, occurred_at FROM match_confirmations WHERE match_id = NEW.id ORDER BY side, occurred_at DESC, id DESC)
          SELECT count(*) INTO confirmation_count FROM latest WHERE action = 'confirmed' AND (latest_resolution IS NULL OR occurred_at > latest_resolution) AND (latest_score_change IS NULL OR occurred_at > latest_score_change);
          IF confirmation_count < 2 THEN RAISE EXCEPTION 'Both sides must confirm after the most recent dispute resolution.' USING ERRCODE = '23514', CONSTRAINT = 'matches_both_sides_confirmed'; END IF;
          IF NEW.match_type = 'money_match' THEN
            SELECT count(DISTINCT acknowledgement_type) INTO money_ack_count FROM money_match_acknowledgements WHERE match_id = NEW.id AND acknowledgement_type IN ('player_a_terms', 'player_b_terms', 'admin_role', 'admin_stake_confirmed', 'player_a_winner_takes_wager', 'player_b_winner_takes_wager', 'player_a_result', 'player_b_result', 'admin_final_confirmation');
            IF money_ack_count < 9 THEN RAISE EXCEPTION 'Money Match terms, stake acknowledgement and result confirmations must be complete.' USING ERRCODE = '23514', CONSTRAINT = 'money_match_acknowledgements_complete'; END IF;
          END IF;
        ELSE NEW.completed_at := NULL;
        END IF;
      END IF;
      RETURN NEW;
    END;
  $$ LANGUAGE plpgsql;

  CREATE OR REPLACE FUNCTION breakdish_auto_await_confirmation() RETURNS trigger AS $$
    DECLARE total_frames integer; DECLARE completed_frames integer;
    BEGIN
      IF NEW.status = 'completed' THEN
        SELECT count(*), count(*) FILTER (WHERE status = 'completed') INTO total_frames, completed_frames FROM match_frames WHERE match_id = NEW.match_id;
        IF total_frames > 0 AND total_frames = completed_frames THEN
          UPDATE matches SET status = 'awaiting_confirmation', updated_at = now() WHERE id = NEW.match_id AND status = 'in_progress';
        END IF;
      END IF;
      RETURN NEW;
    END;
  $$ LANGUAGE plpgsql;

  CREATE OR REPLACE FUNCTION breakdish_resolve_dispute() RETURNS trigger AS $$
    DECLARE unresolved integer; DECLARE match_row matches%ROWTYPE; DECLARE authorised boolean := false;
    BEGIN
      SELECT m.* INTO match_row FROM matches m JOIN match_disputes d ON d.match_id = m.id WHERE d.id = NEW.dispute_id FOR UPDATE OF m;
      IF match_row.league_id IS NOT NULL THEN
        SELECT EXISTS (SELECT 1 FROM league_memberships WHERE league_id = match_row.league_id AND user_id = NEW.resolved_by AND status = 'active' AND role IN ('owner', 'administrator')) INTO authorised;
      ELSIF match_row.tournament_event_id IS NOT NULL THEN
        SELECT EXISTS (SELECT 1 FROM tournament_events WHERE id = match_row.tournament_event_id AND created_by = NEW.resolved_by) INTO authorised;
      ELSIF match_row.match_type = 'money_match' THEN
        SELECT EXISTS (SELECT 1 FROM money_match_terms WHERE match_id = match_row.id AND appointed_admin_id = NEW.resolved_by) INTO authorised;
      ELSE authorised := match_row.created_by = NEW.resolved_by;
      END IF;
      IF NOT authorised THEN RAISE EXCEPTION 'Only the competition administrator or organiser may resolve this dispute.' USING ERRCODE = '23514', CONSTRAINT = 'match_dispute_resolution_permission'; END IF;
      SELECT count(*) INTO unresolved FROM match_disputes d WHERE d.match_id = match_row.id AND d.id <> NEW.dispute_id AND NOT EXISTS (SELECT 1 FROM match_dispute_resolutions r WHERE r.dispute_id = d.id);
      IF unresolved = 0 THEN UPDATE matches SET status = 'awaiting_confirmation', updated_at = now() WHERE id = match_row.id AND status = 'disputed'; END IF;
      RETURN NEW;
    END;
  $$ LANGUAGE plpgsql;

  ALTER TABLE match_format_snapshots DROP CONSTRAINT match_format_snapshot_race_to_valid;
  ALTER TABLE league_match_format_templates DROP CONSTRAINT league_match_format_race_to_valid;
  ALTER TABLE match_format_snapshots DROP COLUMN race_to;
  ALTER TABLE league_match_format_templates DROP COLUMN race_to;
`);
