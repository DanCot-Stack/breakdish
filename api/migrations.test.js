import test from "node:test";
import assert from "node:assert/strict";
import * as initialMigration from "./migrations/001_initial_profiles_and_leagues.js";
import * as workflowMigration from "./migrations/002_league_membership_workflow.js";
import * as competitionMigration from "./migrations/003_seasons_divisions_teams.js";
import * as signingMigration from "./migrations/004_auditable_team_signings.js";
import * as signingHistoryMigration from "./migrations/005_protect_registration_history.js";
import * as signingStartMigration from "./migrations/006_require_official_start_for_signings.js";
import * as matchClassificationMigration from "./migrations/007_match_categories_and_practice_stats.js";
import * as doublesLeagueSidesMigration from "./migrations/008_doubles_league_match_sides.js";
import * as fixtureRoundNumbersMigration from "./migrations/009_fixture_round_numbers.js";
import * as platformRolesMigration from "./migrations/010_platform_roles.js";
import * as backupSuperAdminMigration from "./migrations/011_backup_super_admin.js";
import * as testOnlyPracticeMatchesMigration from "./migrations/012_test_only_practice_matches.js";

test("initial schema migration defines profiles, league roles, statuses and automatic creator ownership", () => {
  const calls = [];
  const pgm = new Proxy({}, {
    get: (_target, operation) => (...args) => calls.push({ operation, args })
  });

  initialMigration.up(pgm);
  const createdTables = calls.filter(({ operation }) => operation === "createTable").map(({ args }) => args[0]);
  assert.deepEqual(createdTables, ["player_profiles", "leagues", "league_memberships"]);

  const constraints = calls.filter(({ operation }) => operation === "addConstraint");
  assert.ok(constraints.some(({ args }) => args[0] === "league_memberships" && args[2].check?.includes("'owner'")));
  assert.ok(constraints.some(({ args }) => args[0] === "league_memberships" && args[2].check?.includes("'pending'")));
  assert.ok(constraints.some(({ args }) => args[0] === "league_memberships" && args[2].unique?.includes("user_id")));

  const ownerGuard = calls.find(({ operation, args }) => operation === "createIndex" && args[2]?.name === "league_memberships_single_owner");
  assert.ok(ownerGuard);
  assert.equal(ownerGuard.args[2].unique, true);
  assert.equal(ownerGuard.args[2].where, "role = 'owner'");

  const ownerTrigger = calls.find(({ operation, args }) => operation === "sql" && /leagues_assign_owner_after_insert/.test(args[0]));
  assert.ok(ownerTrigger);
  assert.match(ownerTrigger.args[0], /NEW\.created_by, 'owner', 'active'/);

  const downCalls = [];
  initialMigration.down(new Proxy({}, {
    get: (_target, operation) => (...args) => downCalls.push({ operation, args })
  }));
  assert.deepEqual(downCalls.filter(({ operation }) => operation === "dropTable").map(({ args }) => args[0]), [
    "league_memberships", "leagues", "player_profiles"
  ]);
});

test("league workflow migration adds policy, decline state and active-owner guards without dropping data", () => {
  const calls = [];
  const pgm = new Proxy({}, {
    get: (_target, operation) => (...args) => calls.push({ operation, args })
  });

  workflowMigration.up(pgm);
  assert.ok(calls.some(({ operation, args }) => operation === "addColumn" &&
    args[0] === "leagues" && args[1].join_policy.default === "approval"));
  assert.ok(calls.some(({ operation, args }) => operation === "addConstraint" &&
    args[0] === "league_memberships" && args[2].check.includes("'declined'")));
  const sql = calls.filter(({ operation }) => operation === "sql").map(({ args }) => args[0]).join("\n");
  assert.match(sql, /league_memberships_preserve_active_owner/);
  assert.match(sql, /leagues_require_active_owner/);
  assert.match(sql, /Cannot install league owner protection/);

  const downCalls = [];
  workflowMigration.down(new Proxy({}, {
    get: (_target, operation) => (...args) => downCalls.push({ operation, args })
  }));
  assert.ok(downCalls.some(({ operation, args }) => operation === "dropColumn" && args[1] === "join_policy"));
  assert.ok(downCalls.some(({ operation, args }) => operation === "addConstraint" &&
    args[0] === "league_memberships" && !args[2].check.includes("'declined'")));
  assert.match(downCalls.find(({ operation }) => operation === "sql").args[0], /Cannot roll back.*declined memberships/);
});

