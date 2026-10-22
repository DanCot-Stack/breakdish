import test from "node:test";
import assert from "node:assert/strict";
import {
  compareMigrationHistory,
  collectSummary,
  evaluateVerificationChecks,
  expectedMigrations,
  matchLifecycleTriggersMatch,
  raceColumnPrivilegesComplete,
  raceToColumnPermissionSummary,
  raceFormatColumnsMatch,
  raceFormatConstraintsMatch,
  raceFormatFunctionsMatch,
  raceFormatTriggersMatch,
  safeReferenceLocation,
  safeUndefinedReferenceName
} from "./db-view-permissions-verifier.mjs";
import { readFile } from "node:fs/promises";
import {
  APPLICATION_MIGRATIONS_001_012,
  APPLICATION_MIGRATIONS_001_013
} from "./release-migration-baseline.mjs";

const appliedThrough012 = expectedMigrations("pre013");
const appliedThrough013 = expectedMigrations("post013");

test("migration 013 preflight requires exactly the verified 001–012 baseline", () => {
  assert.deepEqual(appliedThrough012, APPLICATION_MIGRATIONS_001_012);
  assert.equal(appliedThrough012.length, 12);
  assert.equal(appliedThrough012.at(-1), "012_test_only_practice_matches");
  assert.deepEqual(compareMigrationHistory(appliedThrough012, "pre013"), {
    migrationHistoryMatches: true,
    missingMigrations: [],
    unexpectedMigrations: [],
    migration012Applied: true,
    migration013Applied: false
  });
});

test("migration 013 post-check requires exactly migrations 001–013", () => {
  assert.deepEqual(appliedThrough013, APPLICATION_MIGRATIONS_001_013);
  assert.equal(appliedThrough013.length, 13);
  assert.equal(appliedThrough013.at(-1), "013_race_to_match_formats");
  assert.deepEqual(compareMigrationHistory(appliedThrough013, "post013"), {
    migrationHistoryMatches: true,
    missingMigrations: [],
    unexpectedMigrations: [],
    migration012Applied: true,
    migration013Applied: true
  });
});

test("preflight rejects migration 013 already applied, skipped history, and unexpected entries", () => {
  const premature = compareMigrationHistory(appliedThrough013, "pre013");
  assert.equal(premature.migrationHistoryMatches, false);
  assert.deepEqual(premature.unexpectedMigrations, ["013_race_to_match_formats"]);
  assert.equal(premature.migration013Applied, true);

  const missing = compareMigrationHistory(appliedThrough012.slice(0, -1), "pre013");
  assert.equal(missing.migrationHistoryMatches, false);
  assert.deepEqual(missing.missingMigrations, ["012_test_only_practice_matches"]);

  const unexpected = compareMigrationHistory([...appliedThrough012, "099_unexpected"], "pre013");
  assert.equal(unexpected.migrationHistoryMatches, false);
  assert.deepEqual(unexpected.unexpectedMigrations, ["099_unexpected"]);
});

test("preflight identifies a migration-role permission failure without weakening other checks", () => {
  const common = {
    phase: "pre013",
    baselineValid: true,
    migration012Valid: true,
    migration013Valid: false,
    lifecycleTriggersValid: true,
    apiRoleExists: true,
    viewPermissionsComplete: true,
    tlsValid: true,
    readOnly: true
  };
  const rejected = evaluateVerificationChecks({ ...common, migrationRoleCanApply013: false });
  assert.equal(rejected.success, false);
  assert.deepEqual(rejected.failedChecks, ["migration013State", "migrationRoleCanApply013"]);

  const accepted = evaluateVerificationChecks({ ...common, migration013Valid: true, migrationRoleCanApply013: true });
  assert.equal(accepted.success, true);
  assert.deepEqual(accepted.failedChecks, []);
});

test("post-check does not depend on migration-role privileges", () => {
  const result = evaluateVerificationChecks({
    phase: "post013",
    baselineValid: true,
    migration012Valid: true,
    migration013Valid: true,
    lifecycleTriggersValid: true,
    apiRoleExists: true,
    viewPermissionsComplete: true,
    tlsValid: true,
    readOnly: true,
    migrationRoleCanApply013: false
  });
  assert.equal(result.success, true);
  assert.equal(Object.hasOwn(result.checks, "migrationRoleCanApply013"), false);
});

