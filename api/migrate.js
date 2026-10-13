import "dotenv/config";
import { fileURLToPath } from "node:url";
import { runner } from "node-pg-migrate";

const direction = process.argv[2];
if (!new Set(["up", "down"]).has(direction)) {
  console.error("Choose a migration direction: up or down.");
  process.exitCode = 2;
} else if (!process.env.DATABASE_URL?.trim()) {
  console.error("DATABASE_URL is required to run migrations.");
  process.exitCode = 2;
} else {
  try {
    await runner({
      databaseUrl: process.env.DATABASE_URL,
      direction,
      dir: fileURLToPath(new URL("./migrations", import.meta.url)),
      migrationsTable: "breakdish_app_migrations",
      createSchema: false
    });
  } catch {
    console.error("BREAK DISH application database migration failed.");
    process.exitCode = 1;
  }
}
