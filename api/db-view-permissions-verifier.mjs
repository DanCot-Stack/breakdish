import { Client } from "pg";

const migrationNames = [
  "001_initial_profiles_and_leagues",
  "002_league_membership_workflow",
  "003_seasons_divisions_teams",
  "004_auditable_team_signings",
  "005_protect_registration_history",
  "006_require_official_start_for_signings",
  "007_match_categories_and_practice_stats",
  "008_doubles_league_match_sides",
  "009_fixture_round_numbers",
  "010_platform_roles",
  "011_backup_super_admin",
  "012_test_only_practice_matches"
];

const viewNames = [
  "match_scoreboard",
  "match_player_statistics",
  "practice_player_statistics",
  "official_competitive_player_statistics"
];

function classifyError(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  if (["ENOTFOUND", "EAI_AGAIN"].includes(code)) return "dns";
  if (["ETIMEDOUT", "ESOCKETTIMEDOUT"].includes(code)) return "timeout";
  if (code.startsWith("ERR_TLS_") || code.startsWith("ERR_SSL_") ||
      ["CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "DEPTH_ZERO_SELF_SIGNED_CERT"].includes(code)) return "tls";
  if (["28P01", "28000"].includes(code)) return "authentication";
  if (["42P01", "42703", "3F000"].includes(code)) return "schema";
  if (code === "42501") return "permissions";
  if (["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "08000", "08001", "08004", "08006"].includes(code)) return "connection";
  return "other";
}

function safeError(category, error = null, stage = null) {
  const code = typeof error?.code === "string" && /^[0-9A-Z]{5}$/.test(error.code) ? error.code : null;
  const errorKind = typeof error?.name === "string" && /^[A-Za-z]+Error$/.test(error.name) ? error.name : null;
  const safeHint = error?.name === "ReferenceError" &&
    typeof error.message === "string" && /^[A-Za-z_$][\w$]* is not defined$/.test(error.message)
    ? error.message : null;
  console.log(JSON.stringify({ success: false, failureStage: stage, failureCategory: category, errorCode: code, errorKind, safeHint }));
  process.exitCode = 1;
}

function parseTarget(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const databaseName = decodeURIComponent(url.pathname.replace(/^\/+|\/+$/g, ""));
  const local = process.env.NODE_ENV === "test" &&
    ["localhost", "127.0.0.1", "::1"].includes(url.hostname) && databaseName.endsWith("_test");
  const render = url.hostname !== "render.com" && url.hostname.endsWith(".render.com") && databaseName === "breakdish";
  if (!new Set(["postgres:", "postgresql:"]).has(url.protocol) || !(local || render)) return null;
  if (!local && (!url.username || !url.password)) return null;
  return { url, databaseName, local };
}

function tlsSafeConnectionString(url) {
  const connectionUrl = new URL(url.toString());
  const sslOptions = new Set(["sslmode", "sslcert", "sslkey", "sslrootcert", "sslpassword", "uselibpqcompat"]);
  for (const key of [...connectionUrl.searchParams.keys()]) {
    if (sslOptions.has(key.toLowerCase())) connectionUrl.searchParams.delete(key);
  }
  return connectionUrl.toString();
}

async function collectSummary(client) {
  const result = await client.query(`
    SELECT
      (SELECT count(*)::text FROM public.matches) AS matches,
      (SELECT count(*)::text FROM public.match_frames) AS frames,
      (SELECT count(*)::text FROM public.match_frame_events) AS frame_events,
      (SELECT count(*)::text FROM public.match_audit_events) AS audit_events,
      (SELECT coalesce(sum(matches_played), 0)::text FROM public.practice_player_statistics) AS practice_matches_played,
      (SELECT coalesce(sum(frames_played), 0)::text FROM public.practice_player_statistics) AS practice_frames_played,
      (SELECT coalesce(sum(dishes), 0)::text FROM public.practice_player_statistics) AS practice_dishes,
      (SELECT coalesce(sum(counter_dishes), 0)::text FROM public.practice_player_statistics) AS practice_counter_dishes,
      (SELECT coalesce(sum(matches_played), 0)::text FROM public.official_competitive_player_statistics) AS official_matches_played,
      (SELECT coalesce(sum(frames_played), 0)::text FROM public.official_competitive_player_statistics) AS official_frames_played,
      (SELECT coalesce(sum(dishes), 0)::text FROM public.official_competitive_player_statistics) AS official_dishes,
      (SELECT coalesce(sum(counter_dishes), 0)::text FROM public.official_competitive_player_statistics) AS official_counter_dishes
  `);
  return result.rows[0];
}

export async function verifyViewPermissions(phase) {
  const rawUrl = process.env.DATABASE_URL;
  const apiRole = process.env.API_DATABASE_ROLE?.trim();
  if (!rawUrl || !apiRole || apiRole.length > 63) return safeError("input");
  const target = parseTarget(rawUrl);
  if (!target) return safeError("target");

  const expected = phase === "pre"
    ? migrationNames.slice(0, -1)
    : migrationNames;
  const client = new Client({
    connectionString: tlsSafeConnectionString(target.url),
    ssl: target.local ? false : { rejectUnauthorized: true },
    connectionTimeoutMillis: 8000,
    query_timeout: 15000
  });
  let connected = false;
  let transactionStarted = false;
  let stage = "connect";
  try {
    await client.connect();
    connected = true;
    stage = "read-only-transaction";
    await client.query("BEGIN READ ONLY");
    transactionStarted = true;

    stage = "database-identity";
    const identity = (await client.query(`
      SELECT current_database() AS database_name,
        current_setting('server_version') AS postgres_version,
        current_user = $1 AS migration_role_is_api_role,
        coalesce((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) AS migration_role_is_superuser,
        (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls_enabled,
        current_setting('transaction_read_only') AS read_only
    `, [apiRole])).rows[0];
    const expectedDatabase = target.local ? target.databaseName : "breakdish";
    if (identity.database_name !== expectedDatabase) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return safeError("target");
    }

    stage = "migration-history";
    const migrations = await client.query(
      "SELECT name FROM public.breakdish_app_migrations ORDER BY run_on, name"
    );
    const actualNames = migrations.rows.map((row) => row.name);
    const missingMigrations = expected.filter((name) => !actualNames.includes(name));
    const unexpectedMigrations = actualNames.filter((name) => !expected.includes(name));
    const migrationHistoryMatches = actualNames.length === expected.length &&
      expected.every((name, index) => actualNames[index] === name);

    stage = "view-permissions";
    const apiRoleExists = (await client.query(
      "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists",
      [apiRole]
    )).rows[0].exists;
    const views = await client.query(`
      SELECT c.relname AS view_name,
        (c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)) AS migration_role_owns_view,
        CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1)
          THEN has_table_privilege($1, c.oid, 'SELECT') ELSE false END AS api_role_can_select,
        EXISTS (
          SELECT 1 FROM aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
          WHERE acl.grantee = 0 AND acl.privilege_type = 'SELECT'
        ) AS public_role_can_select
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'v' AND c.relname = ANY($2::text[])
      ORDER BY c.relname
    `, [apiRole, viewNames]);
    const viewResults = viewNames.map((name) => {
      const row = views.rows.find((item) => item.view_name === name);
      return {
        view: name,
        migrationRoleOwnsView: row?.migration_role_owns_view === true,
        apiRoleCanSelect: row?.api_role_can_select === true,
        publicRoleCanSelect: row?.public_role_can_select === true
      };
    });
    const migrationCanReplaceViews = identity.migration_role_is_superuser === true ||
      viewResults.every((item) => item.migrationRoleOwnsView);
    const viewPermissionsComplete = apiRoleExists && viewResults.length === viewNames.length &&
      viewResults.every((item) => item.apiRoleCanSelect && !item.publicRoleCanSelect);

    stage = "migration-columns";
    const matchColumns = await client.query(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'matches'
        AND column_name IN ('test_only', 'test_request_key')
    `);
    const testOnlyColumn = matchColumns.rows.find((row) => row.column_name === "test_only");
    const requestKeyColumn = matchColumns.rows.find((row) => row.column_name === "test_request_key");
    const has012Columns = phase === "post" && testOnlyColumn?.data_type === "boolean" &&
      testOnlyColumn.is_nullable === "NO" && /false/i.test(testOnlyColumn.column_default || "") &&
      requestKeyColumn?.data_type === "uuid" && requestKeyColumn.is_nullable === "YES";

    let migrationObjectsValid = false;
    if (phase === "post") {
      stage = "migration-objects";
      const objects = await client.query(`
        SELECT
          (SELECT count(*) = 2 AND bool_and(convalidated)
             FROM pg_constraint
            WHERE conrelid = 'public.matches'::regclass
              AND conname IN ('matches_test_only_practice_only', 'matches_test_request_key_consistency')) AS constraints_valid,
          EXISTS (
            SELECT 1 FROM pg_index i JOIN pg_class x ON x.oid = i.indexrelid
            WHERE i.indrelid = 'public.matches'::regclass
              AND x.relname = 'matches_test_request_key_unique'
              AND i.indisunique AND i.indisvalid
          ) AS unique_index_valid,
          EXISTS (
            SELECT 1 FROM pg_trigger t
            WHERE t.tgrelid = 'public.matches'::regclass
              AND t.tgname = 'matches_test_only_guard'
              AND NOT t.tgisinternal AND t.tgenabled IN ('O', 'A')
          ) AS guard_trigger_enabled,
          EXISTS (
            SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname = 'breakdish_test_practice_match_guard'
          ) AS guard_function_exists
      `);
      const objectFlags = objects.rows[0];
      migrationObjectsValid = objectFlags.constraints_valid && objectFlags.unique_index_valid &&
        objectFlags.guard_trigger_enabled && objectFlags.guard_function_exists;
    }

    let viewDefinitionsValid = false;
    if (phase === "post") {
      stage = "view-definitions";
      const definitions = await client.query(`
        SELECT c.relname AS view_name, pg_get_viewdef(c.oid, true) AS definition
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'v' AND c.relname = ANY($1::text[])
      `, [viewNames]);
      const byName = new Map(definitions.rows.map((row) => [row.view_name, row.definition.toLowerCase()]));
      viewDefinitionsValid = byName.size === viewNames.length &&
        byName.get("match_scoreboard")?.includes("test_only") === true &&
        /\btest_only\s*=\s*false\b/.test(byName.get("match_player_statistics") || "") &&
        byName.get("practice_player_statistics")?.includes("match_player_statistics") === true &&
        byName.get("official_competitive_player_statistics")?.includes("match_player_statistics") === true;
    }

    stage = "data-summary";
    const summary = await collectSummary(client);
    await client.query("ROLLBACK");
    transactionStarted = false;

    const tlsValid = target.local ? identity.tls_enabled === false : identity.tls_enabled === true;
    const readOnly = identity.read_only === "on";
    const migration012Applied = actualNames.includes(migrationNames.at(-1));
    const result = {
      success: migrationHistoryMatches && viewPermissionsComplete && migrationCanReplaceViews &&
        tlsValid && readOnly && (phase === "pre" ? !migration012Applied : migration012Applied &&
          has012Columns && migrationObjectsValid && viewDefinitionsValid),
      phase,
      database: identity.database_name,
      postgresVersion: identity.postgres_version,
      tlsEnabled: identity.tls_enabled === true,
      readOnly,
      migrationCount: actualNames.length,
      migrationHistoryMatches,
      missingMigrations,
      unexpectedMigrations,
      migration012Applied,
      apiRoleConfigured: true,
      apiRoleExists,
      migrationRoleIsApiRole: identity.migration_role_is_api_role === true,
      migrationRoleCanReplaceViews: migrationCanReplaceViews,
      viewPermissions: viewResults,
      has012Columns,
      migrationObjectsValid,
      viewDefinitionsExcludeTestMatches: phase === "post" ? viewDefinitionsValid : null,
      aggregateDataSummary: summary
    };
    console.log(JSON.stringify(result, null, 2));
    if (!result.success) process.exitCode = 1;
  } catch (error) {
    safeError(classifyError(error), error, stage);
  } finally {
    if (connected && transactionStarted) {
      try { await client.query("ROLLBACK"); } catch { /* Sanitized cleanup only. */ }
    }
    if (connected) {
      try { await client.end(); } catch { /* Sanitized cleanup only. */ }
    }
  }
}