test("post-migration verification rejects missing migration 013", () => {
  const status = compareMigrationHistory(appliedThrough012, "post013");
  assert.equal(status.migrationHistoryMatches, false);
  assert.deepEqual(status.missingMigrations, ["013_race_to_match_formats"]);
  assert.equal(status.migration013Applied, false);
});

test("API race_to privilege check requires every query and write privilege", () => {
  assert.equal(raceColumnPrivilegesComplete([{
    template_select: true,
    template_insert: true,
    snapshot_select: true,
    snapshot_insert: true,
    snapshot_update: true
  }]), true);

  for (const missingPrivilege of [
    "template_select", "template_insert", "snapshot_select", "snapshot_insert", "snapshot_update"
  ]) {
    const permissions = {
      template_select: true,
      template_insert: true,
      snapshot_select: true,
      snapshot_insert: true,
      snapshot_update: true
    };
    permissions[missingPrivilege] = false;
    assert.equal(raceColumnPrivilegesComplete([permissions]), false, `${missingPrivilege} is required`);
  }
  assert.equal(raceColumnPrivilegesComplete([]), false);
  assert.equal(raceColumnPrivilegesComplete(null), false);
});

test("Race-to permission result fields handle both migration states without an unbound shorthand", async () => {
  const source = await readFile(new URL("./db-view-permissions-verifier.mjs", import.meta.url), "utf8");
  const pre013 = raceToColumnPermissionSummary("pre013", true, false);
  assert.deepEqual(pre013, {
    raceToColumnPrivileges: null,
    raceToColumnPrivilegesComplete: null
  });

  const grants = [{
    template_select: true,
    template_insert: true,
    snapshot_select: true,
    snapshot_insert: true,
    snapshot_update: true
  }];
  const post013 = raceToColumnPermissionSummary("post013", true, true, grants);
  assert.deepEqual(post013, {
    raceToColumnPrivileges: grants,
    raceToColumnPrivilegesComplete: true
  });
  assert.deepEqual(raceToColumnPermissionSummary("post013", true, false, grants), {
    raceToColumnPrivileges: [],
    raceToColumnPrivilegesComplete: false
  });
  assert.deepEqual(raceToColumnPermissionSummary("post013", false, true, grants), {
    raceToColumnPrivileges: [],
    raceToColumnPrivilegesComplete: false
  });
  assert.throws(() => raceToColumnPermissionSummary("unknown", true, true, grants), TypeError);

  assert.match(source, /\.\.\.raceToColumnPermissionFields/);
  assert.doesNotMatch(source, /^\s*raceToColumnPrivilegesComplete\s*,/m);
});

