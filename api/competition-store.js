import { LeagueStoreError } from "./league-store.js";

async function withTransaction(database, work) {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original database or validation error.
    }
    if (error.constraint === "team_poststart_signing_limit") throw new LeagueStoreError(409, "This team has used all three post-start signing events for this season.");
    if (error.constraint === "team_registration_one_active_per_competition") throw new LeagueStoreError(409, "This player is already registered with another team in this league season.");
    if (error.constraint === "season_start_required_for_activation") throw new LeagueStoreError(409, "Set an official season start date before activating the season.");
    if (error.constraint === "season_start_required_for_signing") throw new LeagueStoreError(409, "Set the official season start date before registering a player.");
    if (error.constraint === "season_start_date_frozen") throw new LeagueStoreError(409, "The official start date cannot change after team registrations begin.");
    if (error.code === "23505") throw new LeagueStoreError(409, "That name is already in use for this competition.");
    if (error.code === "23514") throw new LeagueStoreError(409, "That change conflicts with the current season or membership rules.");
    throw error;
  } finally {
    client.release();
  }
}

async function requireLeagueManager(client, leagueId, userId) {
  const result = await client.query(
    `SELECT role FROM league_memberships
     WHERE league_id = $1 AND user_id = $2 AND status = 'active'
     FOR UPDATE`,
    [leagueId, userId]
  );
  if (!result.rows[0] || !["owner", "administrator"].includes(result.rows[0].role)) {
    throw new LeagueStoreError(403, "Only an active league owner or administrator can manage seasons, divisions and teams.");
  }
}

async function lockSeason(client, seasonId) {
  const result = await client.query(
    `SELECT id, league_id, name, status, starts_on, ends_on
     FROM seasons WHERE id = $1 FOR UPDATE`,
    [seasonId]
  );
  if (!result.rows[0]) throw new LeagueStoreError(404, "This season could not be found.");
  return result.rows[0];
}

async function lockTeam(client, teamId) {
  const identity = await client.query("SELECT season_id FROM teams WHERE id = $1", [teamId]);
  if (!identity.rows[0]) throw new LeagueStoreError(404, "This team could not be found.");
  await lockSeason(client, identity.rows[0].season_id);
  const result = await client.query(
    `SELECT t.id, t.league_id, t.season_id, t.division_id, t.name, t.home_venue,
       t.status AS team_status, s.status AS season_status
     FROM teams t JOIN seasons s ON s.id = t.season_id
     WHERE t.id = $1 FOR UPDATE OF t`,
    [teamId]
  );
  if (!result.rows[0]) throw new LeagueStoreError(404, "This team could not be found.");
  return result.rows[0];
}

async function requireEditableSeason(client, season) {
  if (season.status === "completed") throw new LeagueStoreError(409, "Completed seasons are read-only to preserve their history.");
}

async function requireRosterAccess(client, team, actorId, managerOnly = false) {
  const leagueMembership = await client.query(
    `SELECT role FROM league_memberships
     WHERE league_id = $1 AND user_id = $2 AND status = 'active' FOR UPDATE`,
    [team.league_id, actorId]
  );
  const role = leagueMembership.rows[0]?.role;
  if (!role) throw new LeagueStoreError(403, "An active league membership is required to manage a team roster.");
  if (["owner", "administrator"].includes(role)) return { manager: true };
  if (managerOnly) throw new LeagueStoreError(403, "Only an active league owner or administrator can assign a team captain.");
  const captain = await client.query(
    `SELECT id FROM team_memberships
     WHERE team_id = $1 AND user_id = $2 AND role = 'captain' AND status = 'active' FOR UPDATE`,
    [team.id, actorId]
  );
  if (!captain.rows[0]) throw new LeagueStoreError(403, "Only a league manager or this team's active captain can manage its roster.");
  return { manager: false };
}

async function requireTeamOpen(team) {
  if (team.team_status !== "active") throw new LeagueStoreError(409, "This team is inactive.");
  if (team.season_status === "completed") throw new LeagueStoreError(409, "Completed seasons are read-only to preserve their history.");
}

