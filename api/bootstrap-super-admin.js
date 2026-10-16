import "dotenv/config";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { Pool } from "pg";
import { createPlatformRoleStore, PlatformRoleError } from "./platform-role-store.js";

export async function bootstrapSuperAdmin(database, userId, reason) {
  return createPlatformRoleStore(database).bootstrapSuperAdmin(userId, reason);
}

async function runFromEnvironment() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const userId = process.env.BOOTSTRAP_SUPER_ADMIN_USER_ID?.trim();
  if (!databaseUrl || !userId) {
    console.error("Set DATABASE_URL and BOOTSTRAP_SUPER_ADMIN_USER_ID in the current process environment.");
    process.exitCode = 2;
    return;
  }

  const database = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000 });
  try {
    await bootstrapSuperAdmin(database, userId, process.env.BOOTSTRAP_SUPER_ADMIN_REASON);
    console.log("BREAK DISH Super Admin bootstrap completed.");
  } catch (error) {
    const category = error instanceof PlatformRoleError
      ? `request-rejected-${error.status}`
      : error.code === "ECONNREFUSED" || error.code === "ENOTFOUND"
        ? "database-connection"
        : "database-or-bootstrap-error";
    console.error(`BREAK DISH Super Admin bootstrap failed (${category}).`);
    process.exitCode = 1;
  } finally {
    await database.end().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runFromEnvironment();
}
