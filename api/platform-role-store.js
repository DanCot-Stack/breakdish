export class PlatformRoleError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const ROLE_LOCK_NAMESPACE = 1363351362;
const ROLE_LOCK_KEY = 10;

function cleanUserId(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 128 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new PlatformRoleError(400, "Enter a valid account ID.");
  }
  return value.trim();
}

function cleanReason(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.trim().length > 500) {
    throw new PlatformRoleError(400, "Reason must be 500 characters or fewer.");
  }
  return value.trim() || null;
}

function mapAssignment(row) {
  return {
    userId: row.user_id,
    role: row.role,
    grantedAt: row.granted_at,
    grantedBy: row.granted_by ?? null
  };
}

async function withRoleTransaction(database, work) {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1, $2)", [ROLE_LOCK_NAMESPACE, ROLE_LOCK_KEY]);
    const value = await work(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error.code === "23505") throw new PlatformRoleError(409, "That platform role is already assigned.");
    throw error;
  } finally {
    client.release();
  }
}

async function requireSuperAdminOn(client, userId) {
  const result = await client.query(
    "SELECT 1 FROM platform_roles WHERE user_id = $1 AND role = 'super_admin'",
    [cleanUserId(userId)]
  );
  if (!result.rows[0]) throw new PlatformRoleError(403, "Only the BREAK DISH Super Admin can manage platform roles.");
}

