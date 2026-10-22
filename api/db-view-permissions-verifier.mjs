import { Client } from "pg";
import {
  APPLICATION_MIGRATIONS_001_012,
  APPLICATION_MIGRATIONS_001_013,
  compareApplicationMigrationHistory
} from "./release-migration-baseline.mjs";

const migrationNames = APPLICATION_MIGRATIONS_001_013;
const pre013MigrationNames = APPLICATION_MIGRATIONS_001_012;
const viewNames = [
  "match_scoreboard",
  "match_player_statistics",
  "practice_player_statistics",
  "official_competitive_player_statistics"
];
const raceColumns = [
  ["league_match_format_templates", "race_to"],
  ["match_format_snapshots", "race_to"]
];
const raceConstraints = [
  ["league_match_format_templates", "league_match_format_race_to_valid"],
  ["match_format_snapshots", "match_format_snapshot_race_to_valid"]
];
const raceTriggers = [
  ["league_match_format_templates", "league_match_format_race_target_required"],
  ["match_format_snapshots", "match_format_snapshot_race_target_required"],
  ["league_match_format_templates", "league_match_format_race_count"],
  ["league_match_format_template_frames", "league_match_format_template_frames_race_count"],
  ["match_format_snapshots", "match_format_snapshot_race_count"],
  ["match_format_snapshot_frames", "match_format_snapshot_frames_race_count"],
  ["match_format_snapshots", "match_format_snapshot_race_target_matches_template"],
  ["match_frames", "match_frames_final_race_winner"]
];
const lifecycleTriggers = [
  ["matches", "matches_state_transition"],
  ["match_frames", "match_frames_validate_completion"],
  ["match_frames", "match_frames_all_complete"],
  ["match_dispute_resolutions", "match_dispute_resolutions_validate"]
];
const raceFunctions = [
  "breakdish_require_new_race_target",
  "breakdish_validate_race_frame_count",
  "breakdish_validate_snapshot_race_target",
  "breakdish_match_state_transition",
  "breakdish_auto_await_confirmation",
  "breakdish_resolve_dispute",
  "breakdish_race_match_remains_won"
];
const newlyIntroducedRaceFunctions = [
  "breakdish_require_new_race_target",
  "breakdish_validate_race_frame_count",
  "breakdish_validate_snapshot_race_target",
  "breakdish_race_match_remains_won"
];
const migrationOwnedRelations = [
  "league_match_format_templates",
  "league_match_format_template_frames",
  "match_format_snapshots",
  "match_format_snapshot_frames",
  "match_frames"
];
const migrationOwnedFunctions = [
  "breakdish_match_state_transition",
  "breakdish_auto_await_confirmation",
  "breakdish_resolve_dispute"
];
const localTestDatabases = new Set([
  "breakdish_pre013_test",
  "breakdish_post013_test",
  "breakdish_wrongstate_test"
]);
const verifierSourceFiles = new Set([
  "db-view-permissions-verifier.mjs",
  "verify-db-view-permissions-pre013.mjs",
  "verify-db-view-permissions-post013.mjs"
]);

export function expectedMigrations(phase) {
  if (phase === "pre013") return pre013MigrationNames;
  if (phase === "post013") return migrationNames;
  throw new TypeError("Invalid migration verification phase.");
}
export function compareMigrationHistory(actualNames, phase) {
  const expected = expectedMigrations(phase);
  return compareApplicationMigrationHistory(actualNames, expected);
}
export function evaluateVerificationChecks({
  phase,
  baselineValid,
  migration012Valid,
  migration013Valid,
  lifecycleTriggersValid,
  apiRoleExists,
  viewPermissionsComplete,
  tlsValid,
  readOnly,
  migrationRoleCanApply013
}) {
  const checks = {
    migrationHistory: baselineValid,
    migration012Schema: migration012Valid,
    migration013State: migration013Valid,
    lifecycleTriggers: lifecycleTriggersValid,
    apiRoleExists,
    apiViewPermissions: viewPermissionsComplete,
    tls: tlsValid,
    transactionReadOnly: readOnly
  };
  if (phase === "pre013") checks.migrationRoleCanApply013 = migrationRoleCanApply013;
  const failedChecks = Object.entries(checks)
    .filter(([, passed]) => passed !== true)
    .map(([name]) => name);
  return { checks, failedChecks, success: failedChecks.length === 0 };
}