test("competition migration creates historical seasons, optional divisions, season-scoped teams and eligible rosters", () => {
  const calls = [];
  competitionMigration.up(new Proxy({}, {
    get: (_target, operation) => (...args) => calls.push({ operation, args })
  }));
  const createdTables = calls.filter(({ operation }) => operation === "createTable").map(({ args }) => args[0]);
  assert.deepEqual(createdTables, ["seasons", "divisions", "teams", "team_memberships"]);
  assert.ok(calls.some(({ operation, args }) => operation === "addConstraint" &&
    args[0] === "seasons" && args[1] === "seasons_status_allowed"));
  assert.ok(calls.some(({ operation, args }) => operation === "addConstraint" &&
    args[0] === "team_memberships" && args[1] === "team_memberships_captain_active"));
  const sql = calls.filter(({ operation }) => operation === "sql").map(({ args }) => args[0]).join("\n");
  assert.match(sql, /seasons_status_transition_guard/);
  assert.match(sql, /draft.*active.*completed/s);
  const teamsTable = calls.find(({ operation, args }) => operation === "createTable" && args[0] === "teams");
  const teamForeignKeys = teamsTable.args[2].constraints.foreignKeys;
  assert.ok(teamForeignKeys.some(({ referencesConstraintName }) => referencesConstraintName === "teams_season_league_fk"));
  assert.ok(teamForeignKeys.some(({ referencesConstraintName }) => referencesConstraintName === "teams_division_season_fk"));
  assert.match(sql, /team_memberships_single_active_captain/);
  assert.match(sql, /team_member_active_league_membership/);
});

test("team signing migration backfills an auditable registration ledger and enforces signing rules", () => {
  const calls = [];
  signingMigration.up(new Proxy({}, {
    get: (_target, operation) => (...args) => calls.push({ operation, args })
  }));
  const createdTables = calls.filter(({ operation }) => operation === "createTable").map(({ args }) => args[0]);
  assert.deepEqual(createdTables, ["team_registrations", "team_registration_events"]);
  assert.ok(calls.some(({ operation, args }) => operation === "addConstraint" &&
    args[0] === "team_registrations" && args[1] === "team_registrations_dates_ordered"));
  const sql = calls.filter(({ operation }) => operation === "sql").map(({ args }) => args[0]).join("\n");
  assert.match(sql, /one_active_per_competition/);
  assert.match(sql, /team_poststart_signing_limit/);
  assert.match(sql, /NEW\.started_at := clock_timestamp\(\)/);
  assert.match(sql, /Original author and reason were not recorded/);
  assert.match(sql, /team_registration_events_append_only/);
  assert.match(sql, /season_start_date_frozen/);
  assert.match(sql, /status_changed_by/);
  assert.match(sql, /team_membership_registration_required/);
  const downCalls = [];
  signingMigration.down(new Proxy({}, {
    get: (_target, operation) => (...args) => downCalls.push({ operation, args })
  }));
  const downSql = downCalls.filter(({ operation }) => operation === "sql").map(({ args }) => args[0]).join("\n");
  assert.match(downSql, /Cannot roll back migration 004 while team registration history exists/);
});

test("registration history protection prevents deleting registration records", () => {
  const calls = [];
  signingHistoryMigration.up(new Proxy({}, {
    get: (_target, operation) => (...args) => calls.push({ operation, args })
  }));
  const sql = calls.filter(({ operation }) => operation === "sql").map(({ args }) => args[0]).join("\n");
  assert.match(sql, /BEFORE DELETE ON team_registrations/);
  assert.match(sql, /Team registration history cannot be deleted/);
});

test("team registrations require a frozen official season start date", () => {
  const calls = [];
  signingStartMigration.up(new Proxy({}, {
    get: (_target, operation) => (...args) => calls.push({ operation, args })
  }));
  const sql = calls.filter(({ operation }) => operation === "sql").map(({ args }) => args[0]).join("\n");
  assert.match(sql, /unfinished season has team registration history but no official start date/);
  assert.match(sql, /season_start_required_for_signing/);
  assert.match(sql, /BEFORE INSERT ON team_registrations/);
});

