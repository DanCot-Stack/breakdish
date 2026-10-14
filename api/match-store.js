import { LeagueStoreError } from "./league-store.js";

const MATCH_TYPES = new Set([
  "team_league", "singles_league", "doubles_league", "tournament_flyer", "money_match", "practice"
]);
const MATCH_STATUSES = new Set(["scheduled", "in_progress", "awaiting_confirmation", "disputed", "completed", "cancelled"]);
const FRAME_TYPES = new Set(["singles", "doubles"]);

function invalid(message) {
  throw new LeagueStoreError(400, message);
}

function cleanUuid(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    invalid(`Enter a valid ${label}.`);
  }
  return value;
}

function cleanAccountId(value, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || /[\u0000-\u001f\u007f]/u.test(value)) {
    invalid(`Enter a valid ${label}.`);
  }
  return value;
}

function mapDatabaseError(error) {
  if (error instanceof LeagueStoreError) return error;
  if (error.constraint === "match_frame_full_doubles_bye" || error.constraint === "match_frame_no_partial_bye") {
    return new LeagueStoreError(400, "A doubles Bye uses both player slots. Partial doubles Byes are not supported.");
  }
  if (error.constraint === "match_participant_team_eligibility" || error.constraint === "team_member_active_league_membership") {
    return new LeagueStoreError(409, "That player is not currently eligible for this side.");
  }
  if (error.constraint === "matches_both_sides_confirmed" || error.constraint === "matches_no_open_dispute" || error.constraint === "matches_all_frames_complete") {
    return new LeagueStoreError(409, error.message || "The match is not ready for final confirmation.");
  }
  if (error.constraint === "match_confirmation_distinct_users") {
    return new LeagueStoreError(409, "One person cannot confirm both sides of a match.");
  }
  if (error.constraint === "matches_status_transition" || error.constraint === "matches_format_snapshot_required") {
    return new LeagueStoreError(409, "This match cannot move to that state yet.");
  }
  if (error.code === "23505") return new LeagueStoreError(409, "That match or player selection already exists.");
  if (error.code === "23503") return new LeagueStoreError(404, "A referenced player, team, season or match could not be found.");
  if (error.code === "23514") return new LeagueStoreError(409, error.message || "That change conflicts with the match rules.");
  return error;
}

async function withTransaction(database, actorId, work) {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    if (actorId) await client.query("SELECT set_config('breakdish.actor_user_id', $1, true)", [actorId]);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* Keep the original error. */ }
    throw mapDatabaseError(error);
  } finally {
    client.release();
  }
}

async function requireMatch(client, matchId, lock = false) {
  const result = await client.query(
    `SELECT m.*, sb.frames_total, sb.frames_completed, sb.frames_remaining,
       sb.home_score, sb.away_score, sb.winner_side
     FROM matches m JOIN match_scoreboard sb ON sb.match_id = m.id
     WHERE m.id = $1 ${lock ? "FOR UPDATE OF m" : ""}`,
    [matchId]
  );
  if (!result.rows[0]) throw new LeagueStoreError(404, "This match could not be found.");
  return result.rows[0];
}

async function requireLeagueManager(client, leagueId, actorId) {
  const result = await client.query(
    `SELECT role FROM league_memberships
     WHERE league_id = $1 AND user_id = $2 AND status = 'active' FOR UPDATE`,
    [leagueId, actorId]
  );
  if (!["owner", "administrator"].includes(result.rows[0]?.role)) {
    throw new LeagueStoreError(403, "Only an active league owner or administrator can manage this match or format.");
  }
}

async function requireCompletedMatchAmendment(client, match, actorId) {
  if (!new Set(["completed", "disputed"]).has(match.status)) return false;
  if (match.league_id) {
    await requireLeagueManager(client, match.league_id, actorId);
  } else if (match.tournament_event_id) {
    const result = await client.query("SELECT created_by FROM tournament_events WHERE id = $1", [match.tournament_event_id]);
    if (result.rows[0]?.created_by !== actorId) throw new LeagueStoreError(403, "Only the tournament organiser can amend this match.");
  } else if (match.match_type === "money_match") {
    const result = await client.query("SELECT appointed_admin_id FROM money_match_terms WHERE match_id = $1", [match.id]);
    if (result.rows[0]?.appointed_admin_id !== actorId) throw new LeagueStoreError(403, "Only the appointed Match Admin can amend this match.");
  } else {
    const result = await client.query(
      `SELECT created_by FROM matches WHERE id = $1`,
      [match.id]
    );
    if (result.rows[0]?.created_by !== actorId) throw new LeagueStoreError(403, "Only the match organiser can amend this result.");
  }
  await client.query("SELECT set_config('breakdish.allow_admin_amendment', 'on', true)");
  await client.query("SELECT set_config('breakdish.audit_action', 'admin_amendment', true)");
  return true;
}

function toMatch(row) {
  return {
    id: row.match_id,
    type: row.match_type,
    status: row.status,
    isOfficial: row.is_official,
    leagueId: row.league_id,
    seasonId: row.season_id,
    divisionId: row.division_id,
    homeTeamId: row.home_team_id,
    awayTeamId: row.away_team_id,
    homeTeam: row.home_team_name ?? null,
    awayTeam: row.away_team_name ?? null,
    leagueName: row.league_name ?? null,
    tournamentEventId: row.tournament_event_id,
    tournamentName: row.tournament_name ?? null,
    scheduledAt: row.scheduled_at,
    venue: row.venue,
    framesTotal: Number(row.frames_total || 0),
    framesCompleted: Number(row.frames_completed || 0),
    framesRemaining: Number(row.frames_remaining || 0),
    homeScore: Number(row.home_score || 0),
    awayScore: Number(row.away_score || 0),
    winnerSide: row.winner_side === null ? null : Number(row.winner_side),
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at
  };
}