test("post-migration schema checks reject missing or weakened Race-to objects", () => {
  const columns = [
    { table_name: "league_match_format_templates", column_name: "race_to", data_type: "smallint", is_nullable: "YES", column_default: null },
    { table_name: "match_format_snapshots", column_name: "race_to", data_type: "smallint", is_nullable: "YES", column_default: null }
  ];
  assert.equal(raceFormatColumnsMatch(columns), true);
  assert.equal(raceFormatColumnsMatch([{ ...columns[0], data_type: "integer" }, columns[1]]), false);
  assert.equal(raceFormatColumnsMatch([{ ...columns[0], is_nullable: "NO" }, columns[1]]), false);

  const constraints = [
    { conname: "league_match_format_race_to_valid", table_name: "league_match_format_templates", contype: "c", convalidated: true, definition: "CHECK (((race_to IS NULL) OR ((race_to >= 1) AND (race_to <= 250))))" },
    { conname: "match_format_snapshot_race_to_valid", table_name: "match_format_snapshots", contype: "c", convalidated: true, definition: "CHECK (((race_to IS NULL) OR ((race_to >= 1) AND (race_to <= 250))))" }
  ];
  assert.equal(raceFormatConstraintsMatch(constraints), true);
  assert.equal(raceFormatConstraintsMatch([{ ...constraints[0], definition: "CHECK (race_to BETWEEN 1 AND 500)" }, constraints[1]]), false);
  assert.equal(raceFormatConstraintsMatch([{ ...constraints[0], convalidated: false }, constraints[1]]), false);

  const triggers = [
    ["league_match_format_templates", "league_match_format_race_target_required"],
    ["match_format_snapshots", "match_format_snapshot_race_target_required"],
    ["league_match_format_templates", "league_match_format_race_count"],
    ["league_match_format_template_frames", "league_match_format_template_frames_race_count"],
    ["match_format_snapshots", "match_format_snapshot_race_count"],
    ["match_format_snapshot_frames", "match_format_snapshot_frames_race_count"],
    ["match_format_snapshots", "match_format_snapshot_race_target_matches_template"],
    ["match_frames", "match_frames_final_race_winner"]
  ].map(([table_name, trigger_name]) => ({ table_name, trigger_name, schema_name: "public", tgenabled: "O" }));
  assert.equal(raceFormatTriggersMatch(triggers), true);
  assert.equal(raceFormatTriggersMatch(triggers.map((row, index) => index === 0 ? { ...row, tgenabled: "D" } : row)), false);
  assert.equal(raceFormatTriggersMatch(triggers.map((row, index) => index === 0 ? { ...row, table_name: "matches" } : row)), false);

  const functions = [
    "breakdish_require_new_race_target",
    "breakdish_validate_race_frame_count",
    "breakdish_validate_snapshot_race_target",
    "breakdish_match_state_transition",
    "breakdish_auto_await_confirmation",
    "breakdish_resolve_dispute",
    "breakdish_race_match_remains_won"
  ].map((function_name) => ({ function_name, source: "BEGIN -- race_to" }));
  assert.equal(raceFormatFunctionsMatch(functions), true);
  assert.equal(raceFormatFunctionsMatch(functions.map((row, index) => index === 0 ? { ...row, source: "BEGIN RETURN NULL; END" } : row)), false);

  const lifecycleTriggers = [
    ["matches", "matches_state_transition"],
    ["match_frames", "match_frames_validate_completion"],
    ["match_frames", "match_frames_all_complete"],
    ["match_dispute_resolutions", "match_dispute_resolutions_validate"]
  ].map(([table_name, trigger_name]) => ({ table_name, trigger_name, schema_name: "public", tgenabled: "O" }));
  assert.equal(matchLifecycleTriggersMatch(lifecycleTriggers), true);
  assert.equal(matchLifecycleTriggersMatch(lifecycleTriggers.map((row, index) => index === 2 ? { ...row, tgenabled: "D" } : row)), false);
});

