import "dotenv/config";
import { Pool } from "pg";
import { createAuth } from "./auth-factory.js";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required for account services.");

const database = new Pool({
  connectionString: databaseUrl,
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000
});

const auth = createAuth({ database });

async function closeAuthDatabase() {
  await database.end();
}

export { auth, database, closeAuthDatabase };