async function matchWithDetails(client, matchId) {
  const matchResult = await client.query(
    `SELECT sb.*, l.name AS league_name, ht.name AS home_team_name,
       at.name AS away_team_name, te.name AS tournament_name
     FROM match_scoreboard sb
     LEFT JOIN leagues l ON l.id = sb.league_id
     LEFT JOIN teams ht ON ht.id = sb.home_team_id
     LEFT JOIN teams at ON at.id = sb.away_team_id
     LEFT JOIN tournament_events te ON te.id = sb.tournament_event_id
     WHERE sb.match_id = $1`,
    [matchId]
  );
  if (!matchResult.rows[0]) return null;
  const match = toMatch(matchResult.rows[0]);
  const frameResult = await client.query(
    `SELECT f.match_id, f.frame_number, sf.frame_type, f.status, f.outcome_type,
       f.winner_side, f.forfeiting_side, f.completed_by, f.completed_at,
       coalesce(jsonb_agg(jsonb_build_object(
         'side', fp.side, 'slot', fp.slot_number, 'userId', fp.user_id,
         'name', coalesce(pp.display_name, u.name), 'isBye', fp.is_bye
       ) ORDER BY fp.side, fp.slot_number) FILTER (WHERE fp.match_id IS NOT NULL), '[]'::jsonb) AS players,
       jsonb_agg(DISTINCT jsonb_build_object('type', e.event_type, 'userId', e.user_id))
         FILTER (WHERE e.id IS NOT NULL) AS frame_events
     FROM match_frames f
     JOIN match_format_snapshots s ON s.match_id = f.match_id AND s.id = f.snapshot_id
     JOIN match_format_snapshot_frames sf ON sf.snapshot_id = s.id AND sf.frame_number = f.frame_number
     LEFT JOIN match_frame_players fp ON fp.match_id = f.match_id AND fp.frame_number = f.frame_number
     LEFT JOIN "user" u ON u.id = fp.user_id
     LEFT JOIN player_profiles pp ON pp.user_id = fp.user_id
     LEFT JOIN match_frame_events e ON e.match_id = f.match_id AND e.frame_number = f.frame_number
     WHERE f.match_id = $1
     GROUP BY f.match_id, f.frame_number, sf.frame_type, f.status, f.outcome_type,
       f.winner_side, f.forfeiting_side, f.completed_by, f.completed_at
     ORDER BY f.frame_number`,
    [matchId]
  );
  const confirmationResult = await client.query(
    `SELECT DISTINCT ON (side) side, action, confirmed_by, occurred_at
     FROM match_confirmations WHERE match_id = $1
     ORDER BY side, occurred_at DESC, id DESC`,
    [matchId]
  );
  const disputeResult = await client.query(
    `SELECT d.id, d.frame_number, d.reason, d.raised_by, d.created_at,
       r.resolved_by, r.resolution, r.created_at AS resolved_at
     FROM match_disputes d LEFT JOIN match_dispute_resolutions r ON r.dispute_id = d.id
     WHERE d.match_id = $1 ORDER BY d.created_at`,
    [matchId]
  );
  const frames = frameResult.rows.map((frame) => ({
    number: Number(frame.frame_number),
    type: frame.frame_type,
    status: frame.status,
    outcome: frame.outcome_type,
    winnerSide: frame.winner_side === null ? null : Number(frame.winner_side),
    forfeitingSide: frame.forfeiting_side === null ? null : Number(frame.forfeiting_side),
    completedAt: frame.completed_at,
    players: frame.players,
    event: frame.frame_events?.[0] ?? null
  }));
  return {
    match,
    frames,
    confirmations: confirmationResult.rows.map((row) => ({
      side: Number(row.side), action: row.action, userId: row.confirmed_by, occurredAt: row.occurred_at
    })),
    disputes: disputeResult.rows.map((row) => ({
      id: row.id, frameNumber: row.frame_number === null ? null : Number(row.frame_number),
      reason: row.reason, raisedBy: row.raised_by, createdAt: row.created_at,
      resolvedBy: row.resolved_by ?? null, resolution: row.resolution ?? null, resolvedAt: row.resolved_at ?? null
    }))
  };
}

function validateFrames(frames) {
  if (!Array.isArray(frames) || frames.length < 1 || frames.length > 99) {
    invalid("Add between 1 and 99 ordered Singles or Doubles frames.");
  }
  return frames.map((frame, index) => {
    const type = frame?.type ?? frame?.frameType;
    if (!FRAME_TYPES.has(type)) invalid(`Frame ${index + 1} must be Singles or Doubles.`);
    return { frameNumber: index + 1, type };
  });
}

