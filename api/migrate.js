import "dotenv/config";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runner as migrationRunner } from "node-pg-migrate";

const renderSslParameters = new Set([
  "sslmode",
  "sslcert",
  "sslkey",
  "sslrootcert",
  "sslpassword",
  "uselibpqcompat"
]);

function isRenderPostgresHost(url) {
  return url.hostname.toLowerCase().endsWith(".render.com");
}

export function buildMigrationDatabaseConfig(databaseUrl, { forceRenderTls = false } = {}) {
  let url;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error("Invalid PostgreSQL database URL.");
  }

  if (!new Set(["postgres:", "postgresql:"]).has(url.protocol)) {
    throw new Error("Invalid PostgreSQL database URL.");
  }

  const config = {
    connectionString: databaseUrl,
    connectionTimeoutMillis: 10000
  };

  if (!isRenderPostgresHost(url) && !forceRenderTls) return config;

  for (const parameter of [...url.searchParams.keys()]) {
    if (renderSslParameters.has(parameter.toLowerCase())) {
      url.searchParams.delete(parameter);
    }
  }

  return {
    ...config,
    connectionString: url.toString(),
    ssl: { rejectUnauthorized: true }
  };
}

export function parseMigrationCount(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return null;
  const count = Number(value);
  return Number.isSafeInteger(count) ? count : null;
}

export async function runApplicationMigrations({
  databaseUrl,
  direction,
  count,
  forceRenderTls = false
}) {
  if (!new Set(["up", "down"]).has(direction)) {
    throw new Error("Invalid migration direction.");
  }
  if (count !== undefined && (!Number.isSafeInteger(count) || count < 1)) {
    throw new Error("Invalid migration count.");
  }

  return migrationRunner({
    databaseUrl: buildMigrationDatabaseConfig(databaseUrl, { forceRenderTls }),
    direction,
    ...(count === undefined ? {} : { count }),
    dir: fileURLToPath(new URL("./migrations", import.meta.url)),
    migrationsTable: "breakdish_app_migrations",
    createSchema: false,
    // node-pg-migrate logs raw connection errors by default. Keep its output
    // suppressed so the CLI can report a safe, generic result instead.
    log: () => {}
  });
}

async function main() {
  const [direction, countArgument, ...extraArguments] = process.argv.slice(2);
  const count = parseMigrationCount(countArgument);

  if (!new Set(["up", "down"]).has(direction) || extraArguments.length > 0 ||
      (countArgument !== undefined && count === null)) {
    console.error("Usage: node migrate.js <up|down> [positive-migration-count]");
    process.exitCode = 2;
    return;
  }
  if (!process.env.DATABASE_URL?.trim()) {
    console.error("DATABASE_URL is required to run migrations.");
    process.exitCode = 2;
    return;
  }

  try {
    await runApplicationMigrations({
      databaseUrl: process.env.DATABASE_URL,
      direction,
      count
    });
    console.log("BREAK DISH application migrations completed successfully.");
  } catch {
    console.error("BREAK DISH application database migration failed.");
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) await main();
