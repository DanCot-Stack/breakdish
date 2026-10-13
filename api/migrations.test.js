import test from "node:test";
import assert from "node:assert/strict";
import * as initialMigration from "./migrations/001_initial_profiles_and_leagues.js";
import * as workflowMigration from "./migrations/002_league_membership_workflow.js";
import * as competitionMigration from "./migrations/003_seasons_divisions_teams.js";
import * as signingMigration from "./migrations/004_auditable_team_signings.js";
import * as signingHistoryMigration from "./migrations/005_protect_registration_history.js";
import * as signingStartMigration from "./migrations/006_require_official_start_for_signings.js";

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