export function createMatchStore(database) {
  return {
    async listMatches(filters = {}, viewerId = null) {
      return withTransaction(database, null, async (client) => {
        const values = [];
        const clauses = [];
        for (const [key, value, column] of [
          ["leagueId", filters.leagueId, "sb.league_id"],
          ["seasonId", filters.seasonId, "sb.season_id"],
          ["tournamentEventId", filters.tournamentEventId, "sb.tournament_event_id"]
        ]) {
          if (value !== undefined) {
            values.push(cleanUuid(value, key));
            clauses.push(`${column} = $${values.length}`);
          }
        }
        if (viewerId) {
          values.push(viewerId);
          clauses.push(`(sb.match_type NOT IN ('practice', 'money_match') OR sb.created_by = $${values.length} OR EXISTS (
            SELECT 1 FROM match_participants mp WHERE mp.match_id = sb.match_id AND mp.user_id = $${values.length}
          ))`);
        } else {
          clauses.push("sb.match_type NOT IN ('practice', 'money_match')");
        }
        if (filters.type !== undefined) {
          if (!MATCH_TYPES.has(filters.type)) invalid("Choose a supported match category.");
          values.push(filters.type); clauses.push(`sb.match_type = $${values.length}`);
        }
        if (filters.status !== undefined) {
          if (!MATCH_STATUSES.has(filters.status)) invalid("Choose a supported match status.");
          values.push(filters.status); clauses.push(`sb.status = $${values.length}`);
        }
        const result = await client.query(
          `SELECT sb.*, l.name AS league_name, ht.name AS home_team_name,
             at.name AS away_team_name, te.name AS tournament_name
           FROM match_scoreboard sb
           LEFT JOIN leagues l ON l.id = sb.league_id
           LEFT JOIN teams ht ON ht.id = sb.home_team_id
           LEFT JOIN teams at ON at.id = sb.away_team_id
           LEFT JOIN tournament_events te ON te.id = sb.tournament_event_id
           ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
           ORDER BY sb.scheduled_at NULLS LAST, sb.created_at DESC LIMIT 100`,
          values
        );
        return result.rows.map(toMatch);
      });
    },

    async getMatch(matchId, viewerId = null) {
      return withTransaction(database, null, async (client) => {
        const match = await requireMatch(client, cleanUuid(matchId, "match ID"));
        if (["practice", "money_match"].includes(match.match_type)) {
          if (!viewerId) throw new LeagueStoreError(401, "Sign in to view this private match.");
          const permitted = await client.query(
            `SELECT 1 FROM matches m WHERE m.id = $1 AND (m.created_by = $2 OR EXISTS (
               SELECT 1 FROM match_participants mp WHERE mp.match_id = m.id AND mp.user_id = $2
             ))`,
            [match.id, viewerId]
          );
          if (!permitted.rows[0]) throw new LeagueStoreError(403, "Only a match participant can view this private match.");
        }
        return matchWithDetails(client, match.id);
      });
    },

    async createTournamentEvent(actorId, details) {
      const name = typeof details.name === "string" ? details.name.trim() : "";
      if (!name || name.length > 160) invalid("Enter a tournament or flyer name up to 160 characters.");
      return withTransaction(database, actorId, async (client) => {
        const created = await client.query(
          `INSERT INTO tournament_events(name, description, venue, starts_at, created_by)
           VALUES($1, $2, $3, $4, $5) RETURNING id, name, description, venue, starts_at, status`,
          [name, details.description ?? null, details.venue ?? null, details.startsAt ?? null, actorId]
        );
        return created.rows[0];
      });
    },

    async listTournamentEvents() {
      return withTransaction(database, null, async (client) => {
        const result = await client.query(
          `SELECT id, name, description, venue, starts_at, status
           FROM tournament_events WHERE status <> 'cancelled' ORDER BY starts_at NULLS LAST, created_at DESC LIMIT 100`
        );
        return result.rows;
      });
    },

    async getLeagueFormat(leagueId) {
      return withTransaction(database, null, async (client) => {
        const result = await client.query(
          `SELECT t.id, t.league_id, t.version, t.name, t.created_at
           FROM league_match_format_defaults d
           JOIN league_match_format_templates t ON t.id = d.template_id
           WHERE d.league_id = $1`,
          [cleanUuid(leagueId, "league ID")]
        );
        if (!result.rows[0]) return null;
        const frameRows = await client.query(
          `SELECT frame_number, frame_type FROM league_match_format_template_frames
           WHERE template_id = $1 ORDER BY frame_number`,
          [result.rows[0].id]
        );
        return {
          id: result.rows[0].id, leagueId: result.rows[0].league_id,
          version: Number(result.rows[0].version), name: result.rows[0].name,
          frames: frameRows.rows.map((frame) => ({ number: Number(frame.frame_number), type: frame.frame_type }))
        };
      });
    },

    async setLeagueFormat(leagueId, actorId, details) {
      const name = typeof details.name === "string" && details.name.trim() ? details.name.trim().slice(0, 120) : "Standard league format";
      const frames = validateFrames(details.frames);
      return withTransaction(database, actorId, async (client) => {
        await requireLeagueManager(client, leagueId, actorId);
        const league = await client.query("SELECT id FROM leagues WHERE id = $1 FOR UPDATE", [leagueId]);
        if (!league.rows[0]) throw new LeagueStoreError(404, "This league could not be found.");
        const latest = await client.query("SELECT coalesce(max(version), 0)::integer AS version FROM league_match_format_templates WHERE league_id = $1", [leagueId]);
        const version = Number(latest.rows[0].version) + 1;
        const inserted = await client.query(
          `INSERT INTO league_match_format_templates(league_id, version, name, created_by)
           VALUES($1, $2, $3, $4) RETURNING id`, [leagueId, version, name, actorId]
        );
        const templateId = inserted.rows[0].id;
        for (const frame of frames) {
          await client.query(
            "INSERT INTO league_match_format_template_frames(template_id, frame_number, frame_type) VALUES($1, $2, $3)",
            [templateId, frame.frameNumber, frame.type]
          );
        }
        await client.query(
          `INSERT INTO league_match_format_defaults(league_id, template_id, changed_by)
           VALUES($1, $2, $3)
           ON CONFLICT(league_id) DO UPDATE SET template_id = EXCLUDED.template_id,
             changed_by = EXCLUDED.changed_by, changed_at = now()`, [leagueId, templateId, actorId]
        );
        let updatedMatches = 0;
        if (details.applyToFuture === true) {
          const fixtures = await client.query(
            `SELECT m.id, s.id AS snapshot_id FROM matches m
             JOIN match_format_snapshots s ON s.match_id = m.id
             WHERE m.league_id = $1 AND m.status = 'scheduled' AND m.started_at IS NULL
               AND m.scheduled_at > now()
               AND NOT EXISTS (SELECT 1 FROM match_frame_players fp WHERE fp.match_id = m.id)
             FOR UPDATE OF m, s`, [leagueId]
          );
          for (const fixture of fixtures.rows) {
            await replaceSnapshotFrames(client, fixture.id, fixture.snapshot_id, templateId, version, name, actorId);
            updatedMatches++;
          }
        }
        return { id: templateId, leagueId, version, name, frames: frames.map((frame) => ({ number: frame.frameNumber, type: frame.type })), updatedMatches };
      });
    },

    async applyLeagueFormatToMatch(matchId, actorId) {
      return withTransaction(database, actorId, async (client) => {
        const match = await requireMatch(client, cleanUuid(matchId, "match ID"), true);
        if (!match.league_id || match.status !== "scheduled" || !match.scheduled_at || new Date(match.scheduled_at) <= new Date()) {
          throw new LeagueStoreError(409, "Only a future, unstarted league fixture can receive the current default format.");
        }
        await requireLeagueManager(client, match.league_id, actorId);
        const current = await client.query(
          `SELECT t.id, t.version, t.name FROM league_match_format_defaults d
           JOIN league_match_format_templates t ON t.id = d.template_id WHERE d.league_id = $1`, [match.league_id]
        );
        if (!current.rows[0]) throw new LeagueStoreError(409, "This league has not configured a match format yet.");
        const snapshot = await client.query("SELECT id FROM match_format_snapshots WHERE match_id = $1", [match.id]);
        if (!snapshot.rows[0]) throw new LeagueStoreError(409, "This fixture has no match-format snapshot.");
        await replaceSnapshotFrames(client, match.id, snapshot.rows[0].id, current.rows[0].id, current.rows[0].version, current.rows[0].name, actorId);
        return matchWithDetails(client, match.id);
      });
    },

    async createMatch(actorId, details) {
      const type = details.type;
      if (!MATCH_TYPES.has(type)) invalid("Choose a supported match category.");
      const scheduledAt = details.scheduledAt === undefined || details.scheduledAt === null || details.scheduledAt === ""
        ? null : new Date(details.scheduledAt);
      if (scheduledAt && Number.isNaN(scheduledAt.getTime())) invalid("Enter a valid fixture date and time.");
      const venue = details.venue == null ? null : String(details.venue).trim().slice(0, 160) || null;

      return withTransaction(database, actorId, async (client) => {
        let leagueId = details.leagueId ? cleanUuid(details.leagueId, "league ID") : null;
        let seasonId = details.seasonId ? cleanUuid(details.seasonId, "season ID") : null;
        let divisionId = details.divisionId ? cleanUuid(details.divisionId, "division ID") : null;
        let homeTeamId = details.homeTeamId ? cleanUuid(details.homeTeamId, "home team ID") : null;
        let awayTeamId = details.awayTeamId ? cleanUuid(details.awayTeamId, "away team ID") : null;
        let tournamentEventId = details.tournamentEventId ? cleanUuid(details.tournamentEventId, "tournament event ID") : null;
        let template = null;
        let frameList;

        if (["team_league", "singles_league", "doubles_league"].includes(type)) {
          if (!leagueId || !seasonId) invalid("Select the league and season for this league match.");
          await requireLeagueManager(client, leagueId, actorId);
          const season = await client.query("SELECT status FROM seasons WHERE id = $1 AND league_id = $2 FOR UPDATE", [seasonId, leagueId]);
          if (!season.rows[0]) throw new LeagueStoreError(404, "This season could not be found in the selected league.");
          if (season.rows[0].status === "completed") throw new LeagueStoreError(409, "Completed seasons cannot receive new matches.");
          if (type === "team_league") {
            if (!homeTeamId || !awayTeamId || homeTeamId === awayTeamId) invalid("Choose different home and away teams.");
            const teams = await client.query("SELECT id FROM teams WHERE league_id = $1 AND season_id = $2 AND id = ANY($3::uuid[]) AND status = 'active' FOR UPDATE", [leagueId, seasonId, [homeTeamId, awayTeamId]]);
            if (teams.rowCount !== 2) throw new LeagueStoreError(404, "Both selected teams must be active in this league season.");
          } else if (homeTeamId || awayTeamId) {
            invalid("Singles and Doubles League matches do not use team sides.");
          }
          if (divisionId) {
            const division = await client.query("SELECT id FROM divisions WHERE id = $1 AND season_id = $2", [divisionId, seasonId]);
            if (!division.rows[0]) invalid("Choose a division from the selected season.");
          }
          const format = await client.query(
            `SELECT t.id, t.version, t.name FROM league_match_format_defaults d
             JOIN league_match_format_templates t ON t.id = d.template_id WHERE d.league_id = $1`, [leagueId]
          );
          if (!format.rows[0]) throw new LeagueStoreError(409, "Configure a league match format before creating a fixture.");
          template = format.rows[0];
          const rows = await client.query("SELECT frame_number, frame_type FROM league_match_format_template_frames WHERE template_id = $1 ORDER BY frame_number", [template.id]);
          frameList = rows.rows.map((row) => ({ frameNumber: Number(row.frame_number), type: row.frame_type }));
          if (!frameList.length) throw new LeagueStoreError(409, "The league match format does not contain any frames.");
        } else if (type === "tournament_flyer") {
          if (!tournamentEventId) invalid("Select a tournament or flyer event.");
          const event = await client.query("SELECT id, created_by FROM tournament_events WHERE id = $1 FOR UPDATE", [tournamentEventId]);
          if (!event.rows[0]) throw new LeagueStoreError(404, "This tournament or flyer could not be found.");
          if (event.rows[0].created_by !== actorId) throw new LeagueStoreError(403, "Only the tournament organiser can create matches for this event.");
          frameList = validateFrames(details.frames);
        } else {
          frameList = validateFrames(details.frames);
          if (type === "practice" || type === "money_match") {
            if (!Array.isArray(details.participants) || details.participants.length !== 2 || new Set(details.participants.map((p) => p.side)).size !== 2) {
              invalid("Record one registered player on each side before creating this match.");
            }
          }
          if (type === "money_match") {
            if (!details.moneyTerms || typeof details.moneyTerms !== "object") invalid("Money Match terms must be recorded when the match is created.");
            const participantIds = new Set(details.participants.map((p) => p.userId));
            if (!participantIds.has(actorId)) throw new LeagueStoreError(403, "A Money Match must be created by one of its players.");
          }
          if (leagueId || seasonId || divisionId || homeTeamId || awayTeamId) invalid("Standalone matches do not accept league or team links.");
        }

        const insert = await client.query(
          `INSERT INTO matches(match_type, league_id, season_id, division_id, home_team_id, away_team_id,
             tournament_event_id, scheduled_at, venue, created_by)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [type, leagueId, seasonId, divisionId, homeTeamId, awayTeamId, tournamentEventId, scheduledAt, venue, actorId]
        );
        const matchId = insert.rows[0].id;
        const snapshot = await client.query(
          `INSERT INTO match_format_snapshots(match_id, template_id, template_version, name, created_by)
           VALUES($1,$2,$3,$4,$5) RETURNING id`,
          [matchId, template?.id ?? null, template?.version ?? null, template?.name ?? String(details.formatName || "Agreed match format").slice(0, 120), actorId]
        );
        for (const frame of frameList) {
          await client.query(
            "INSERT INTO match_format_snapshot_frames(snapshot_id, frame_number, frame_type) VALUES($1,$2,$3)",
            [snapshot.rows[0].id, frame.frameNumber, frame.type]
          );
        }
        if (Array.isArray(details.participants)) {
          for (const participant of details.participants) {
            const userId = typeof participant.userId === "string" ? participant.userId.trim() : "";
            const side = Number(participant.side);
            if (!userId || ![1, 2].includes(side)) invalid("Each match participant needs an account and side.");
            let registrationId = null;
            if (type === "team_league") {
              const teamId = side === 1 ? homeTeamId : awayTeamId;
              const registration = await client.query(
                `SELECT id FROM team_registrations WHERE team_id = $1 AND league_id = $2 AND season_id = $3
                 AND user_id = $4 AND ended_at IS NULL FOR UPDATE`, [teamId, leagueId, seasonId, userId]
              );
              registrationId = registration.rows[0]?.id;
              if (!registrationId) throw new LeagueStoreError(409, "A team-match participant must be currently registered to that team.");
            } else if (["singles_league", "doubles_league"].includes(type)) {
              const member = await client.query("SELECT 1 FROM league_memberships WHERE league_id = $1 AND user_id = $2 AND status = 'active'", [leagueId, userId]);
              if (!member.rows[0]) throw new LeagueStoreError(409, "League-match participants must be active league members.");
            }
            await client.query(
              `INSERT INTO match_participants(match_id, user_id, side, team_registration_id, added_by)
               VALUES($1,$2,$3,$4,$5)`, [matchId, userId, side, registrationId, actorId]
            );
          }
        }
        if (type === "money_match") {
          const terms = details.moneyTerms;
          const playerA = details.participants.find((participant) => Number(participant.side) === 1)?.userId;
          const playerB = details.participants.find((participant) => Number(participant.side) === 2)?.userId;
          const wager = Number(terms.wagerAmount);
          if (!Number.isFinite(wager) || wager <= 0 || wager > 1000000) invalid("Enter a valid positive Money Match stake amount in pounds.");
          await client.query(
            `INSERT INTO money_match_terms(match_id, player_a_id, player_b_id, wager_amount,
               appointed_admin_id, format_snapshot_id, created_by)
             VALUES($1,$2,$3,$4,$5,$6,$7)`,
            [matchId, playerA, playerB, wager.toFixed(2), cleanAccountId(terms.adminUserId, "Match Admin account ID"), snapshot.rows[0].id, actorId]
          );
        }
        return matchWithDetails(client, matchId);
      });
    },

    async startMatch(matchId, actorId) {
      return withTransaction(database, actorId, async (client) => {
        const match = await requireMatch(client, cleanUuid(matchId, "match ID"), true);
        if (match.status !== "scheduled") throw new LeagueStoreError(409, "Only a scheduled match can be started.");
        if (match.match_type === "money_match") {
          const acknowledgements = await client.query(
            `SELECT count(DISTINCT acknowledgement_type) AS total FROM money_match_acknowledgements
             WHERE match_id = $1 AND acknowledgement_type IN ('player_a_terms','player_b_terms','admin_role','admin_stake_confirmed','player_a_winner_takes_wager','player_b_winner_takes_wager')`, [match.id]
          );
          if (Number(acknowledgements.rows[0].total) < 6) throw new LeagueStoreError(409, "Both players and the Match Admin must accept the terms and manual stake confirmation before the match starts.");
        }
        await client.query("SELECT set_config('breakdish.audit_action', 'match_started', true)");
        await client.query("UPDATE matches SET status = 'in_progress', updated_at = now() WHERE id = $1", [match.id]);
        return matchWithDetails(client, match.id);
      });
    },

    async eligiblePlayers(matchId, side, actorId) {
      if (![1, 2].includes(Number(side))) invalid("Choose a valid match side.");
      return withTransaction(database, actorId, async (client) => {
        const match = await requireMatch(client, cleanUuid(matchId, "match ID"));
        const sideNumber = Number(side);
        if (match.match_type === "team_league") {
          const teamId = sideNumber === 1 ? match.home_team_id : match.away_team_id;
          const result = await client.query(
            `SELECT tr.user_id, tr.id AS team_registration_id, coalesce(pp.display_name, u.name) AS display_name
             FROM team_registrations tr JOIN "user" u ON u.id = tr.user_id
             LEFT JOIN player_profiles pp ON pp.user_id = tr.user_id
             WHERE tr.team_id = $1 AND tr.league_id = $2 AND tr.season_id = $3 AND tr.ended_at IS NULL
               AND EXISTS (SELECT 1 FROM league_memberships lm WHERE lm.league_id = tr.league_id AND lm.user_id = tr.user_id AND lm.status = 'active')
             ORDER BY display_name, tr.user_id`, [teamId, match.league_id, match.season_id]
          );
          return result.rows.map((row) => ({ userId: row.user_id, displayName: row.display_name, registrationId: row.team_registration_id }));
        }
        if (["singles_league", "doubles_league"].includes(match.match_type)) {
          const result = await client.query(
            `SELECT u.id AS user_id, coalesce(pp.display_name, u.name) AS display_name
             FROM league_memberships lm JOIN "user" u ON u.id = lm.user_id
             LEFT JOIN player_profiles pp ON pp.user_id = u.id
             WHERE lm.league_id = $1 AND lm.status = 'active' ORDER BY display_name`, [match.league_id]
          );
          return result.rows.map((row) => ({ userId: row.user_id, displayName: row.display_name, registrationId: null }));
        }
        const result = await client.query(
          `SELECT mp.user_id, coalesce(pp.display_name, u.name) AS display_name
           FROM match_participants mp JOIN "user" u ON u.id = mp.user_id
           LEFT JOIN player_profiles pp ON pp.user_id = mp.user_id
           WHERE mp.match_id = $1 AND mp.side = $2 ORDER BY display_name`, [match.id, sideNumber]
        );
        return result.rows.map((row) => ({ userId: row.user_id, displayName: row.display_name, registrationId: null }));
      });
    },

    async setFramePlayers(matchId, frameNumber, actorId, details) {
      const side = Number(details.side);
      if (![1, 2].includes(side)) invalid("Choose a valid side.");
      return withTransaction(database, actorId, async (client) => {
        const match = await requireMatch(client, cleanUuid(matchId, "match ID"), true);
        const amendment = await requireCompletedMatchAmendment(client, match, actorId);
        if (match.status !== "in_progress" && !amendment) {
          throw new LeagueStoreError(409, "Player selections can be changed only while the scoreboard is active.");
        }
        const frame = await client.query(
          `SELECT f.frame_number, f.status, sf.frame_type FROM match_frames f
           JOIN match_format_snapshot_frames sf ON sf.snapshot_id = f.snapshot_id AND sf.frame_number = f.frame_number
           WHERE f.match_id = $1 AND f.frame_number = $2 FOR UPDATE OF f`, [match.id, frameNumber]
        );
        if (!frame.rows[0]) throw new LeagueStoreError(404, "This frame could not be found.");
        if (frame.rows[0].status === "completed" && !amendment) {
          throw new LeagueStoreError(409, "Completed frame selections can only be changed through an authorised amendment.");
        }
        const slotCount = frame.rows[0].frame_type === "singles" ? 1 : 2;
        const isBye = details.bye === true;
        const players = Array.isArray(details.players) ? details.players : [];
        if (isBye && players.length) invalid("Choose players or Bye for a side, not both.");
        if (players.length > slotCount || (isBye && slotCount === 2 && details.partialBye)) {
          invalid("A doubles Bye uses both player slots; partial doubles Byes are not supported.");
        }
        if (new Set(players).size !== players.length) invalid("A player cannot occupy two slots in the same frame.");
        await client.query("SELECT set_config('breakdish.audit_action', $1, true)", [amendment ? "admin_amendment" : "player_selection_changed"]);
        await client.query("DELETE FROM match_frame_players WHERE match_id = $1 AND frame_number = $2 AND side = $3", [match.id, frameNumber, side]);
        if (isBye) {
          for (let slot = 1; slot <= slotCount; slot++) {
            await client.query(
              `INSERT INTO match_frame_players(match_id, frame_number, side, slot_number, user_id, is_bye, selected_by)
               VALUES($1,$2,$3,$4,NULL,true,$5)`, [match.id, frameNumber, side, slot, actorId]
            );
          }
        } else {
          for (let index = 0; index < players.length; index++) {
            const userId = typeof players[index] === "string" ? players[index] : "";
            if (!userId || userId.length > 128) invalid("Choose a valid registered player.");
            if (match.match_type === "team_league") {
              const teamId = side === 1 ? match.home_team_id : match.away_team_id;
              const registration = await client.query(
                `SELECT id FROM team_registrations WHERE user_id = $1 AND team_id = $2 AND league_id = $3 AND season_id = $4 AND ended_at IS NULL FOR UPDATE`,
                [userId, teamId, match.league_id, match.season_id]
              );
              if (!registration.rows[0]) throw new LeagueStoreError(409, "Choose only a player currently registered to this team.");
              await client.query(
                `INSERT INTO match_participants(match_id, user_id, side, team_registration_id, added_by)
                 VALUES($1,$2,$3,$4,$5) ON CONFLICT(match_id,user_id) DO NOTHING`,
                [match.id, userId, side, registration.rows[0].id, actorId]
              );
            } else if (!["singles_league", "doubles_league"].includes(match.match_type)) {
              const participant = await client.query("SELECT 1 FROM match_participants WHERE match_id = $1 AND user_id = $2 AND side = $3", [match.id, userId, side]);
              if (!participant.rows[0]) throw new LeagueStoreError(403, "Choose a player already recorded on this match side.");
            } else {
              const membership = await client.query("SELECT 1 FROM league_memberships WHERE league_id = $1 AND user_id = $2 AND status = 'active'", [match.league_id, userId]);
              if (!membership.rows[0]) throw new LeagueStoreError(409, "Only active league members can be selected for this fixture.");
              await client.query(
                `INSERT INTO match_participants(match_id, user_id, side, added_by) VALUES($1,$2,$3,$4)
                 ON CONFLICT(match_id,user_id) DO NOTHING`, [match.id, userId, side, actorId]
              );
            }
            await client.query(
              `INSERT INTO match_frame_players(match_id, frame_number, side, slot_number, user_id, is_bye, selected_by)
               VALUES($1,$2,$3,$4,$5,false,$6)`, [match.id, frameNumber, side, index + 1, userId, actorId]
            );
          }
        }
        return matchWithDetails(client, match.id);
      });
    },

    async completeFrame(matchId, frameNumber, actorId, details) {
      return withTransaction(database, actorId, async (client) => {
        const match = await requireMatch(client, cleanUuid(matchId, "match ID"), true);
        const amendment = await requireCompletedMatchAmendment(client, match, actorId);
        if (match.status === "disputed" && !amendment) throw new LeagueStoreError(409, "Resolve the active dispute before changing the scoreboard.");
        if (match.status !== "in_progress" && !amendment) throw new LeagueStoreError(409, "Start the match before entering a frame result.");
        const existing = await client.query(
          `SELECT f.*, sf.frame_type FROM match_frames f
           JOIN match_format_snapshot_frames sf ON sf.snapshot_id = f.snapshot_id AND sf.frame_number = f.frame_number
           WHERE f.match_id = $1 AND f.frame_number = $2 FOR UPDATE OF f`, [match.id, frameNumber]
        );
        if (!existing.rows[0]) throw new LeagueStoreError(404, "This frame could not be found.");
        const outcome = details.outcome === "bye" ? "bye" : details.outcome === "forfeit" ? "forfeit" : "played";
        if (details.dishEvent != null && details.dishEvent !== "" && !["dish", "counter_dish"].includes(details.dishEvent)) {
          invalid("Choose Dish, Counter Dish or neither.");
        }
        let winnerSide = Number(details.winnerSide);
        let forfeitingSide = null;
        if (outcome === "bye") {
          const slots = await client.query("SELECT side, bool_and(is_bye) AS all_bye FROM match_frame_players WHERE match_id = $1 AND frame_number = $2 GROUP BY side", [match.id, frameNumber]);
          const byeSide = slots.rows.find((row) => row.all_bye === true)?.side;
          if (![1, 2].includes(Number(byeSide))) throw new LeagueStoreError(400, "Mark one full side as Bye before recording a Bye win.");
          winnerSide = 3 - Number(byeSide);
          details = { ...details, dishEvent: null, dishPlayerId: null };
        } else if (outcome === "forfeit") {
          forfeitingSide = Number(details.forfeitingSide);
          if (![1, 2].includes(forfeitingSide)) invalid("Choose the side that forfeited.");
          winnerSide = 3 - forfeitingSide;
        } else if (![1, 2].includes(winnerSide)) {
          invalid("Choose the frame winner.");
        }
        if (match.status === "completed" && !amendment) throw new LeagueStoreError(403, "An administrator amendment is required to change a final result.");
        const action = amendment ? "admin_amendment" : existing.rows[0].status === "completed" ? "frame_result_changed" : outcome === "bye" ? "bye_entered" : "frame_result_entered";
        await client.query("SELECT set_config('breakdish.audit_action', $1, true)", [action]);
        await client.query(
          `UPDATE match_frames SET status = 'completed', outcome_type = $3, winner_side = $4,
             forfeiting_side = $5, completed_by = $6, completed_at = clock_timestamp(), updated_at = now()
           WHERE match_id = $1 AND frame_number = $2`,
          [match.id, frameNumber, outcome, winnerSide, forfeitingSide, actorId]
        );
        const eventType = outcome === "played" && ["dish", "counter_dish"].includes(details.dishEvent) ? details.dishEvent : null;
        if (eventType) {
          const userId = typeof details.dishPlayerId === "string" ? details.dishPlayerId : "";
          await client.query("SELECT set_config('breakdish.audit_action', 'frame_decoration_changed', true)");
          await client.query(
            `INSERT INTO match_frame_events(match_id, frame_number, user_id, event_type, recorded_by)
             VALUES($1,$2,$3,$4,$5)
             ON CONFLICT(match_id,frame_number) DO UPDATE SET user_id = EXCLUDED.user_id,
               event_type = EXCLUDED.event_type, recorded_by = EXCLUDED.recorded_by, recorded_at = now()`,
            [match.id, frameNumber, userId, eventType, actorId]
          );
        } else {
          await client.query("DELETE FROM match_frame_events WHERE match_id = $1 AND frame_number = $2", [match.id, frameNumber]);
        }
        return matchWithDetails(client, match.id);
      });
    },

    async setFrameEvent(matchId, frameNumber, actorId, details) {
      const eventType = details.type === null || details.type === "" ? null : details.type;
      if (eventType !== null && !["dish", "counter_dish"].includes(eventType)) invalid("Choose Dish, Counter Dish or neither.");
      return withTransaction(database, actorId, async (client) => {
        const match = await requireMatch(client, cleanUuid(matchId, "match ID"), true);
        const amendment = await requireCompletedMatchAmendment(client, match, actorId);
        if (match.status === "cancelled") throw new LeagueStoreError(409, "Cancelled matches cannot be changed.");
        if (match.status === "disputed" && !amendment) throw new LeagueStoreError(409, "Resolve the active dispute before changing frame events.");
        const frame = await client.query("SELECT status, outcome_type FROM match_frames WHERE match_id = $1 AND frame_number = $2 FOR UPDATE", [match.id, frameNumber]);
        if (!frame.rows[0]) throw new LeagueStoreError(404, "This frame could not be found.");
        if (frame.rows[0].status !== "completed" || frame.rows[0].outcome_type !== "played") {
          throw new LeagueStoreError(409, "Dish and Counter Dish are available only on a completed played frame.");
        }
        if (match.status === "completed" && !amendment) throw new LeagueStoreError(403, "An administrator amendment is required to change a final result.");
        await client.query("SELECT set_config('breakdish.audit_action', $1, true)", [amendment ? "admin_amendment" : "frame_decoration_changed"]);
        if (!eventType) {
          await client.query("DELETE FROM match_frame_events WHERE match_id = $1 AND frame_number = $2", [match.id, frameNumber]);
        } else {
          await client.query(
            `INSERT INTO match_frame_events(match_id, frame_number, user_id, event_type, recorded_by)
             VALUES($1,$2,$3,$4,$5)
             ON CONFLICT(match_id,frame_number) DO UPDATE SET user_id=EXCLUDED.user_id,
               event_type=EXCLUDED.event_type, recorded_by=EXCLUDED.recorded_by, recorded_at=now()`,
            [match.id, frameNumber, cleanText(details.userId, "dish player account ID"), eventType, actorId]
          );
        }
        return matchWithDetails(client, match.id);
      });
    },

    async confirmSide(matchId, actorId, side = null) {
      return withTransaction(database, actorId, async (client) => {
        const match = await requireMatch(client, cleanUuid(matchId, "match ID"), true);
        let sideNumber = Number(side);
        if (match.match_type === "team_league") {
          const roles = await client.query(
            `SELECT tm.team_id FROM team_memberships tm
             WHERE tm.user_id = $1 AND tm.status = 'active' AND tm.role = 'captain'
               AND tm.team_id = ANY($2::uuid[])
             UNION SELECT NULL::uuid WHERE EXISTS (
               SELECT 1 FROM league_memberships lm WHERE lm.league_id=$3 AND lm.user_id=$1
                 AND lm.status='active' AND lm.role IN ('owner','administrator')
             )`, [actorId, [match.home_team_id, match.away_team_id], match.league_id]
          );
          const captainSide = roles.rows.map((row) => row.team_id === match.home_team_id ? 1 : row.team_id === match.away_team_id ? 2 : null).filter(Boolean);
          if (captainSide.length === 1) sideNumber = captainSide[0];
          if (![1, 2].includes(sideNumber) || (captainSide.length === 1 && sideNumber !== captainSide[0])) {
            throw new LeagueStoreError(403, "Confirm for the team you captain, or select one side as a league administrator.");
          }
        } else {
          const participant = await client.query("SELECT side FROM match_participants WHERE match_id=$1 AND user_id=$2", [match.id, actorId]);
          if (!participant.rows[0]) throw new LeagueStoreError(403, "Only a recorded match participant can confirm this result.");
          sideNumber = Number(participant.rows[0].side);
        }
        await client.query("SELECT set_config('breakdish.audit_action', 'confirmation_confirmed', true)");
        await client.query("INSERT INTO match_confirmations(match_id, side, action, confirmed_by) VALUES($1,$2,'confirmed',$3)", [match.id, sideNumber, actorId]);
        return matchWithDetails(client, match.id);
      });
    },

    async retractConfirmation(matchId, actorId, side) {
      return withTransaction(database, actorId, async (client) => {
        const match = await requireMatch(client, cleanUuid(matchId, "match ID"), true);
        let sideNumber = Number(side);
        if (![1, 2].includes(sideNumber)) {
          const participant = await client.query("SELECT side FROM match_participants WHERE match_id=$1 AND user_id=$2", [match.id, actorId]);
          sideNumber = Number(participant.rows[0]?.side);
        }
        await client.query("SELECT set_config('breakdish.audit_action', 'confirmation_retracted', true)");
        await client.query("INSERT INTO match_confirmations(match_id, side, action, confirmed_by) VALUES($1,$2,'retracted',$3)", [match.id, sideNumber, actorId]);
        return matchWithDetails(client, match.id);
      });
    },

    async raiseDispute(matchId, actorId, details) {
      const reason = typeof details.reason === "string" ? details.reason.trim() : "";
      if (!reason || reason.length > 1000) invalid("Explain the result dispute in 1,000 characters or fewer.");
      const frameNumber = details.frameNumber == null || details.frameNumber === "" ? null : Number(details.frameNumber);
      return withTransaction(database, actorId, async (client) => {
        const match = await requireMatch(client, cleanUuid(matchId, "match ID"), true);
        await client.query("SELECT set_config('breakdish.audit_action', 'dispute_raised', true)");
        await client.query("INSERT INTO match_disputes(match_id, frame_number, raised_by, reason) VALUES($1,$2,$3,$4)", [match.id, frameNumber, actorId, reason]);
        return matchWithDetails(client, match.id);
      });
    },

    async resolveDispute(matchId, disputeId, actorId, resolution) {
      const text = typeof resolution === "string" ? resolution.trim() : "";
      if (!text || text.length > 1000) invalid("Enter a dispute resolution in 1,000 characters or fewer.");
      return withTransaction(database, actorId, async (client) => {
        const match = await requireMatch(client, cleanUuid(matchId, "match ID"), true);
        await requireCompletedMatchAmendment(client, match, actorId);
        if (match.status !== "disputed") throw new LeagueStoreError(409, "Only an active dispute can be resolved.");
        await client.query("SELECT set_config('breakdish.audit_action', 'dispute_resolved', true)");
        const resolved = await client.query("INSERT INTO match_dispute_resolutions(dispute_id, resolved_by, resolution) SELECT id,$2,$3 FROM match_disputes WHERE id=$1 AND match_id=$4 RETURNING id", [cleanUuid(disputeId, "dispute ID"), actorId, text, match.id]);
        if (!resolved.rows[0]) throw new LeagueStoreError(404, "This dispute could not be found.");
        return matchWithDetails(client, match.id);
      });
    },

    async finalizeMatch(matchId, actorId) {
      return withTransaction(database, actorId, async (client) => {
        const match = await requireMatch(client, cleanUuid(matchId, "match ID"), true);
        if (match.status !== "awaiting_confirmation") throw new LeagueStoreError(409, "All frames must be complete and the match must be awaiting confirmation.");
        await client.query("SELECT set_config('breakdish.audit_action', 'match_finalized', true)");
        await client.query("UPDATE matches SET status = 'completed', updated_at = now() WHERE id = $1", [match.id]);
        return matchWithDetails(client, match.id);
      });
    },

    async acknowledgeMoneyMatch(matchId, actorId, acknowledgementType) {
      const allowed = new Set([
        "player_a_terms", "player_b_terms", "admin_role", "admin_stake_confirmed",
        "player_a_winner_takes_wager", "player_b_winner_takes_wager",
        "player_a_result", "player_b_result", "admin_final_confirmation"
      ]);
      if (!allowed.has(acknowledgementType)) invalid("Choose a supported Money Match acknowledgement.");
      return withTransaction(database, actorId, async (client) => {
        const match = await requireMatch(client, cleanUuid(matchId, "match ID"), true);
        await client.query("SELECT set_config('breakdish.audit_action', 'money_terms_acknowledged', true)");
        await client.query(
          "INSERT INTO money_match_acknowledgements(match_id, acknowledgement_type, acknowledged_by) VALUES($1,$2,$3)",
          [match.id, acknowledgementType, actorId]
        );
        return matchWithDetails(client, match.id);
      });
    },

    async getAudit(matchId, actorId) {
      return withTransaction(database, actorId, async (client) => {
        const match = await requireMatch(client, cleanUuid(matchId, "match ID"));
        const authorized = await client.query(
          `SELECT 1 WHERE $2 = (SELECT created_by FROM matches WHERE id = $1)
           UNION SELECT 1 FROM match_participants WHERE match_id=$1 AND user_id=$2
           UNION SELECT 1 FROM league_memberships WHERE league_id=$3 AND user_id=$2 AND status='active' AND role IN ('owner','administrator')`,
          [match.id, actorId, match.league_id]
        );
        if (!authorized.rows[0]) throw new LeagueStoreError(403, "Only a match participant or competition manager can view its audit history.");
        const result = await client.query(
          `SELECT id, frame_number, actor_user_id, action_type, previous_value, new_value, occurred_at
           FROM match_audit_events WHERE match_id=$1 ORDER BY occurred_at, id`, [match.id]
        );
        return result.rows;
      });
    }
  };
}

function cleanText(value, label) {
  if (typeof value !== "string" || !value.trim() || value.length > 128) invalid(`Enter a valid ${label}.`);
  return value.trim();
}

async function replaceSnapshotFrames(client, matchId, snapshotId, templateId, templateVersion, name, actorId) {
  await client.query("SELECT set_config('breakdish.audit_action', 'format_snapshot_changed', true)");
  await client.query("UPDATE match_format_snapshots SET template_id=$2, template_version=$3, name=$4 WHERE match_id=$1", [matchId, templateId, templateVersion, name]);
  await client.query("DELETE FROM match_format_snapshot_frames WHERE snapshot_id=$1", [snapshotId]);
  const frames = await client.query("SELECT frame_number, frame_type FROM league_match_format_template_frames WHERE template_id=$1 ORDER BY frame_number", [templateId]);
  if (!frames.rows.length) throw new LeagueStoreError(409, "The league match format does not contain any frames.");
  for (const frame of frames.rows) {
    await client.query("INSERT INTO match_format_snapshot_frames(snapshot_id, frame_number, frame_type) VALUES($1,$2,$3)", [snapshotId, frame.frame_number, frame.frame_type]);
  }
}