test("migration 007 defines auditable match formats, lifecycle, frame model, competition entries and separated statistics", () => {
  const upCalls = [];
  matchClassificationMigration.up(new Proxy({}, {
    get: (_target, operation) => (...args) => upCalls.push({ operation, args })
  }));
  const sql = upCalls.filter(({ operation }) => operation === "sql").map(({ args }) => args[0]).join("\n");

  for (const category of ["team_league", "singles_league", "doubles_league", "tournament_flyer", "money_match", "practice"]) {
    assert.ok(sql.includes(`'${category}'`), `missing match category ${category}`);
  }
  for (const table of [
    "tournament_events", "matches", "league_match_format_templates", "league_match_format_template_frames",
    "league_match_format_defaults", "match_format_snapshots", "match_format_snapshot_frames", "match_frames",
    "match_participants", "match_frame_players", "match_frame_events", "match_confirmations",
    "match_disputes", "match_dispute_resolutions", "competition_entries", "competition_entry_participants",
    "competition_entry_events", "money_match_terms", "money_match_acknowledgements", "match_audit_events"
  ]) assert.match(sql, new RegExp(`CREATE TABLE ${table}\\s*\\(`), `missing ${table}`);

  assert.match(sql, /is_official boolean GENERATED ALWAYS AS \(match_type <> 'practice'\) STORED/);
  assert.match(sql, /matches_identity_immutable/);
  assert.match(sql, /matches_status_transition/);
  assert.match(sql, /matches_format_snapshot_required/);
  assert.match(sql, /breakdish_auto_await_confirmation/);
  assert.match(sql, /matches_both_sides_confirmed/);
  assert.match(sql, /matches_no_open_dispute/);
  assert.match(sql, /max\(r\.created_at\) INTO latest_resolution/);
  assert.match(sql, /match_dispute_resolution_permission/);
  assert.match(sql, /match_snapshot_unplayed_only/);
  assert.match(sql, /match_participant_team_eligibility/);
  assert.match(sql, /match_frame_singles_slots/);
  assert.match(sql, /match_frame_doubles_slots/);
  assert.match(sql, /match_frame_full_doubles_bye/);
  assert.match(sql, /match_frame_no_partial_bye/);
  assert.match(sql, /match_frame_no_decoration_on_bye/);
  assert.match(sql, /match_audit_events_append_only/);
  assert.match(sql, /CREATE VIEW match_scoreboard AS/);
  assert.match(sql, /CREATE VIEW match_player_statistics AS/);
  assert.match(sql, /CREATE VIEW practice_player_statistics AS[\s\S]*WHERE match_type = 'practice'/);
  assert.match(sql, /practice_win_percentage/);
  assert.match(sql, /CREATE VIEW official_competitive_player_statistics AS[\s\S]*WHERE is_official/);
  assert.match(sql, /counter_dishes/);

  const downCalls = [];
  matchClassificationMigration.down(new Proxy({}, {
    get: (_target, operation) => (...args) => downCalls.push({ operation, args })
  }));
  const downSql = downCalls.filter(({ operation }) => operation === "sql").map(({ args }) => args[0]).join("\n");
  assert.match(downSql, /Cannot roll back migration 007 while match, event, template or entry history exists/);
  assert.match(downSql, /ALTER TABLE team_registrations DROP CONSTRAINT team_registrations_match_identity_unique/);
});

test("migration 008 links Doubles League match sides to approved entries and protects player snapshots", () => {
  const upCalls = [];
  doublesLeagueSidesMigration.up(new Proxy({}, {
    get: (_target, operation) => (...args) => upCalls.push({ operation, args })
  }));
  const sql = upCalls.filter(({ operation }) => operation === "sql").map(({ args }) => args[0]).join("\n");
  assert.match(sql, /CREATE TABLE match_doubles_league_sides/);
  assert.match(sql, /UNIQUE \(match_id, entry_id\)/);
  assert.match(sql, /entry_record\.entry_type <> 'doubles_league'/);
  assert.match(sql, /entry_record\.status <> 'approved'/);
  assert.match(sql, /entry_record\.league_id IS DISTINCT FROM match_record\.league_id/);
  assert.match(sql, /entry_record\.season_id IS DISTINCT FROM match_record\.season_id/);
  assert.match(sql, /roster_count <> 2/);
  assert.match(sql, /match_doubles_exactly_two_sides/);
  assert.match(sql, /match_doubles_exactly_two_participants_per_side/);
  assert.match(sql, /match_doubles_participants_immutable/);
  assert.match(sql, /competition_entry_doubles_identity_immutable/);
  assert.match(sql, /existing Doubles League matches before assigning entry sides/);

  const downCalls = [];
  doublesLeagueSidesMigration.down(new Proxy({}, {
    get: (_target, operation) => (...args) => downCalls.push({ operation, args })
  }));
  const downSql = downCalls.filter(({ operation }) => operation === "sql").map(({ args }) => args[0]).join("\n");
  assert.match(downSql, /Cannot roll back migration 008 while Doubles League fixture history exists/);
});

