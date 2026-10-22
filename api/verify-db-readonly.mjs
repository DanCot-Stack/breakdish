import {
  APPLICATION_MIGRATIONS_001_012,
  compareApplicationMigrationHistory
} from "./release-migration-baseline.mjs";

const rawUrl = process.env.DATABASE_URL;
const localTestDatabases = new Set([
  "breakdish_verify_test",
  "breakdish_pre013_test",
  "breakdish_post013_test",
  "breakdish_wrongstate_test",
  "breakdish_verify_incomplete_test",
  "breakdish_verify_missing_view_test"
]);

const expectedTables = [
  "player_profiles",
  "leagues",
  "league_memberships",
  "seasons",
  "divisions",
  "teams",
  "team_memberships",
  "team_registrations",
  "team_registration_events",
  "breakdish_app_migrations",
  "matches",
  "match_frames",
  "league_match_format_templates",
  "league_match_format_template_frames",
  "match_format_snapshots",
  "match_format_snapshot_frames",
  "user",
  "session",
  "account",
  "verification",
  "rateLimit"
];
const expectedViews = [
  "match_scoreboard",
  "match_player_statistics",
  "practice_player_statistics",
  "official_competitive_player_statistics"
];

function reportFailure(category) {
  console.log(JSON.stringify({ failure: category }));
  process.exitCode = 1;
}

function classifyError(error) {
  const code = typeof error?.code === "string" ? error.code : "";

  if (["ENOTFOUND", "EAI_AGAIN"].includes(code)) return "dns";
  if (["ETIMEDOUT", "ESOCKETTIMEDOUT"].includes(code)) return "timeout";
  if (code.startsWith("ERR_TLS_") || code.startsWith("ERR_SSL_") ||
      ["CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "DEPTH_ZERO_SELF_SIGNED_CERT"].includes(code)) {
    return "tls-connection";
  }
  if (["28P01", "28000"].includes(code)) return "authentication";
  if (code === "3D000") return "database";
  if (["42P01", "42703", "3F000"].includes(code)) return "schema";
  if (["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "08000", "08001", "08004", "08006"].includes(code)) {
    return "connection";
  }
  if (code === "42501") return "permissions";
  return "other";
}

async function main() {
  let Pool;
  try {
    ({ Pool } = await import("pg"));
  } catch {
    return reportFailure("module");
  }

  if (!rawUrl) return reportFailure("input");

  let target;
  let databaseFromUrl;
  try {
    target = new URL(rawUrl);
    databaseFromUrl = decodeURIComponent(target.pathname.replace(/^\/+|\/+$/g, ""));
  } catch {
    return reportFailure("target");
  }

  const localTestTarget = process.env.NODE_ENV === "test" &&
    ["localhost", "127.0.0.1", "::1"].includes(target.hostname) &&
    localTestDatabases.has(databaseFromUrl);
  const renderHost = target.hostname !== "render.com" && target.hostname.endsWith(".render.com");
  const validProtocol = ["postgres:", "postgresql:"].includes(target.protocol);
  const hasCredentials = Boolean(target.username && target.password);

  if (!validProtocol || !(localTestTarget || (renderHost && databaseFromUrl === "breakdish"))) {
    return reportFailure("target");
  }
  if (!localTestTarget && !hasCredentials) return reportFailure("authentication");

  const connectionUrl = new URL(rawUrl);
  const sslQueryOptions = new Set(["sslmode", "sslcert", "sslkey", "sslrootcert", "sslpassword", "uselibpqcompat"]);
  for (const key of [...connectionUrl.searchParams.keys()]) {
    if (sslQueryOptions.has(key.toLowerCase())) connectionUrl.searchParams.delete(key);
  }

  let pool;
  let client;
  let transactionStarted = false;
  let result;

  try {
    pool = new Pool({
      connectionString: connectionUrl.toString(),
      ssl: localTestTarget ? false : { rejectUnauthorized: true },
      max: 1,
      connectionTimeoutMillis: 8000
    });
    client = await pool.connect();
    await client.query("BEGIN READ ONLY");
    transactionStarted = true;

    const identity = (await client.query(`
      SELECT current_database() AS database,
        current_setting('server_version') AS postgres_version,
        (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls,
        current_setting('transaction_read_only') AS transaction_read_only
    `)).rows[0];

    const publicTables = (await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name"
    )).rows.map((row) => row.table_name);
    const publicViews = (await client.query(
      "SELECT table_name FROM information_schema.views WHERE table_schema = 'public' ORDER BY table_name"
    )).rows.map((row) => row.table_name);

    const migrationRows = (await client.query(
      "SELECT name FROM public.breakdish_app_migrations ORDER BY run_on ASC, name ASC"
    )).rows;
    const appliedMigrationNames = migrationRows.map((row) => row.name);
    const history = compareApplicationMigrationHistory(appliedMigrationNames, APPLICATION_MIGRATIONS_001_012);
    const { missingMigrations, unexpectedMigrations, migrationHistoryMatches,
      migration012Applied, migration013Applied } = history;
    const missingTables = expectedTables.filter((name) => !publicTables.includes(name));
    const missingViews = expectedViews.filter((name) => !publicViews.includes(name));
    const raceToColumnCount = (await client.query(`
      SELECT count(*)::integer AS count
      FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'race_to'
        AND table_name IN ('league_match_format_templates', 'match_format_snapshots')
    `)).rows[0].count;
    const raceToColumnsAbsent = raceToColumnCount === 0;

    await client.query("ROLLBACK");
    transactionStarted = false;

    const expectedDatabase = localTestTarget ? databaseFromUrl : "breakdish";
    if (identity.database !== expectedDatabase) return reportFailure("target");

    result = {
      database: identity.database,
      postgresVersion: identity.postgres_version,
      tlsEncrypted: identity.tls === true,
      tlsRequired: !localTestTarget,
      transactionReadOnly: identity.transaction_read_only === "on",
      migrationEntryCount: appliedMigrationNames.length,
      migrationHistoryMatches,
      missingMigrations,
      unexpectedMigrations,
      migration012Applied,
      migration013Applied,
      raceToColumnsAbsent,
      missingTables,
      missingViews
    };
    if ((!localTestTarget && identity.tls !== true) ||
        identity.transaction_read_only !== "on" || !migrationHistoryMatches ||
        missingMigrations.length || unexpectedMigrations.length || !migration012Applied || migration013Applied ||
        !raceToColumnsAbsent || missingTables.length || missingViews.length) {
      process.exitCode = 1;
    }
  } catch (error) {
    reportFailure(classifyError(error));
  } finally {
    if (client && transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Do not expose database/provider details.
      }
    }
    if (client) client.release();
    if (pool) {
      try {
        await pool.end();
      } catch {
        // Do not expose database/provider details.
      }
    }
  }

  if (result) console.log(JSON.stringify(result, null, 2));
}

try {
  await main();
} catch {
  reportFailure("other");
}