export function raceColumnPrivilegesComplete(rows) {
  const row = rows?.[0];
  return Boolean(row &&
    row.template_select && row.template_insert &&
    row.snapshot_select && row.snapshot_insert && row.snapshot_update);
}

export function raceToColumnPermissionSummary(phase, apiRoleExists, columnsPresent, rows = []) {
  if (phase === "pre013") {
    return { raceToColumnPrivileges: null, raceToColumnPrivilegesComplete: null };
  }
  if (phase !== "post013") throw new TypeError("Invalid migration verification phase.");
  const privileges = apiRoleExists && columnsPresent ? rows : [];
  return {
    raceToColumnPrivileges: privileges,
    raceToColumnPrivilegesComplete: apiRoleExists && raceColumnPrivilegesComplete(privileges)
  };
}

export function raceFormatColumnsMatch(rows) {
  return rows?.length === raceColumns.length && raceColumns.every(([table, column]) => {
    const row = rows.find((item) => item.table_name === table && item.column_name === column);
    return row?.data_type === "smallint" && row.is_nullable === "YES" && row.column_default === null;
  });
}

export function raceFormatConstraintsMatch(rows) {
  return rows?.length === raceConstraints.length && raceConstraints.every(([table, name]) => {
    const row = rows.find((item) => item.conname === name);
    const definition = String(row?.definition || "").toLowerCase();
    const rangeMatches = /race_to\s+between\s+1\s+and\s+250/.test(definition) ||
      /race_to\s*>=\s*1[\s\S]*race_to\s*<=\s*250/.test(definition);
    return row?.contype === "c" && row.convalidated === true && row.table_name === table &&
      definition.includes("race_to") && definition.includes("is null") && rangeMatches;
  });
}

export function raceFormatTriggersMatch(rows) {
  return rows?.length === raceTriggers.length && raceTriggers.every(([table, name]) => {
    const row = rows.find((item) => item.trigger_name === name);
    return row?.schema_name === "public" && row.table_name === table && ["O", "A"].includes(row.tgenabled);
  });
}

export function matchLifecycleTriggersMatch(rows) {
  return rows?.length === lifecycleTriggers.length && lifecycleTriggers.every(([table, name]) => {
    const row = rows.find((item) => item.trigger_name === name);
    return row?.schema_name === "public" && row.table_name === table && ["O", "A"].includes(row.tgenabled);
  });
}

export function raceFormatFunctionsMatch(rows) {
  return rows?.length === raceFunctions.length && raceFunctions.every((name) => {
    const row = rows.find((item) => item.function_name === name);
    return typeof row?.source === "string" && row.source.toLowerCase().includes("race_to");
  });
}

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

export function safeUndefinedReferenceName(error) {
  if (error?.name !== "ReferenceError" || typeof error.message !== "string") return null;
  return /^([A-Za-z_$][\w$]*) is not defined$/.exec(error.message)?.[1] ?? null;
}

export function safeReferenceLocation(error) {
  if (error?.name !== "ReferenceError" || typeof error.stack !== "string") {
    return { sourceFile: null, sourceFunction: null, sourceLine: null };
  }
  for (const frame of error.stack.split(/\r?\n/).slice(1)) {
    const trimmed = frame.trim();
    if (!trimmed.startsWith("at ")) continue;
    const call = trimmed.slice(3);
    const open = call.indexOf(" (");
    const sourceFunction = open > 0 ? call.slice(0, open).replace(/^async\s+/, "") : null;
    const location = open > 0 ? call.slice(open + 2).replace(/\)$/, "") : call;
    const match = /^(.*):([0-9]+):[0-9]+$/.exec(location);
    if (!match) continue;
    const sourceFile = match[1].replace(/^file:\/\/\/?/i, "").split(/[\\/]/).at(-1);
    const sourceLine = Number(match[2]);
    if (!verifierSourceFiles.has(sourceFile) || !Number.isSafeInteger(sourceLine) || sourceLine < 1) continue;
    return {
      sourceFile,
      sourceFunction: sourceFunction && /^[A-Za-z_$][\w$]*$/.test(sourceFunction) ? sourceFunction : null,
      sourceLine
    };
  }
  return { sourceFile: null, sourceFunction: null, sourceLine: null };
}