test("migration 009 adds optional positive league fixture round numbers without backfilling", () => {
  const upCalls = [];
  fixtureRoundNumbersMigration.up(new Proxy({}, {
    get: (_target, operation) => (...args) => upCalls.push({ operation, args })
  }));
  const upSql = upCalls.filter(({ operation }) => operation === "sql").map(({ args }) => args[0]).join("\n");
  assert.match(upSql, /ALTER TABLE matches ADD COLUMN round_number smallint/);
  assert.match(upSql, /round_number IS NULL OR/);
  assert.match(upSql, /round_number > 0/);
  assert.match(upSql, /match_type IN \('team_league', 'singles_league', 'doubles_league'\)/);
  assert.doesNotMatch(upSql, /UPDATE matches SET round_number/i, "Historical matches keep a null round number.");
  assert.match(upSql, /matches_league_round_lookup/);
  assert.match(upSql, /matches_round_number_immutable/);
  assert.match(upSql, /A fixture round number is immutable once recorded/);

  const downCalls = [];
  fixtureRoundNumbersMigration.down(new Proxy({}, {
    get: (_target, operation) => (...args) => downCalls.push({ operation, args })
  }));
  const downSql = downCalls.filter(({ operation }) => operation === "sql").map(({ args }) => args[0]).join("\n");
  assert.match(downSql, /Cannot roll back migration 009 while fixture round history exists/);
});

test("migration 010 separates current platform roles from append-only role history", () => {
  const upCalls = [];
  platformRolesMigration.up(new Proxy({}, {
    get: (_target, operation) => (...args) => upCalls.push({ operation, args })
  }));
  const tables = upCalls.filter(({ operation }) => operation === "createTable").map(({ args }) => args[0]);
  assert.deepEqual(tables, ["platform_roles", "platform_role_events"]);
  const indexes = upCalls.filter(({ operation }) => operation === "createIndex");
  assert.ok(indexes.some(({ args }) => args[0] === "platform_roles" && args[1] === "role" &&
    args[2].unique && args[2].where === "role = 'super_admin'"),
  "A partial unique index must prevent concurrent active Super Admin assignments.");
  const sql = upCalls.filter(({ operation }) => operation === "sql").map(({ args }) => args[0]).join("\n");
  assert.match(sql, /BEFORE UPDATE OR DELETE ON platform_role_events/);
  assert.match(sql, /BEFORE TRUNCATE ON platform_role_events/);
  assert.match(sql, /Platform role history is append-only/);
  const roleChecks = upCalls.filter(({ operation, args }) => operation === "addConstraint" && args[0] === "platform_role_events");
  assert.ok(roleChecks.some(({ args }) => args[2].check.includes("'bootstrap'")));
  assert.ok(roleChecks.some(({ args }) => args[2].check.includes("'grant'") && args[2].check.includes("'revoke'")));

  const downCalls = [];
  platformRolesMigration.down(new Proxy({}, {
    get: (_target, operation) => (...args) => downCalls.push({ operation, args })
  }));
  const downSql = downCalls.filter(({ operation }) => operation === "sql").map(({ args }) => args[0]).join("\n");
  assert.match(downSql, /Cannot roll back migration 010 while platform role assignments or history exist/);
});