test("permission verification is read-only and never returns the supplied API role name", async () => {
  const source = await readFile(new URL("./db-view-permissions-verifier.mjs", import.meta.url), "utf8");
  assert.match(source, /BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY/);
  assert.match(source, /ROLLBACK/);
  assert.match(source, /has_column_privilege\(\$1/);
  assert.match(source, /acl\.grantee = 0 AND acl\.privilege_type = 'SELECT'/);
  assert.match(source, /migrationRoleChecks: phase === "pre013" \? migrationRole\.checks : null/);
  assert.match(source, /failedChecks: verification\.failedChecks/);
  assert.doesNotMatch(source, /console\.log\([^\n]*apiRole/);
});

test("read-only verifier uses the shared 001–012 baseline and rejects migration 013", async () => {
  const source = await readFile(new URL("./verify-db-readonly.mjs", import.meta.url), "utf8");
  assert.match(source, /APPLICATION_MIGRATIONS_001_012/);
  assert.match(source, /migration013Applied/);
  assert.match(source, /migration013Applied\s*\|\|/);
  assert.match(source, /BEGIN READ ONLY/);
  assert.match(source, /ROLLBACK/);
  assert.match(source, /expectedViews/);
  assert.match(source, /missingViews/);
  for (const viewName of [
    "match_scoreboard", "match_player_statistics", "practice_player_statistics", "official_competitive_player_statistics"
  ]) assert.ok(source.includes(`"${viewName}"`), `baseline expects ${viewName}`);
});

test("local PostgreSQL harness separates verifier contracts and retains sanitized failure diagnostics", async () => {
  const source = await readFile(new URL("../tools/test-migration-runner-local.ps1", import.meta.url), "utf8");
  assert.match(source, /\[switch\]\s+\$ReleaseVerifierSummaryOnly/);
  assert.match(source, /release-verifier-summary-reproduction/);
  assert.match(source, /Targeted pre-013 verifier and competitive-statistics summary reproduction/);
  assert.match(source, /Targeted post-013 column privilege and summary verification/);
  assert.match(source, /\$ScriptName -eq "verify-db-readonly\.mjs"/);
  assert.match(source, /verify-db-view-permissions-pre013\.mjs/);
  assert.match(source, /verify-db-view-permissions-post013\.mjs/);
  assert.match(source, /releaseToolDiagnostic = \[ordered\]@\{/);
  assert.match(source, /migrationRoleChecks = if \(\$json\.PSObject\.Properties\.Name -contains "migrationRoleChecks"\)/);
  assert.match(source, /failedChecks = if \(\$json\.PSObject\.Properties\.Name -contains "failedChecks"\)/);
  assert.match(source, /failureCategory = if \(\$json\.PSObject\.Properties\.Name -contains "failureCategory"\)/);
  assert.match(source, /verifierErrorKind = if \(\$json\.PSObject\.Properties\.Name -contains "errorKind"\)/);
  assert.match(source, /verifierUndefinedReference = if \(\$json\.PSObject\.Properties\.Name -contains "undefinedReference"\)/);
  assert.match(source, /verifierSourceFile = if \(\$json\.PSObject\.Properties\.Name -contains "sourceFile"\)/);
  assert.match(source, /verifierSourceFunction = if \(\$json\.PSObject\.Properties\.Name -contains "sourceFunction"\)/);
  assert.match(source, /verifierSourceLine = if \(\$json\.PSObject\.Properties\.Name -contains "sourceLine"\)/);
  assert.match(source, /\$result\.StandardOutput\.Contains\(\$DatabaseUrl\)/);
  assert.match(source, /\$result\.StandardOutput\.Contains\(\$ApiRole\)/);
});

test("release-tools-only harness exercises release checks without running the application suite", async () => {
  const source = await readFile(new URL("../tools/test-migration-runner-local.ps1", import.meta.url), "utf8");
  const toolReadme = await readFile(new URL("../tools/README.md", import.meta.url), "utf8");
  const readonlyVerifier = await readFile(new URL("./verify-db-readonly.mjs", import.meta.url), "utf8");
  assert.match(source, /\[switch\]\s+\$ReleaseToolsOnly/);
  assert.match(source, /-ReleaseToolsOnly:\$ReleaseToolsOnly/);
  assert.match(source, /releaseToolsOnly = \[bool\] \$ReleaseToolsOnly/);
  assert.match(source, /Choose either the verifier summary probe or release-tools-only mode/);
  assert.match(source, /Reject missing migration 012 from the pre-013 read-only verifier/);
  assert.match(source, /Reject unexpected migration from the pre-013 read-only verifier/);
  assert.match(source, /Reject incomplete schema from the pre-013 read-only verifier/);
  assert.match(source, /Reject missing required view from the pre-013 read-only verifier/);
  assert.match(source, /Reject public access to a protected view/);
  assert.match(source, /Reject an incorrect Race-to constraint/);
  assert.match(source, /Reject a missing Race-to column/);
  assert.match(source, /migrationRoleIsApiRole -eq \$false/);
  assert.match(source, /Release-tools-only mode: application integration suite not rerun/);
  assert.match(source, /postgresql16-portable-binaries/);
  assert.match(toolReadme, /tools\/postgresql16\/pgsql\/bin/);
  assert.match(toolReadme, /untracked and out of commits/);
  assert.match(readonlyVerifier, /breakdish_verify_incomplete_test/);
});

test("local backup-helper checks cover archive, non-overwrite and sanitized failure cleanup", async () => {
  const harness = await readFile(new URL("../tools/test-migration-runner-local.ps1", import.meta.url), "utf8");
  const backup = await readFile(new URL("../tools/backup-production.ps1", import.meta.url), "utf8");
  assert.match(harness, /local-backup-helper-test/);
  assert.match(harness, /archiveVerified -ne \$true/);
  assert.match(harness, /existing file in its output root/);
  assert.match(harness, /safeCategory -ne "authentication"/);
  assert.match(harness, /failedOutputRemoved -ne \$true/);
  assert.match(backup, /breakdish_pgdump_backup_test/);
  assert.match(backup, /localTarget = .*breakdish_pgdump_backup_test/);
  assert.match(backup, /renderHostMatched/);
  assert.match(backup, /run-folder-unique/);
  assert.match(backup, /backup-file-unique/);
  assert.match(backup, /@\('--list'/);
  assert.match(backup, /Clear-BreakDishCredentialEnvironment/);
});

test("aggregate summary checks identify the failing data group without logging its rows", async () => {
  const source = await readFile(new URL("./db-view-permissions-verifier.mjs", import.meta.url), "utf8");
  assert.match(source, /setStage\("data-summary-match-records"\)/);
  assert.match(source, /setStage\("data-summary-practice-statistics"\)/);
  assert.match(source, /setStage\("data-summary-competitive-statistics"\)/);
  assert.match(source, /failureStage: stage/);
  assert.match(source, /undefinedReference/);
  assert.match(source, /\^\(\[A-Za-z_\$\]\[\\w\$\]\*\) is not defined\$/);
  assert.doesNotMatch(source, /console\.log\([^\n]*(summary\.rows|result\.rows)/);
});

test("aggregate summary uses separate safe counts and labels each read-only query group", async () => {
  const stages = [];
  const statements = [];
  const rows = [
    { matches: "0", frames: "0", frame_events: "0", audit_events: "0" },
    { practice_matches_played: "0", practice_frames_played: "0", practice_dishes: "0", practice_counter_dishes: "0" },
    { official_matches_played: "0", official_frames_played: "0", official_dishes: "0", official_counter_dishes: "0" }
  ];
  const summary = await collectSummary({
    async query(statement) {
      statements.push(statement);
      return { rows: [rows.shift()] };
    }
  }, (stage) => stages.push(stage));

  assert.deepEqual(stages, [
    "data-summary-match-records",
    "data-summary-practice-statistics",
    "data-summary-competitive-statistics"
  ]);
  assert.equal(statements.length, 3);
  assert.equal(summary.matches, "0");
  assert.equal(summary.practice_frames_played, "0");
  assert.equal(summary.official_frames_played, "0");
  assert.ok(statements.every((statement) => !/user_id|email|display_name|SELECT\s+\*/i.test(statement)));
});

test("aggregate summary propagates each query failure at its exact privacy-safe stage", async () => {
  const expectedStages = [
    "data-summary-match-records",
    "data-summary-practice-statistics",
    "data-summary-competitive-statistics"
  ];

  for (let failureIndex = 0; failureIndex < expectedStages.length; failureIndex += 1) {
    const stages = [];
    let queryNumber = 0;
    await assert.rejects(collectSummary({
      async query() {
        queryNumber += 1;
        if (queryNumber === failureIndex + 1) {
          const error = new Error("synthetic permission failure");
          error.code = "42501";
          throw error;
        }
        return { rows: [{}] };
      }
    }, (stage) => stages.push(stage)), { code: "42501" });
    assert.deepEqual(stages, expectedStages.slice(0, failureIndex + 1));
  }
});

test("ReferenceError diagnostics expose only a plain undefined identifier", async () => {
  const source = await readFile(new URL("./db-view-permissions-verifier.mjs", import.meta.url), "utf8");
  assert.match(source, /undefinedReference/);
  assert.match(source, /undefinedReference: safeUndefinedReferenceName\(error\)/);
  assert.match(source, /\^\(\[A-Za-z_\$\]\[\\w\$\]\*\) is not defined\$/);
  assert.doesNotMatch(source, /message:\s*error\.message|console\.log\([^\n]*error\.message/);
  assert.equal(safeUndefinedReferenceName(new ReferenceError("competitiveSummary is not defined")), "competitiveSummary");
  assert.equal(safeUndefinedReferenceName(new ReferenceError("connection-string is not defined")), null);
  assert.equal(safeUndefinedReferenceName(new Error("secret value is not defined")), null);
});

test("ReferenceError source diagnostics retain only verifier basename, function and line", () => {
  const error = new ReferenceError("officialSummary is not defined");
  error.stack = [
    "ReferenceError: officialSummary is not defined",
    "    at collectSummary (file:///C:/Users/private-user/project/api/db-view-permissions-verifier.mjs:237:19)",
    "    at async verifyViewPermissions (file:///C:/Users/private-user/project/api/db-view-permissions-verifier.mjs:530:21)"
  ].join("\n");
  assert.deepEqual(safeReferenceLocation(error), {
    sourceFile: "db-view-permissions-verifier.mjs",
    sourceFunction: "collectSummary",
    sourceLine: 237
  });
  assert.equal(JSON.stringify(safeReferenceLocation(error)).includes("private-user"), false);

  const external = new ReferenceError("badReference is not defined");
  external.stack = "ReferenceError: badReference is not defined\n    at run (file:///private/node_modules/dependency/index.mjs:10:1)";
  assert.deepEqual(safeReferenceLocation(external), {
    sourceFile: null,
    sourceFunction: null,
    sourceLine: null
  });
});
