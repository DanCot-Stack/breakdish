export class LeagueStoreError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function toLeague(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    location: row.location,
    status: row.status,
    joinPolicy: row.join_policy,
    memberCount: row.member_count === undefined ? undefined : Number(row.member_count),
    viewerMembership: row.viewer_role ? { role: row.viewer_role, status: row.viewer_status } : null,
    viewerIsPlayer: row.viewer_is_player === undefined ? undefined : row.viewer_is_player === true,
    currentSeason: row.current_season_name ? {
      name: row.current_season_name,
      status: row.current_season_status
    } : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toMembership(row) {
  return {
    leagueId: row.league_id,
    userId: row.user_id,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toMember(row) {
  return {
    userId: row.user_id,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    createdAt: row.created_at
  };
}

function slugBase(name) {
  const base = name.normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120)
    .replace(/-+$/g, "");
  return base || "pool-league";
}

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
    throw error;
  } finally {
    client.release();
  }
}

async function assertManager(client, leagueId, userId, ownerOnly = false) {
  const result = await client.query(
    `SELECT role, status FROM league_memberships
     WHERE league_id = $1 AND user_id = $2 FOR UPDATE`,
    [leagueId, userId]
  );
  const membership = result.rows[0];
  if (!membership || membership.status !== "active" ||
    (ownerOnly ? membership.role !== "owner" : !["owner", "administrator"].includes(membership.role))) {
    throw new LeagueStoreError(403, ownerOnly
      ? "Only this league's active owner can change member roles."
      : "Only an active league owner or administrator can manage membership.");
  }
  return membership;
}

const PUBLIC_LEAGUE_SELECT = `
  SELECT l.id, l.name, l.slug, l.description, l.location, l.status, l.join_policy,
    l.created_at, l.updated_at,
    count(m.id) FILTER (WHERE m.status = 'active')::integer AS member_count,
    viewer.role AS viewer_role, viewer.status AS viewer_status
  FROM leagues l
  LEFT JOIN league_memberships m ON m.league_id = l.id
  LEFT JOIN league_memberships viewer ON viewer.league_id = l.id AND viewer.user_id = $1
`;

const PLAYER_PARTICIPATION = `(
  EXISTS (
    SELECT 1 FROM team_registrations tr
    JOIN seasons registered_season ON registered_season.id = tr.season_id
    JOIN teams registered_team ON registered_team.id = tr.team_id
    WHERE tr.league_id = l.id AND tr.user_id = $1 AND tr.ended_at IS NULL
      AND registered_season.status <> 'completed' AND registered_team.status = 'active'
  ) OR EXISTS (
    SELECT 1 FROM competition_entries ce
    JOIN competition_entry_participants cep ON cep.entry_id = ce.id
    JOIN seasons entry_season ON entry_season.id = ce.season_id
    WHERE ce.league_id = l.id AND cep.user_id = $1 AND ce.status = 'approved'
      AND ce.entry_type IN ('singles_league', 'doubles_league')
      AND entry_season.status <> 'completed'
  ) OR EXISTS (
    SELECT 1 FROM match_participants mp
    JOIN matches player_match ON player_match.id = mp.match_id
    JOIN seasons player_season ON player_season.id = player_match.season_id
    WHERE player_match.league_id = l.id AND mp.user_id = $1
      AND player_match.match_type IN ('team_league', 'singles_league', 'doubles_league')
      AND player_match.status <> 'cancelled'
      AND player_season.status <> 'completed'
  )
)`;

const CURRENT_SEASON_JOIN = `
  LEFT JOIN LATERAL (
    SELECT s.name, s.status FROM seasons s WHERE s.league_id = l.id
    ORDER BY CASE s.status WHEN 'active' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END,
      s.created_at DESC
    LIMIT 1
  ) current_season ON true
`;