function toSeason(row) {
  return {
    id: row.id,
    leagueId: row.league_id,
    name: row.name,
    status: row.status,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toDivision(row) {
  return {
    id: row.id,
    seasonId: row.season_id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toTeam(row) {
  return {
    id: row.id,
    leagueId: row.league_id,
    seasonId: row.season_id,
    divisionId: row.division_id,
    name: row.name,
    homeVenue: row.home_venue,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toTeamMembership(row) {
  return {
    id: row.id,
    teamId: row.team_id,
    userId: row.user_id,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function createCompetitionStore(database) {
  return {
    async getCompetition(leagueId, viewerId = null) {
      return withTransaction(database, async (client) => {
        const leagueResult = await client.query(
          `SELECT l.id, l.name, l.slug, l.description, l.location, l.status,
             m.role AS viewer_role, m.status AS viewer_membership_status
           FROM leagues l
           LEFT JOIN league_memberships m ON m.league_id = l.id AND m.user_id = $2
           WHERE l.id = $1`,
          [leagueId, viewerId]
        );
        const league = leagueResult.rows[0];
        if (!league) return null;
        const viewerRole = league.viewer_membership_status === "active" ? league.viewer_role : null;
        const isManager = ["owner", "administrator"].includes(viewerRole);
        if (!["open", "active"].includes(league.status) && !viewerRole) return null;

        const seasonResult = await client.query(
          `SELECT id, league_id, name, status, starts_on, ends_on, created_at, updated_at
           FROM seasons WHERE league_id = $1 ${isManager ? "" : "AND status <> 'draft'"}
           ORDER BY starts_on DESC NULLS LAST, created_at DESC`,
          [leagueId]
        );
        const seasons = seasonResult.rows.map((row) => ({ ...toSeason(row), divisions: [], teams: [] }));
        const seasonIds = seasons.map(({ id }) => id);
        if (!seasonIds.length) return { league: { id: league.id, name: league.name, slug: league.slug, description: league.description, location: league.location }, viewerRole, seasons };

        const divisionResult = await client.query(
          "SELECT id, season_id, name FROM divisions WHERE season_id = ANY($1::uuid[]) ORDER BY name ASC",
          [seasonIds]
        );
        const teamResult = await client.query(
          `SELECT t.id, t.league_id, t.season_id, t.division_id, t.name, t.home_venue, t.status,
             coalesce(count(tm.id) FILTER (WHERE tm.status = 'active'), 0)::integer AS member_count
           FROM teams t LEFT JOIN team_memberships tm ON tm.team_id = t.id
           WHERE t.season_id = ANY($1::uuid[])
           GROUP BY t.id ORDER BY t.name ASC`,
          [seasonIds]
        );
        const rosterResult = await client.query(
          `SELECT tm.team_id, tm.user_id, tm.role, tm.status,
             coalesce(p.display_name, u.name) AS display_name
           FROM team_memberships tm
           JOIN "user" u ON u.id = tm.user_id
           LEFT JOIN player_profiles p ON p.user_id = tm.user_id
           WHERE tm.team_id IN (SELECT id FROM teams WHERE season_id = ANY($1::uuid[])) AND tm.status = 'active'
           ORDER BY CASE tm.role WHEN 'captain' THEN 0 ELSE 1 END, display_name ASC`,
          [seasonIds]
        );
        const divisionsBySeason = new Map(seasons.map((season) => [season.id, season.divisions]));
        divisionResult.rows.forEach((division) => divisionsBySeason.get(division.season_id)?.push({
          id: division.id, seasonId: division.season_id, name: division.name, teams: []
        }));

        const membersByTeam = new Map();
        rosterResult.rows.forEach((member) => {
          if (!membersByTeam.has(member.team_id)) membersByTeam.set(member.team_id, []);
          membersByTeam.get(member.team_id).push({
            userId: member.user_id,
            displayName: member.display_name || "Player",
            role: member.role
          });
        });
        const seasonById = new Map(seasons.map((season) => [season.id, season]));
        teamResult.rows.forEach((team) => {
          const members = membersByTeam.get(team.id) || [];
          const teamViewerRole = viewerId
            ? rosterResult.rows.find((member) => member.team_id === team.id && member.user_id === viewerId)?.role || null
            : null;
          const canManageRoster = isManager || teamViewerRole === "captain";
          const mappedTeam = {
            id: team.id,
            leagueId: team.league_id,
            seasonId: team.season_id,
            divisionId: team.division_id,
            name: team.name,
            homeVenue: team.home_venue,
            status: team.status,
            memberCount: team.member_count,
            viewerRole: teamViewerRole,
            canManageRoster,
            members: members.map(({ userId, ...member }) => canManageRoster && userId ? { userId, ...member } : member)
          };
          const season = seasonById.get(team.season_id);
          if (team.division_id) {
            const division = season?.divisions.find(({ id }) => id === team.division_id);
            division?.teams.push(mappedTeam);
          } else {
            season?.teams.push(mappedTeam);
          }
        });
        return {
          league: { id: league.id, name: league.name, slug: league.slug, description: league.description, location: league.location },
          viewerRole,
          seasons
        };
      });
    },

    async createSeason(leagueId, actorId, details) {
      return withTransaction(database, async (client) => {
        await requireLeagueManager(client, leagueId, actorId);
        const result = await client.query(
          `INSERT INTO seasons (league_id, name, starts_on, ends_on, created_by)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, league_id, name, status, starts_on, ends_on, created_at, updated_at`,
          [leagueId, details.name, details.startsOn, details.endsOn, actorId]
        );
        return toSeason(result.rows[0]);
      });
    },

    async updateSeason(seasonId, actorId, details) {
      return withTransaction(database, async (client) => {
        const season = await lockSeason(client, seasonId);
        await requireLeagueManager(client, season.league_id, actorId);
        const hasStructureChange = details.name !== undefined || details.startsOn !== undefined || details.endsOn !== undefined;
        if (hasStructureChange && season.status !== "draft") {
          throw new LeagueStoreError(409, "Season details can only be changed while the season is in draft.");
        }
        const result = await client.query(
          `UPDATE seasons SET
             name = coalesce($2, name),
             starts_on = CASE WHEN $3::boolean THEN $4::date ELSE starts_on END,
             ends_on = CASE WHEN $5::boolean THEN $6::date ELSE ends_on END,
             status = coalesce($7, status), status_changed_by = CASE WHEN $7::text IS NULL THEN status_changed_by ELSE $8 END,
             updated_at = now()
           WHERE id = $1
           RETURNING id, league_id, name, status, starts_on, ends_on, created_at, updated_at`,
          [seasonId, details.name ?? null, details.startsOn !== undefined, details.startsOn ?? null,
            details.endsOn !== undefined, details.endsOn ?? null, details.status ?? null, actorId]
        );
        return toSeason(result.rows[0]);
      });
    },

    async createDivision(seasonId, actorId, name) {
      return withTransaction(database, async (client) => {
        const season = await lockSeason(client, seasonId);
        await requireLeagueManager(client, season.league_id, actorId);
        if (season.status !== "draft") throw new LeagueStoreError(409, "Divisions can only be changed while the season is in draft.");
        const result = await client.query(
          `INSERT INTO divisions (season_id, name, created_by) VALUES ($1, $2, $3)
           RETURNING id, season_id, name, created_at, updated_at`,
          [seasonId, name, actorId]
        );
        return toDivision(result.rows[0]);
      });
    },

    async updateDivision(divisionId, actorId, name) {
      return withTransaction(database, async (client) => {
        const result = await client.query(
          `SELECT d.id, d.season_id, s.league_id, s.status
           FROM divisions d JOIN seasons s ON s.id = d.season_id
           WHERE d.id = $1 FOR UPDATE OF d, s`,
          [divisionId]
        );
        const division = result.rows[0];
        if (!division) throw new LeagueStoreError(404, "This division could not be found.");
        await requireLeagueManager(client, division.league_id, actorId);
        if (division.status !== "draft") throw new LeagueStoreError(409, "Divisions can only be changed while the season is in draft.");
        const updated = await client.query(
          "UPDATE divisions SET name = $2, updated_at = now() WHERE id = $1 RETURNING id, season_id, name, created_at, updated_at",
          [divisionId, name]
        );
        return toDivision(updated.rows[0]);
      });
    },

    async createTeam(seasonId, actorId, details) {
      return withTransaction(database, async (client) => {
        const season = await lockSeason(client, seasonId);
        await requireLeagueManager(client, season.league_id, actorId);
        await requireEditableSeason(client, season);
        if (details.divisionId) {
          const division = await client.query("SELECT id FROM divisions WHERE id = $1 AND season_id = $2", [details.divisionId, seasonId]);
          if (!division.rows[0]) throw new LeagueStoreError(400, "Choose a division within this season.");
        }
        const result = await client.query(
          `INSERT INTO teams (league_id, season_id, division_id, name, home_venue, created_by)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, league_id, season_id, division_id, name, home_venue, status, created_at, updated_at`,
          [season.league_id, seasonId, details.divisionId, details.name, details.homeVenue, actorId]
        );
        return toTeam(result.rows[0]);
      });
    },

    async updateTeam(teamId, actorId, details) {
      return withTransaction(database, async (client) => {
        const team = await lockTeam(client, teamId);
        await requireLeagueManager(client, team.league_id, actorId);
        if (team.season_status === "completed") throw new LeagueStoreError(409, "Completed seasons are read-only to preserve their history.");
        if ((details.name !== undefined || details.divisionId !== undefined) && team.season_status !== "draft") {
          throw new LeagueStoreError(409, "Team names and divisions can only be changed while the season is in draft.");
        }
        if (details.divisionId) {
          const division = await client.query("SELECT id FROM divisions WHERE id = $1 AND season_id = $2", [details.divisionId, team.season_id]);
          if (!division.rows[0]) throw new LeagueStoreError(400, "Choose a division within this season.");
        }
        const result = await client.query(
          `UPDATE teams SET
             name = coalesce($2, name),
             home_venue = CASE WHEN $3::boolean THEN $4::varchar ELSE home_venue END,
             division_id = CASE WHEN $5::boolean THEN $6::uuid ELSE division_id END,
             status = coalesce($7, status), updated_at = now()
           WHERE id = $1
           RETURNING id, league_id, season_id, division_id, name, home_venue, status, created_at, updated_at`,
          [teamId, details.name ?? null, details.homeVenue !== undefined, details.homeVenue ?? null,
            details.divisionId !== undefined, details.divisionId ?? null, details.status ?? null]
        );
        return toTeam(result.rows[0]);
      });
    },

    async eligiblePlayers(teamId, actorId) {
      return withTransaction(database, async (client) => {
        const team = await lockTeam(client, teamId);
        await requireTeamOpen(team);
        await requireRosterAccess(client, team, actorId);
        const result = await client.query(
          `SELECT lm.user_id AS id, coalesce(p.display_name, u.name) AS display_name,
             tm.role AS team_role, tm.status AS team_status, active.team_id AS registered_team_id,
             active_team.name AS registered_team_name
           FROM league_memberships lm
           JOIN "user" u ON u.id = lm.user_id
           LEFT JOIN player_profiles p ON p.user_id = lm.user_id
           LEFT JOIN team_memberships tm ON tm.team_id = $2 AND tm.user_id = lm.user_id
           LEFT JOIN team_registrations active ON active.league_id=lm.league_id AND active.season_id=$3
             AND active.user_id=lm.user_id AND active.ended_at IS NULL
           LEFT JOIN teams active_team ON active_team.id=active.team_id
           WHERE lm.league_id = $1 AND lm.status = 'active'
           ORDER BY display_name ASC`,
          [team.league_id, teamId, team.season_id]
        );
        return result.rows.map((row) => ({
          id: row.id,
          displayName: row.display_name || "Player",
          teamRole: row.team_status === "active" ? row.team_role : null,
          onTeam: row.team_status === "active",
          registeredTeamId: row.registered_team_id || null,
          registeredTeamName: row.registered_team_name || null
        }));
      });
    },

    async addTeamMember(teamId, actorId, userId, reason = null) {
      return withTransaction(database, async (client) => {
        const team = await lockTeam(client, teamId);
        await requireRosterAccess(client, team, actorId);
        await requireTeamOpen(team);
        const eligible = await client.query(
          `SELECT status FROM league_memberships WHERE league_id = $1 AND user_id = $2 FOR UPDATE`,
          [team.league_id, userId]
        );
        if (eligible.rows[0]?.status !== "active") throw new LeagueStoreError(409, "Only active members of this league can join its teams.");
        const active = await client.query(
          `SELECT id, team_id FROM team_registrations WHERE league_id=$1 AND season_id=$2 AND user_id=$3 AND ended_at IS NULL FOR UPDATE`,
          [team.league_id, team.season_id, userId]
        );
        if (active.rows[0]?.team_id === teamId) {
          const existing = await client.query("SELECT id,team_id,user_id,role,status,created_at,updated_at FROM team_memberships WHERE team_id=$1 AND user_id=$2", [teamId, userId]);
          return { membership: toTeamMembership(existing.rows[0]), repeated: true };
        }
        if (active.rows[0]) throw new LeagueStoreError(409, "This player is registered with another team. A league owner or administrator must transfer them.");
        const registration = await client.query(
          `INSERT INTO team_registrations (league_id,season_id,team_id,user_id,authorized_by,reason)
           VALUES ($1,$2,$3,$4,$5,$6)
           RETURNING id,league_id,season_id,team_id,user_id,started_at,signing_type,authorized_by,reason`,
          [team.league_id, team.season_id, teamId, userId, actorId, reason]
        );
        const existing = await client.query(
          `SELECT id, team_id, user_id, role, status, created_at, updated_at
           FROM team_memberships WHERE team_id = $1 AND user_id = $2`,
          [teamId, userId]
        );
        return { membership: toTeamMembership(existing.rows[0]), repeated: false, signing: registration.rows[0] };
      });
    },

    async transferTeamMember(teamId, actorId, userId, reason = null) {
      return withTransaction(database, async (client) => {
        const team = await lockTeam(client, teamId);
        await requireRosterAccess(client, team, actorId, true);
        await requireTeamOpen(team);
        const eligible = await client.query("SELECT status FROM league_memberships WHERE league_id=$1 AND user_id=$2 FOR UPDATE", [team.league_id, userId]);
        if (eligible.rows[0]?.status !== "active") throw new LeagueStoreError(409, "Only active members of this league can join its teams.");
        const active = await client.query(
          `SELECT id,team_id FROM team_registrations WHERE league_id=$1 AND season_id=$2 AND user_id=$3 AND ended_at IS NULL FOR UPDATE`,
          [team.league_id, team.season_id, userId]
        );
        if (!active.rows[0]) throw new LeagueStoreError(409, "This player is not currently registered with a team in this league season.");
        if (active.rows[0].team_id === teamId) throw new LeagueStoreError(409, "This player is already registered with this team.");
        const fromTeamId = active.rows[0].team_id;
        await client.query(
          `UPDATE team_registrations SET ended_at=clock_timestamp(),end_event_type='transferred_out',ended_by=$2,end_reason=$3 WHERE id=$1`,
          [active.rows[0].id, actorId, reason]
        );
        const registration = await client.query(
          `INSERT INTO team_registrations (league_id,season_id,team_id,user_id,authorized_by,reason)
           VALUES ($1,$2,$3,$4,$5,$6)
           RETURNING id,league_id,season_id,team_id,user_id,started_at,signing_type,authorized_by,reason`,
          [team.league_id, team.season_id, teamId, userId, actorId, reason]
        );
        const membership = await client.query("SELECT id,team_id,user_id,role,status,created_at,updated_at FROM team_memberships WHERE team_id=$1 AND user_id=$2", [teamId, userId]);
        return { membership: toTeamMembership(membership.rows[0]), transfer: { fromTeamId, toTeamId: teamId }, signing: registration.rows[0] };
      });
    },

    async removeTeamMember(teamId, actorId, userId, reason = null) {
      return withTransaction(database, async (client) => {
        const team = await lockTeam(client, teamId);
        const access = await requireRosterAccess(client, team, actorId);
        await requireTeamOpen(team);
        const target = await client.query(
          `SELECT id, role FROM team_memberships WHERE team_id = $1 AND user_id = $2 AND status = 'active' FOR UPDATE`,
          [teamId, userId]
        );
        if (!target.rows[0]) throw new LeagueStoreError(404, "That player is not an active member of this team.");
        if (target.rows[0].role === "captain" && !access.manager) {
          throw new LeagueStoreError(403, "A team captain cannot remove a captain. Ask a league owner or administrator.");
        }
        await client.query(
          `UPDATE team_registrations SET ended_at=clock_timestamp(),end_event_type='removed',ended_by=$2,end_reason=$3
           WHERE team_id=$1 AND user_id=$4 AND ended_at IS NULL`,
          [teamId, actorId, reason, userId]
        );
        const updated = await client.query("SELECT id,team_id,user_id,role,status,created_at,updated_at FROM team_memberships WHERE id=$1", [target.rows[0].id]);
        return toTeamMembership(updated.rows[0]);
      });
    },

    async getTeamSigningHistory(teamId, actorId) {
      return withTransaction(database, async (client) => {
        const team = await lockTeam(client, teamId);
        await requireRosterAccess(client, team, actorId, true);
        const result = await client.query(
          `SELECT e.id,e.event_type,e.occurred_at,e.reason,e.signing_type,e.legacy_import,
             r.user_id,r.team_id,t.name AS team_name,coalesce(p.display_name,u.name) AS player_name,
             coalesce(actor_profile.display_name,actor.name) AS authorised_by_name
           FROM team_registration_events e JOIN team_registrations r ON r.id=e.registration_id
           JOIN teams t ON t.id=r.team_id JOIN "user" u ON u.id=r.user_id
           LEFT JOIN player_profiles p ON p.user_id=r.user_id
           LEFT JOIN "user" actor ON actor.id=e.authorized_by
           LEFT JOIN player_profiles actor_profile ON actor_profile.user_id=e.authorized_by
           WHERE r.league_id=$1 AND r.season_id=$2 AND r.team_id=$3
           ORDER BY e.occurred_at DESC LIMIT 100`,
          [team.league_id, team.season_id, teamId]
        );
        return result.rows;
      });
    },

    async assignCaptain(teamId, actorId, userId) {
      return withTransaction(database, async (client) => {
        const team = await lockTeam(client, teamId);
        await requireRosterAccess(client, team, actorId, true);
        await requireTeamOpen(team);
        const target = await client.query(
          `SELECT id FROM team_memberships WHERE team_id = $1 AND user_id = $2 AND status = 'active' FOR UPDATE`,
          [teamId, userId]
        );
        if (!target.rows[0]) throw new LeagueStoreError(409, "Add this active league member to the roster before assigning captain.");
        await client.query(
          `UPDATE team_memberships SET role = 'player', updated_at = now()
           WHERE team_id = $1 AND role = 'captain' AND status = 'active' AND user_id <> $2`,
          [teamId, userId]
        );
        const updated = await client.query(
          `UPDATE team_memberships SET role = 'captain', status = 'active', updated_at = now()
           WHERE team_id = $1 AND user_id = $2
           RETURNING id, team_id, user_id, role, status, created_at, updated_at`,
          [teamId, userId]
        );
        return toTeamMembership(updated.rows[0]);
      });
    },

    async removeCaptain(teamId, actorId) {
      return withTransaction(database, async (client) => {
        const team = await lockTeam(client, teamId);
        await requireRosterAccess(client, team, actorId, true);
        await requireTeamOpen(team);
        const updated = await client.query(
          `UPDATE team_memberships SET role = 'player', updated_at = now()
           WHERE team_id = $1 AND role = 'captain' AND status = 'active'
           RETURNING id, team_id, user_id, role, status, created_at, updated_at`,
          [teamId]
        );
        if (!updated.rows[0]) throw new LeagueStoreError(404, "This team does not have an active captain.");
        return toTeamMembership(updated.rows[0]);
      });
    }
  };
}
