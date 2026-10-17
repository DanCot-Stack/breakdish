import "dotenv/config";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { Pool } from "pg";
import { createPlatformRoleStore, PlatformRoleError } from "./platform-role-store.js";

export async function assignBackupSuperAdmin(database, actorUserId, targetUserId, reason) {
  return createPlatformRoleStore(database).assignRecoverySuperAdmin(actorUserId, targetUserId, reason);
}

async function runFromEnvironment() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const actorUserId = process.env.BACKUP_SUPER_ADMIN_ACTOR_USER_ID?.trim();
  const targetUserId = process.env.BACKUP_SUPER_ADMIN_USER_ID?.trim();
  if (!databaseUrl || !actorUserId || !targetUserId) {
    console.error("Set DATABASE_URL, BACKUP_SUPER_ADMIN_ACTOR_USER_ID and BACKUP_SUPER_ADMIN_USER_ID in the current process environment.");
    process.exitCode = 2;
    return;
  }

  const database = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000 });
  try {
    await assignBackupSuperAdmin(
      database,
      actorUserId,
      targetUserId,
      process.env.BACKUP_SUPER_ADMIN_REASON || "Controlled backup/recovery Super Admin assignment"
    );
    console.log("BREAK DISH backup/recovery Super Admin assignment completed.");
  } catch (error) {
    const category = error instanceof PlatformRoleError
      ? `request-rejected-${error.status}`
      : error.code === "ECONNREFUSED" || error.code === "ENOTFOUND"
        ? "database-connection"
        : "database-or-assignment-error";
    console.error(`BREAK DISH backup/recovery Super Admin assignment failed (${category}).`);
    process.exitCode = 1;
  } finally {
    await database.end().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runFromEnvironment();
}