export function createPlatformRoleStore(database) {
  async function hasPlatformRole(userId, role) {
    const normalizedUserId = cleanUserId(userId);
    if (!new Set(["super_admin", "platform_admin"]).has(role)) return false;
    const result = await database.query(
      "SELECT 1 FROM platform_roles WHERE user_id = $1 AND role = $2",
      [normalizedUserId, role]
    );
    return Boolean(result.rows[0]);
  }

  async function isSuperAdmin(userId) {
    return hasPlatformRole(userId, "super_admin");
  }

  async function isPlatformAdmin(userId) {
    const normalizedUserId = cleanUserId(userId);
    const result = await database.query(
      "SELECT 1 FROM platform_roles WHERE user_id = $1 AND role IN ('super_admin', 'platform_admin')",
      [normalizedUserId]
    );
    return Boolean(result.rows[0]);
  }

  async function requireSuperAdmin(userId) {
    if (!await isSuperAdmin(userId)) {
      throw new PlatformRoleError(403, "This action requires the BREAK DISH Super Admin.");
    }
    return true;
  }

  async function requirePlatformAdmin(userId) {
    if (!await isPlatformAdmin(userId)) {
      throw new PlatformRoleError(403, "This action requires a BREAK DISH platform administrator.");
    }
    return true;
  }

  return {
    hasPlatformRole,
    isSuperAdmin,
    isPlatformAdmin,
    requireSuperAdmin,
    requirePlatformAdmin,

    async bootstrapSuperAdmin(userId, reason) {
      const targetUserId = cleanUserId(userId);
      const detail = cleanReason(reason);
      return withRoleTransaction(database, async (client) => {
        const user = await client.query('SELECT id FROM "user" WHERE id = $1', [targetUserId]);
        if (!user.rows[0]) throw new PlatformRoleError(404, "The account to bootstrap could not be found.");

        const existing = await client.query(
          "SELECT user_id FROM platform_roles WHERE role = 'super_admin' LIMIT 1"
        );
        if (existing.rows[0]) throw new PlatformRoleError(409, "A Super Admin has already been bootstrapped.");

        const existingTargetRole = await client.query("SELECT role FROM platform_roles WHERE user_id = $1", [targetUserId]);
        if (existingTargetRole.rows[0]) {
          throw new PlatformRoleError(409, "The account already has a platform role and cannot be bootstrapped.");
        }

        const assignment = await client.query(
          `INSERT INTO platform_roles(user_id, role, granted_by)
           VALUES($1, 'super_admin', NULL) RETURNING user_id, role, granted_at, granted_by`,
          [targetUserId]
        );
        await client.query(
          `INSERT INTO platform_role_events(target_user_id, role, action, actor_user_id, reason)
           VALUES($1, 'super_admin', 'bootstrap', NULL, $2)`,
          [targetUserId, detail]
        );
        return mapAssignment(assignment.rows[0]);
      });
    },

    async listActivePlatformAdmins(actorId) {
      await requireSuperAdmin(actorId);
      const result = await database.query(
        `SELECT pr.user_id, pr.role, pr.granted_at, pr.granted_by,
           coalesce(pp.display_name, u.name) AS display_name, u.email,
           grantor.name AS grantor_name
         FROM platform_roles pr
         JOIN "user" u ON u.id = pr.user_id
         LEFT JOIN player_profiles pp ON pp.user_id = pr.user_id
         LEFT JOIN "user" grantor ON grantor.id = pr.granted_by
         WHERE pr.role = 'platform_admin'
         ORDER BY pr.granted_at, pr.user_id`
      );
      return result.rows.map((row) => ({
        userId: row.user_id,
        role: row.role,
        displayName: row.display_name,
        email: row.email,
        grantedAt: row.granted_at,
        grantedBy: row.granted_by,
        grantedByName: row.grantor_name ?? null
      }));
    },

    async listRoleHistory(actorId, limit = 100) {
      await requireSuperAdmin(actorId);
      const boundedLimit = Number.isInteger(limit) && limit >= 1 && limit <= 200 ? limit : 100;
      const result = await database.query(
        `SELECT e.id, e.target_user_id, e.role, e.action, e.actor_user_id, e.reason, e.created_at,
           coalesce(target_profile.display_name, target_user.name) AS target_name,
           actor.name AS actor_name
         FROM platform_role_events e
         JOIN "user" target_user ON target_user.id = e.target_user_id
         LEFT JOIN player_profiles target_profile ON target_profile.user_id = e.target_user_id
         LEFT JOIN "user" actor ON actor.id = e.actor_user_id
         ORDER BY e.created_at DESC, e.id DESC
         LIMIT $1`,
        [boundedLimit]
      );
      return result.rows.map((row) => ({
        id: row.id,
        targetUserId: row.target_user_id,
        targetName: row.target_name,
        role: row.role,
        action: row.action,
        actorUserId: row.actor_user_id ?? null,
        actorName: row.actor_name ?? null,
        reason: row.reason ?? null,
        createdAt: row.created_at
      }));
    },

    async grantPlatformAdmin(actorId, targetUserId, reason) {
      const actor = cleanUserId(actorId);
      const target = cleanUserId(targetUserId);
      const detail = cleanReason(reason);
      return withRoleTransaction(database, async (client) => {
        await requireSuperAdminOn(client, actor);
        const user = await client.query('SELECT id FROM "user" WHERE id = $1', [target]);
        if (!user.rows[0]) throw new PlatformRoleError(404, "The target account could not be found.");

        const existing = await client.query("SELECT user_id, role, granted_at, granted_by FROM platform_roles WHERE user_id = $1 FOR UPDATE", [target]);
        if (existing.rows[0]?.role === "platform_admin") {
          return { assignment: mapAssignment(existing.rows[0]), repeated: true };
        }
        if (existing.rows[0]) throw new PlatformRoleError(409, "The target account already holds a different platform role.");

        const assignment = await client.query(
          `INSERT INTO platform_roles(user_id, role, granted_by)
           VALUES($1, 'platform_admin', $2) RETURNING user_id, role, granted_at, granted_by`,
          [target, actor]
        );
        await client.query(
          `INSERT INTO platform_role_events(target_user_id, role, action, actor_user_id, reason)
           VALUES($1, 'platform_admin', 'grant', $2, $3)`,
          [target, actor, detail]
        );
        return { assignment: mapAssignment(assignment.rows[0]), repeated: false };
      });
    },

    async revokePlatformAdmin(actorId, targetUserId, reason) {
      const actor = cleanUserId(actorId);
      const target = cleanUserId(targetUserId);
      const detail = cleanReason(reason);
      return withRoleTransaction(database, async (client) => {
        await requireSuperAdminOn(client, actor);
        const user = await client.query('SELECT id FROM "user" WHERE id = $1', [target]);
        if (!user.rows[0]) throw new PlatformRoleError(404, "The target account could not be found.");
        const existing = await client.query("SELECT role FROM platform_roles WHERE user_id = $1 FOR UPDATE", [target]);
        if (!existing.rows[0]) return { revoked: false, userId: target };
        if (existing.rows[0].role !== "platform_admin") {
          throw new PlatformRoleError(409, "Only an active Platform Admin assignment can be revoked here.");
        }

        await client.query("DELETE FROM platform_roles WHERE user_id = $1 AND role = 'platform_admin'", [target]);
        const event = await client.query(
          `INSERT INTO platform_role_events(target_user_id, role, action, actor_user_id, reason)
           VALUES($1, 'platform_admin', 'revoke', $2, $3) RETURNING created_at`,
          [target, actor, detail]
        );
        return { revoked: true, userId: target, role: "platform_admin", revokedAt: event.rows[0].created_at };
      });
    }
  };
}