test("migration 011 preserves the founder and enforces one auditable recovery Super Admin slot", () => {
  const upCalls = [];
  backupSuperAdminMigration.up(new Proxy({}, {
    get: (_target, operation) => (...args) => upCalls.push({ operation, args })
  }));
  assert.ok(upCalls.some(({ operation, args }) => operation === "addColumn" &&
    args[0] === "platform_roles" && args[1].assignment_type));
  assert.ok(upCalls.some(({ operation, args }) => operation === "addColumn" &&
    args[0] === "platform_role_events" && args[1].assignment_type));
  const allowedAssignmentType = upCalls.find(({ operation, args }) => operation === "addConstraint" &&
    args[0] === "platform_roles" && args[1] === "platform_roles_assignment_type_allowed");
  assert.match(allowedAssignmentType.args[2].check,
    /assignment_type IS NOT NULL AND assignment_type IN \('founder', 'recovery'\)/,
    "A Super Admin cannot use a NULL assignment slot that would evade PostgreSQL's unique index semantics.");
  assert.ok(upCalls.some(({ operation, args }) => operation === "sql" &&
    args[0].includes("UPDATE platform_roles SET assignment_type = 'founder'")),
  "The existing active Super Admin is migrated in place as founder.");
  const indexes = upCalls.filter(({ operation }) => operation === "createIndex");
  assert.ok(indexes.some(({ args }) => args[0] === "platform_roles" &&
    args[1].join(",") === "role,assignment_type" && args[2].unique &&
    args[2].where === "role = 'super_admin'"));
  const sql = upCalls.filter(({ operation }) => operation === "sql").map(({ args }) => args[0]).join("\n");
  assert.match(sql, /pg_advisory_xact_lock\(1363351362, 10\)/);
  assert.match(sql, /active_count <> 1 OR founder_count <> 1/);
  assert.match(sql, /NEW\.granted_by IS DISTINCT FROM founder_user_id/);
  assert.match(sql, /NEW\.assignment_type IS NULL OR NEW\.assignment_type NOT IN/,
    "The database trigger rejects unclassified Super Admin assignments before counting slots.");
  assert.match(sql, /platform_roles_super_admin_guard/);
  assert.match(sql, /platform_role_events_super_admin_guard/);
  assert.match(sql, /A Super Admin audit event must match an active assignment/);
  assert.match(sql, /DEFERRABLE INITIALLY DEFERRED/);
  assert.match(sql, /A Super Admin assignment requires its matching audit event/);
  assert.match(sql, /Super Admin removal requires a separately reviewed recovery procedure/);

  const downCalls = [];
  backupSuperAdminMigration.down(new Proxy({}, {
    get: (_target, operation) => (...args) => downCalls.push({ operation, args })
  }));
  const downSql = downCalls.filter(({ operation }) => operation === "sql").map(({ args }) => args[0]).join("\n");
  assert.match(downSql, /Cannot roll back migration 011 after a recovery Super Admin assignment has been recorded/);
  assert.match(downSql, /CREATE UNIQUE INDEX platform_roles_single_super_admin/);
});

test("migration 012 protects immutable Super Admin-only test Practice Matches and excludes them from statistics", () => {
  const upCalls = [];
  testOnlyPracticeMatchesMigration.up(new Proxy({}, {
    get: (_target, operation) => (...args) => upCalls.push({ operation, args })
  }));
  assert.ok(upCalls.some(({ operation, args }) => operation === "addColumn" && args[0] === "matches"
    && args[1].test_only?.default === false && args[1].test_only?.notNull === true),
  "Existing matches default to normal, non-test history.");
  assert.ok(upCalls.some(({ operation, args }) => operation === "addConstraint"
    && args[0] === "matches" && args[1] === "matches_test_only_practice_only"
    && args[2].check.includes("match_type = 'practice'")));
  assert.ok(upCalls.some(({ operation, args }) => operation === "createIndex"
    && args[0] === "matches" && args[2].unique && args[2].where === "test_only"),
  "Test request keys are unique to prevent concurrent or repeated duplicate test creation.");
  const upSql = upCalls.filter(({ operation }) => operation === "sql").map(({ args }) => args[0]).join("\n");
  assert.match(upSql, /role = 'super_admin'/);
  assert.match(upSql, /matches_test_only_immutable/);
  assert.match(upSql, /m\.test_only = false/);
  assert.match(upSql, /JOIN matches m ON m\.id = mp\.match_id AND m\.test_only = false/);
  assert.doesNotMatch(upSql, /\bDROP\s+VIEW\b/i,
    "Migration 012 must not drop views, because that would discard existing ownership and grants.");
  for (const view of [
    "match_scoreboard",
    "match_player_statistics",
    "practice_player_statistics",
    "official_competitive_player_statistics"
  ]) {
    assert.match(upSql, new RegExp(`CREATE OR REPLACE VIEW ${view} AS`),
      `${view} must be replaced in place so the API role's SELECT permissions survive.`);
  }
  assert.match(upSql, /CREATE OR REPLACE VIEW match_scoreboard AS[\s\S]*m\.test_only/);

  const downCalls = [];
  testOnlyPracticeMatchesMigration.down(new Proxy({}, {
    get: (_target, operation) => (...args) => downCalls.push({ operation, args })
  }));
  const downSql = downCalls.filter(({ operation }) => operation === "sql").map(({ args }) => args[0]).join("\n");
  assert.match(downSql, /Cannot roll back migration 012 while test-only match records exist/,
    "Rollback must retain test match records and their audit history.");
  assert.match(downSql, /CREATE VIEW match_scoreboard AS/);
});