function safeError(category, error = null, stage = null) {
  const code = typeof error?.code === "string" && /^[0-9A-Z]{5}$/.test(error.code) ? error.code : null;
  const errorKind = typeof error?.name === "string" && /^[A-Za-z]+Error$/.test(error.name) ? error.name : null;
  const source = safeReferenceLocation(error);
  console.log(JSON.stringify({
    success: false,
    failureStage: stage,
    failureCategory: category,
    errorCode: code,
    errorKind,
    undefinedReference: safeUndefinedReferenceName(error),
    sourceFile: source.sourceFile,
    sourceFunction: source.sourceFunction,
    sourceLine: source.sourceLine
  }));
  process.exitCode = 1;
}

function parseTarget(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  let databaseName;
  try {
    databaseName = decodeURIComponent(url.pathname.replace(/^\/+|\/+$/g, ""));
  } catch {
    return null;
  }
  const local = process.env.NODE_ENV === "test" &&
    ["localhost", "127.0.0.1", "::1"].includes(url.hostname) && localTestDatabases.has(databaseName);
  const render = url.hostname.toLowerCase().endsWith(".render.com") && databaseName === "breakdish";
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

export async function collectSummary(client, setStage = () => {}) {
  setStage("data-summary-match-records");
  const records = await client.query(`
    SELECT
      (SELECT count(*)::text FROM public.matches) AS matches,
      (SELECT count(*)::text FROM public.match_frames) AS frames,
      (SELECT count(*)::text FROM public.match_frame_events) AS frame_events,
      (SELECT count(*)::text FROM public.match_audit_events) AS audit_events
  `);
  setStage("data-summary-practice-statistics");
  const practice = await client.query(`
    SELECT
      (SELECT coalesce(sum(matches_played), 0)::text FROM public.practice_player_statistics) AS practice_matches_played,
      (SELECT coalesce(sum(frames_played), 0)::text FROM public.practice_player_statistics) AS practice_frames_played,
      (SELECT coalesce(sum(dishes), 0)::text FROM public.practice_player_statistics) AS practice_dishes,
      (SELECT coalesce(sum(counter_dishes), 0)::text FROM public.practice_player_statistics) AS practice_counter_dishes
  `);
  setStage("data-summary-competitive-statistics");
  const competitive = await client.query(`
    SELECT
      (SELECT coalesce(sum(matches_played), 0)::text FROM public.official_competitive_player_statistics) AS official_matches_played,
      (SELECT coalesce(sum(frames_played), 0)::text FROM public.official_competitive_player_statistics) AS official_frames_played,
      (SELECT coalesce(sum(dishes), 0)::text FROM public.official_competitive_player_statistics) AS official_dishes,
      (SELECT coalesce(sum(counter_dishes), 0)::text FROM public.official_competitive_player_statistics) AS official_counter_dishes
  `);
  return { ...records.rows[0], ...practice.rows[0], ...competitive.rows[0] };
}

async function inspectMigration012(client) {
  const matchColumns = await client.query(`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'matches'
      AND column_name IN ('test_only', 'test_request_key')
  `);
  const testOnlyColumn = matchColumns.rows.find((row) => row.column_name === "test_only");
  const requestKeyColumn = matchColumns.rows.find((row) => row.column_name === "test_request_key");
  const has012Columns = testOnlyColumn?.data_type === "boolean" &&
    testOnlyColumn.is_nullable === "NO" && /false/i.test(testOnlyColumn.column_default || "") &&
    requestKeyColumn?.data_type === "uuid" && requestKeyColumn.is_nullable === "YES";

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
  const flags = objects.rows[0];
  const migrationObjectsValid = flags.constraints_valid && flags.unique_index_valid &&
    flags.guard_trigger_enabled && flags.guard_function_exists;
  const definitions = await client.query(`
    SELECT c.relname AS view_name, pg_get_viewdef(c.oid, true) AS definition
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'v' AND c.relname = ANY($1::text[])
  `, [viewNames]);
  const byName = new Map(definitions.rows.map((row) => [row.view_name, row.definition.toLowerCase()]));
  const viewDefinitionsValid = byName.size === viewNames.length &&
    byName.get("match_scoreboard")?.includes("test_only") === true &&
    /\btest_only\s*=\s*false\b/.test(byName.get("match_player_statistics") || "") &&
    byName.get("practice_player_statistics")?.includes("match_player_statistics") === true &&
    byName.get("official_competitive_player_statistics")?.includes("match_player_statistics") === true;
  return { has012Columns, migrationObjectsValid, viewDefinitionsValid };
}

async function inspectRaceSchema(client, phase) {
  const columns = await client.query(`
    SELECT table_name, column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND
      ((table_name = 'league_match_format_templates' AND column_name = 'race_to') OR
       (table_name = 'match_format_snapshots' AND column_name = 'race_to'))
  `);
  const expectedColumnSet = new Set(raceColumns.map(([table, column]) => `${table}.${column}`));
  const actualColumnSet = new Set(columns.rows.map((row) => `${row.table_name}.${row.column_name}`));
  const columnsPresent = raceFormatColumnsMatch(columns.rows);
  const columnsAbsent = [...expectedColumnSet].every((key) => !actualColumnSet.has(key));

  const constraints = await client.query(`
    SELECT k.conname, k.contype, k.convalidated, c.relname AS table_name,
      pg_get_constraintdef(k.oid, true) AS definition
    FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
    WHERE (k.conrelid = 'public.league_match_format_templates'::regclass AND k.conname = $1) OR
      (k.conrelid = 'public.match_format_snapshots'::regclass AND k.conname = $2)
  `, raceConstraints.map(([, name]) => name));
  const constraintsValid = raceFormatConstraintsMatch(constraints.rows);

  const triggers = await client.query(`
    SELECT t.tgname AS trigger_name, t.tgenabled, n.nspname AS schema_name, c.relname AS table_name
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT t.tgisinternal AND t.tgname = ANY($1::text[])
  `, [raceTriggers.map(([, name]) => name)]);
  const triggersValid = raceFormatTriggersMatch(triggers.rows);

  const lifecycleTriggerRows = await client.query(`
    SELECT t.tgname AS trigger_name, t.tgenabled, n.nspname AS schema_name, c.relname AS table_name
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT t.tgisinternal AND t.tgname = ANY($1::text[])
  `, [lifecycleTriggers.map(([, name]) => name)]);
  const lifecycleTriggersValid = matchLifecycleTriggersMatch(lifecycleTriggerRows.rows);

  const functions = await client.query(`
    SELECT p.proname AS function_name, p.prosrc AS source
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = ANY($1::text[])
  `, [raceFunctions]);
  const functionsValid = raceFormatFunctionsMatch(functions.rows);

  const newFunctions = await client.query(`
    SELECT count(*)::integer AS count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = ANY($1::text[])
  `, [newlyIntroducedRaceFunctions]);
  const raceObjectsAbsent = columnsAbsent && constraints.rows.length === 0 && triggers.rows.length === 0 &&
    newFunctions.rows[0].count === 0;

  if (phase === "pre013") return {
    columnsPresent: columns.rows.length > 0,
    columnsAbsent,
    constraintsValid: false,
    triggersValid: false,
    lifecycleTriggersValid,
    functionsValid: false,
    raceObjectsAbsent
  };
  return {
    columnsPresent,
    columnsAbsent,
    constraintsValid,
    triggersValid,
    lifecycleTriggersValid,
    functionsValid,
    raceObjectsAbsent: false
  };
}

async function inspectApiColumnPrivileges(client, apiRole) {
  const result = await client.query(`
    SELECT
      has_column_privilege($1::text, 'public.league_match_format_templates', 'race_to', 'SELECT') AS template_select,
      has_column_privilege($1::text, 'public.league_match_format_templates', 'race_to', 'INSERT') AS template_insert,
      has_column_privilege($1::text, 'public.match_format_snapshots', 'race_to', 'SELECT') AS snapshot_select,
      has_column_privilege($1::text, 'public.match_format_snapshots', 'race_to', 'INSERT') AS snapshot_insert,
      has_column_privilege($1::text, 'public.match_format_snapshots', 'race_to', 'UPDATE') AS snapshot_update
  `, [apiRole]);
  return result.rows;
}

async function inspectMigrationRole(client) {
  const result = await client.query(`
    SELECT
      coalesce((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) AS is_superuser,
      has_schema_privilege(current_user, 'public', 'USAGE') AS schema_usage,
      has_schema_privilege(current_user, 'public', 'CREATE') AS schema_create,
      has_table_privilege(current_user, 'public.breakdish_app_migrations', 'INSERT') AS can_record_migration,
      coalesce((
        SELECT count(*) = cardinality($1::text[]) AND bool_and(pg_has_role(current_user, c.relowner, 'USAGE'))
        FROM unnest($1::text[]) AS required(name)
        JOIN pg_class c ON c.relname = required.name
        JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      ), false) AS owns_all_relations,
      coalesce((
        SELECT count(*) = cardinality($2::text[]) AND bool_and(pg_has_role(current_user, p.proowner, 'USAGE'))
        FROM unnest($2::text[]) AS required(name)
        JOIN pg_proc p ON p.proname = required.name
        JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
      ), false) AS owns_replaced_functions
  `, [migrationOwnedRelations, migrationOwnedFunctions]);
  const role = result.rows[0];
  const checks = {
    schemaUsage: role.schema_usage === true,
    schemaCreate: role.schema_create === true,
    canRecordMigration: role.can_record_migration === true,
    ownsAllRelations: role.owns_all_relations === true,
    ownsReplacedFunctions: role.owns_replaced_functions === true
  };
  const isSuperuser = role.is_superuser === true;
  return {
    isSuperuser,
    checks,
    canApply013: isSuperuser || Object.values(checks).every(Boolean)
  };
}

async function inspectViewPermissions(client, apiRole, apiRoleExists) {
  const views = await client.query(`
    SELECT c.relname AS view_name,
      CASE WHEN $1 THEN has_table_privilege($2::text, c.oid, 'SELECT') ELSE false END AS api_role_can_select,
      EXISTS (
        SELECT 1 FROM aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
        WHERE acl.grantee = 0 AND acl.privilege_type = 'SELECT'
      ) AS public_role_can_select
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'v' AND c.relname = ANY($3::text[])
    ORDER BY c.relname
  `, [apiRoleExists, apiRole, viewNames]);
  return viewNames.map((name) => {
    const row = views.rows.find((item) => item.view_name === name);
    return {
      view: name,
      apiRoleCanSelect: row?.api_role_can_select === true,
      publicRoleCanSelect: row?.public_role_can_select === true
    };
  });
}

export async function verifyViewPermissions(phase) {
  if (phase !== "pre013" && phase !== "post013") return safeError("input", null, phase);
  const rawUrl = process.env.DATABASE_URL;
  const apiRole = process.env.API_DATABASE_ROLE?.trim();
  if (!rawUrl || !apiRole || apiRole.length > 63 || /[\u0000-\u001f\u007f]/.test(apiRole)) {
    return safeError("input", null, phase);
  }
  const target = parseTarget(rawUrl);
  if (!target) return safeError("target", null, phase);

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
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
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
      return safeError("target", null, "database-identity");
    }

    stage = "migration-history";
    const migrations = await client.query(
      "SELECT name FROM public.breakdish_app_migrations ORDER BY run_on, name"
    );
    const actualNames = migrations.rows.map((row) => row.name);
    const history = compareMigrationHistory(actualNames, phase);

    stage = "api-role";
    const apiRoleExists = (await client.query(
      "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists",
      [apiRole]
    )).rows[0].exists;

    stage = "view-permissions";
    const viewPermissions = await inspectViewPermissions(client, apiRole, apiRoleExists);
    const viewPermissionsComplete = apiRoleExists && viewPermissions.length === viewNames.length &&
      viewPermissions.every((item) => item.apiRoleCanSelect && !item.publicRoleCanSelect);

    stage = "migration-role-permissions";
    const migrationRole = await inspectMigrationRole(client);

    stage = "migration-012-schema";
    const migration012 = await inspectMigration012(client);

    stage = "migration-013-schema";
    const raceSchema = await inspectRaceSchema(client, phase);
    let raceColumnPrivilegeRows = [];
    if (phase === "post013") {
      stage = "race-to-column-permissions";
      raceColumnPrivilegeRows = apiRoleExists && raceSchema.columnsPresent
        ? await inspectApiColumnPrivileges(client, apiRole) : [];
    }
    const raceToColumnPermissionFields = raceToColumnPermissionSummary(
      phase, apiRoleExists, raceSchema.columnsPresent, raceColumnPrivilegeRows
    );

    stage = "data-summary";
    const summary = await collectSummary(client, (summaryStage) => { stage = summaryStage; });
    await client.query("ROLLBACK");
    transactionStarted = false;

    const tlsValid = target.local ? identity.tls_enabled === false : identity.tls_enabled === true;
    const readOnly = identity.read_only === "on";
    const baselineValid = history.migrationHistoryMatches && history.migration012Applied &&
      (phase === "pre013" ? !history.migration013Applied : history.migration013Applied);
    const migration012Valid = migration012.has012Columns && migration012.migrationObjectsValid && migration012.viewDefinitionsValid;
    const migration013Valid = phase === "pre013"
      ? raceSchema.columnsAbsent && raceSchema.raceObjectsAbsent && migrationRole.canApply013
      : raceSchema.columnsPresent && raceSchema.constraintsValid && raceSchema.triggersValid &&
        raceSchema.functionsValid && raceToColumnPermissionFields.raceToColumnPrivilegesComplete;
    const verification = evaluateVerificationChecks({
      phase,
      baselineValid,
      migration012Valid,
      migration013Valid,
      lifecycleTriggersValid: raceSchema.lifecycleTriggersValid,
      apiRoleExists,
      viewPermissionsComplete,
      tlsValid,
      readOnly,
      migrationRoleCanApply013: migrationRole.canApply013
    });
    stage = "verification-result-assembly";
    const result = {
      success: verification.success,
      phase,
      failedChecks: verification.failedChecks,
      checks: verification.checks,
      database: identity.database_name,
      postgresVersion: identity.postgres_version,
      tlsEnabled: identity.tls_enabled === true,
      readOnly,
      migrationCount: actualNames.length,
      migrationHistoryMatches: history.migrationHistoryMatches,
      missingMigrations: history.missingMigrations,
      unexpectedMigrations: history.unexpectedMigrations,
      migration012Applied: history.migration012Applied,
      migration013Applied: history.migration013Applied,
      apiRoleConfigured: true,
      apiRoleExists,
      migrationRoleIsApiRole: identity.migration_role_is_api_role === true,
      migrationRoleIsSuperuser: migrationRole.isSuperuser,
      migrationRoleCanApply013: migrationRole.canApply013,
      migrationRoleChecks: phase === "pre013" ? migrationRole.checks : null,
      viewPermissions,
      migration012SchemaValid: migration012Valid,
      raceToColumnsPresent: raceSchema.columnsPresent,
      raceToColumnsAbsent: raceSchema.columnsAbsent,
      raceToConstraintsValid: raceSchema.constraintsValid,
      raceToTriggersValid: raceSchema.triggersValid,
      matchLifecycleTriggersValid: raceSchema.lifecycleTriggersValid,
      raceToFunctionsValid: raceSchema.functionsValid,
      raceToObjectsAbsent: raceSchema.raceObjectsAbsent,
      ...raceToColumnPermissionFields,
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