export function createLeagueStore(database) {
  return {
    async create(userId, details) {
      return withTransaction(database, async (client) => {
        const base = slugBase(details.name);
        let league;
        for (let suffix = 1; suffix <= 10_000; suffix++) {
          const slug = suffix === 1 ? base : `${base}-${suffix}`;
          const result = await client.query(
            `INSERT INTO leagues (name, slug, description, location, status, join_policy, created_by)
             VALUES ($1, $2, $3, $4, 'open', $5, $6)
             ON CONFLICT (slug) DO NOTHING
             RETURNING id, name, slug, description, location, status, join_policy, created_at, updated_at`,
            [details.name, slug, details.description, details.location, details.joinPolicy, userId]
          );
          if (result.rows[0]) {
            league = result.rows[0];
            break;
          }
        }
        if (!league) throw new LeagueStoreError(503, "A unique league address could not be created. Please try again.");

        const owner = await client.query(
          `SELECT role, status, created_at, updated_at FROM league_memberships WHERE league_id = $1 AND user_id = $2`,
          [league.id, userId]
        );
        if (owner.rows[0]?.role !== "owner" || owner.rows[0]?.status !== "active") {
          throw new Error("League owner assignment did not complete.");
        }
        return { league: toLeague(league), membership: toMembership({ league_id: league.id, user_id: userId, ...owner.rows[0] }) };
      });
    },

    async listPublic(viewerId = null) {
      const result = await database.query(
        `${PUBLIC_LEAGUE_SELECT}
         WHERE l.status IN ('open', 'active')
         GROUP BY l.id, viewer.role, viewer.status
         ORDER BY l.name ASC, l.created_at ASC`,
        [viewerId]
      );
      return result.rows.map(toLeague);
    },

    async getPublicById(leagueId, viewerId = null) {
      const result = await database.query(
        `${PUBLIC_LEAGUE_SELECT}
         WHERE l.id = $2 AND l.status IN ('open', 'active')
         GROUP BY l.id, viewer.role, viewer.status`,
        [viewerId, leagueId]
      );
      return toLeague(result.rows[0]);
    },

    async listMine(userId) {
      const result = await database.query(
        `SELECT l.id, l.name, l.slug, l.description, l.location, l.status, l.join_policy,
          l.created_at, l.updated_at, m.role AS viewer_role, m.status AS viewer_status,
          ${PLAYER_PARTICIPATION} AS viewer_is_player,
          current_season.name AS current_season_name, current_season.status AS current_season_status
         FROM league_memberships m JOIN leagues l ON l.id = m.league_id
         ${CURRENT_SEASON_JOIN}
         WHERE m.user_id = $1 AND m.status = 'active'
           AND (m.role = 'member' OR ${PLAYER_PARTICIPATION})
         ORDER BY l.name ASC, l.created_at ASC`,
        [userId]
      );
      return result.rows.map(toLeague);
    },

    async listManaged(userId) {
      const result = await database.query(
        `SELECT l.id, l.name, l.slug, l.description, l.location, l.status, l.join_policy,
          l.created_at, l.updated_at, m.role AS viewer_role, m.status AS viewer_status,
          current_season.name AS current_season_name, current_season.status AS current_season_status
         FROM league_memberships m JOIN leagues l ON l.id = m.league_id
         ${CURRENT_SEASON_JOIN}
         WHERE m.user_id = $1 AND m.status = 'active'
           AND m.role IN ('owner', 'administrator')
         ORDER BY l.name ASC, l.created_at ASC`,
        [userId]
      );
      return result.rows.map(toLeague);
    },

    async join(leagueId, userId) {
      return withTransaction(database, async (client) => {
        const leagueResult = await client.query(
          `SELECT id, status, join_policy FROM leagues WHERE id = $1 FOR UPDATE`,
          [leagueId]
        );
        const league = leagueResult.rows[0];
        if (!league || !["open", "active"].includes(league.status)) {
          throw new LeagueStoreError(404, "This league is not available to join.");
        }

        const existingResult = await client.query(
          `SELECT league_id, user_id, role, status, created_at, updated_at
           FROM league_memberships WHERE league_id = $1 AND user_id = $2 FOR UPDATE`,
          [leagueId, userId]
        );
        const existing = existingResult.rows[0];
        if (existing && ["active", "pending"].includes(existing.status)) {
          return { membership: toMembership(existing), repeated: true };
        }
        if (existing?.status === "suspended") {
          throw new LeagueStoreError(409, "This league membership is suspended. Contact a league organiser.");
        }
        if (existing?.role === "owner") {
          throw new LeagueStoreError(409, "The league owner membership cannot be changed through joining.");
        }

        const status = league.join_policy === "open" ? "active" : "pending";
        const result = existing
          ? await client.query(
            `UPDATE league_memberships SET role = 'member', status = $3, updated_at = now()
             WHERE league_id = $1 AND user_id = $2
             RETURNING league_id, user_id, role, status, created_at, updated_at`,
            [leagueId, userId, status]
          )
          : await client.query(
            `INSERT INTO league_memberships (league_id, user_id, role, status)
             VALUES ($1, $2, 'member', $3)
             RETURNING league_id, user_id, role, status, created_at, updated_at`,
            [leagueId, userId, status]
          );
        return { membership: toMembership(result.rows[0]), repeated: false };
      });
    },

    async listPending(leagueId, actorId) {
      return withTransaction(database, async (client) => {
        await assertManager(client, leagueId, actorId);
        const result = await client.query(
          `SELECT m.user_id, COALESCE(p.display_name, u.name) AS display_name, m.role, m.status, m.created_at
           FROM league_memberships m
           JOIN "user" u ON u.id = m.user_id
           LEFT JOIN player_profiles p ON p.user_id = m.user_id
           WHERE m.league_id = $1 AND m.status = 'pending'
           ORDER BY m.created_at ASC`,
          [leagueId]
        );
        return result.rows.map(toMember);
      });
    },

    async listMembers(leagueId, actorId) {
      return withTransaction(database, async (client) => {
        await assertManager(client, leagueId, actorId);
        const result = await client.query(
          `SELECT m.user_id, COALESCE(p.display_name, u.name) AS display_name, m.role, m.status, m.created_at
           FROM league_memberships m
           JOIN "user" u ON u.id = m.user_id
           LEFT JOIN player_profiles p ON p.user_id = m.user_id
           WHERE m.league_id = $1 AND m.status = 'active'
           ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'administrator' THEN 1 ELSE 2 END,
             display_name ASC`,
          [leagueId]
        );
        return result.rows.map(toMember);
      });
    },

    async reviewRequest(leagueId, actorId, targetUserId, action) {
      return withTransaction(database, async (client) => {
        await client.query(`SELECT id FROM leagues WHERE id = $1 FOR UPDATE`, [leagueId]);
        await assertManager(client, leagueId, actorId);
        const targetResult = await client.query(
          `SELECT league_id, user_id, role, status, created_at, updated_at
           FROM league_memberships WHERE league_id = $1 AND user_id = $2 FOR UPDATE`,
          [leagueId, targetUserId]
        );
        const target = targetResult.rows[0];
        if (!target || target.status !== "pending" || target.role !== "member") {
          throw new LeagueStoreError(409, "This membership request is no longer pending.");
        }
        const status = action === "approve" ? "active" : "declined";
        const updated = await client.query(
          `UPDATE league_memberships SET status = $3, updated_at = now()
           WHERE league_id = $1 AND user_id = $2
           RETURNING league_id, user_id, role, status, created_at, updated_at`,
          [leagueId, targetUserId, status]
        );
        return toMembership(updated.rows[0]);
      });
    },

    async setMemberRole(leagueId, actorId, targetUserId, role) {
      return withTransaction(database, async (client) => {
        await client.query(`SELECT id FROM leagues WHERE id = $1 FOR UPDATE`, [leagueId]);
        await assertManager(client, leagueId, actorId, true);
        const targetResult = await client.query(
          `SELECT league_id, user_id, role, status, created_at, updated_at
           FROM league_memberships WHERE league_id = $1 AND user_id = $2 FOR UPDATE`,
          [leagueId, targetUserId]
        );
        const target = targetResult.rows[0];
        if (!target || target.status !== "active") {
          throw new LeagueStoreError(404, "An active league member with that account was not found.");
        }
        if (target.role === "owner") {
          throw new LeagueStoreError(409, "The league owner cannot be changed through member role management.");
        }
        const updated = await client.query(
          `UPDATE league_memberships SET role = $3, updated_at = now()
           WHERE league_id = $1 AND user_id = $2
           RETURNING league_id, user_id, role, status, created_at, updated_at`,
          [leagueId, targetUserId, role]
        );
        return toMembership(updated.rows[0]);
      });
    }
  };
}
