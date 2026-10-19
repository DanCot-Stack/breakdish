import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { Client } from "pg";
import { fileURLToPath } from "node:url";
import {
  buildMigrationDatabaseConfig,
  parseMigrationCount,
  runApplicationMigrations
} from "./migrate.js";

function localTestDatabaseUrl(variableName) {
  const value = process.env[variableName];
  if (!value) return null;

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${variableName} must be a local PostgreSQL test URL.`);
  }
  const databaseName = decodeURIComponent(url.pathname.replace(/^\/+|\/+$/g, ""));
  if (!new Set(["postgres:", "postgresql:"]).has(url.protocol) ||
      !new Set(["localhost", "127.0.0.1", "::1"]).has(url.hostname) ||
      !databaseName.endsWith("_test")) {
    throw new Error(`${variableName} must target a local *_test database.`);
  }
  return value;
}

async function readMigrationState(databaseUrl, connectionConfig = { connectionString: databaseUrl }) {
  const client = new Client(connectionConfig);
  try {
    await client.connect();
    const state = await client.query(`
      SELECT current_database() AS database_name,
        (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls_enabled,
        to_regclass('public."user"') IS NOT NULL AS auth_user_exists,
        (SELECT count(*)::int FROM public.breakdish_app_migrations) AS migration_count,
        (SELECT array_agg(name ORDER BY run_on, id)
         FROM public.breakdish_app_migrations) AS migration_names
    `);
    return state.rows[0];
  } finally {
    await client.end().catch(() => {});
  }
}

async function readTestDatabasePreparation(databaseUrl) {
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    const state = await client.query(`
      SELECT current_database() AS database_name,
        to_regclass('public."user"') IS NOT NULL AS auth_user_exists,
        to_regclass('public.breakdish_app_migrations') IS NOT NULL AS application_migration_ledger_exists
    `);
    return state.rows[0];
  } finally {
    await client.end().catch(() => {});
  }
}

test("Render PostgreSQL connections enforce verified TLS and ignore URL SSL overrides", () => {
  const config = buildMigrationDatabaseConfig(
    "postgresql://example.render.com/breakdish?sslmode=disable&sslrootcert=%2Fprivate%2Fca.pem&sslcert=client.pem&sslkey=client.key&uselibpqcompat=true&application_name=breakdish-test"
  );
  const parsedUrl = new URL(config.connectionString);

  assert.deepEqual(config.ssl, { rejectUnauthorized: true });
  assert.equal(config.connectionTimeoutMillis, 10000);
  assert.equal(parsedUrl.searchParams.has("sslmode"), false);
  assert.equal(parsedUrl.searchParams.has("sslrootcert"), false);
  assert.equal(parsedUrl.searchParams.has("sslcert"), false);
  assert.equal(parsedUrl.searchParams.has("sslkey"), false);
  assert.equal(parsedUrl.searchParams.has("uselibpqcompat"), false);
  assert.equal(parsedUrl.searchParams.get("application_name"), "breakdish-test");
});

test("local PostgreSQL configuration preserves the supplied connection string", () => {
  const databaseUrl = "postgresql://localhost/breakdish_local";
  const config = buildMigrationDatabaseConfig(databaseUrl);

  assert.equal(config.connectionString, databaseUrl);
  assert.equal(Object.hasOwn(config, "ssl"), false);
  assert.equal(config.connectionTimeoutMillis, 10000);
});

test("migration count accepts only positive safe integers", () => {
  assert.equal(parseMigrationCount(undefined), undefined);
  assert.equal(parseMigrationCount("1"), 1);
  assert.equal(parseMigrationCount("12"), 12);
  for (const invalid of ["0", "-1", "1.5", "Infinity", "9007199254740992", ""]) {
    assert.equal(parseMigrationCount(invalid), null);
  }
});

const plainTestUrl = localTestDatabaseUrl("MIGRATION_RUNNER_PLAIN_TEST_DATABASE_URL");
const tlsTestUrl = localTestDatabaseUrl("MIGRATION_RUNNER_TLS_TEST_DATABASE_URL");
const untrustedCaFile = process.env.MIGRATION_RUNNER_UNTRUSTED_CA_FILE?.trim() || null;
const migrationScriptPath = fileURLToPath(new URL("./migrate.js", import.meta.url));
const apiDirectory = fileURLToPath(new URL(".", import.meta.url));

test("migration runner preserves local non-TLS compatibility and applies only the requested count", {
  skip: !plainTestUrl
}, async () => {
  const initial = await readTestDatabasePreparation(plainTestUrl);
  const expectedDatabaseName = decodeURIComponent(new URL(plainTestUrl).pathname.replace(/^\/+|\/+$/g, ""));
  assert.equal(initial.database_name, expectedDatabaseName);
  assert.equal(initial.auth_user_exists, true, "Better Auth migrations must prepare the referenced user table first.");
  assert.equal(initial.application_migration_ledger_exists, false,
    "The migration-count check must begin with all application migrations still pending.");

  await runApplicationMigrations({ databaseUrl: plainTestUrl, direction: "up", count: 1 });
  let state = await readMigrationState(plainTestUrl);
  assert.equal(state.tls_enabled, false);
  assert.equal(state.auth_user_exists, true);
  assert.equal(state.migration_count, 1);
  assert.deepEqual(state.migration_names, ["001_initial_profiles_and_leagues"]);

  await runApplicationMigrations({ databaseUrl: plainTestUrl, direction: "up", count: 1 });
  state = await readMigrationState(plainTestUrl);
  assert.equal(state.migration_count, 2);
  assert.deepEqual(state.migration_names, [
    "001_initial_profiles_and_leagues",
    "002_league_membership_workflow"
  ]);
});

test("migration runner connects over verified TLS when URL SSL options request plaintext", {
  skip: !tlsTestUrl
}, async () => {
  const initial = await readTestDatabasePreparation(tlsTestUrl);
  const expectedDatabaseName = decodeURIComponent(new URL(tlsTestUrl).pathname.replace(/^\/+|\/+$/g, ""));
  assert.equal(initial.database_name, expectedDatabaseName);
  assert.equal(initial.auth_user_exists, true, "Better Auth migrations must prepare the referenced user table first.");
  assert.equal(initial.application_migration_ledger_exists, false,
    "The TLS migration check must begin with all application migrations still pending.");

  const config = buildMigrationDatabaseConfig(tlsTestUrl, { forceRenderTls: true });
  const parsedUrl = new URL(config.connectionString);
  assert.equal(config.ssl.rejectUnauthorized, true);
  assert.equal(parsedUrl.searchParams.has("sslmode"), false);

  await runApplicationMigrations({
    databaseUrl: tlsTestUrl,
    direction: "up",
    count: 1,
    forceRenderTls: true
  });
  const state = await readMigrationState(tlsTestUrl, config);
  assert.equal(state.tls_enabled, true);
  assert.equal(state.auth_user_exists, true);
  assert.equal(state.migration_count, 1);
  assert.deepEqual(state.migration_names, ["001_initial_profiles_and_leagues"]);
});

test("migration runner rejects a TLS server signed by an untrusted certificate", {
  skip: !tlsTestUrl || !untrustedCaFile
}, () => {
  const childCode = `
    import { Client } from "pg";
    import { buildMigrationDatabaseConfig } from "./migrate.js";
    const client = new Client(buildMigrationDatabaseConfig(
      process.env.MIGRATION_RUNNER_TLS_TEST_DATABASE_URL,
      { forceRenderTls: true }
    ));
    try {
      await client.connect();
      await client.end();
      console.log(JSON.stringify({ rejected: false, category: "none" }));
      process.exitCode = 1;
    } catch (error) {
      const codes = [];
      let current = error;
      while (current && codes.length < 5) {
        if (typeof current.code === "string") codes.push(current.code);
        current = current.cause;
      }
      const tlsCodes = new Set([
        "CERT_HAS_EXPIRED",
        "CERT_UNTRUSTED",
        "DEPTH_ZERO_SELF_SIGNED_CERT",
        "ERR_TLS_CERT_ALTNAME_INVALID",
        "SELF_SIGNED_CERT_IN_CHAIN",
        "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
      ]);
      const rejected = codes.some((code) => tlsCodes.has(code));
      console.log(JSON.stringify({ rejected, category: rejected ? "tls" : "other" }));
      await client.end().catch(() => {});
      if (!rejected) process.exitCode = 1;
    }
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", childCode], {
    cwd: apiDirectory,
    encoding: "utf8",
    timeout: 15000,
    env: {
      ...process.env,
      NODE_EXTRA_CA_CERTS: untrustedCaFile
    }
  });

  assert.equal(child.error, undefined, "The untrusted-certificate check process must start.");
  assert.equal(child.status, 0, "The migration TLS configuration must reject an untrusted certificate.");
  assert.deepEqual(JSON.parse(child.stdout.trim()), { rejected: true, category: "tls" });
  assert.equal(child.stderr.trim(), "");
});

test("migration CLI reports connection failure without exposing URL credentials", () => {
  const sentinel = "synthetic-migration-secret-must-not-be-printed";
  const databaseUrl = `postgresql://synthetic:${encodeURIComponent(sentinel)}@127.0.0.1:1/breakdish_safe_failure_test`;
  const child = spawnSync(process.execPath, [migrationScriptPath, "up", "1"], {
    cwd: apiDirectory,
    encoding: "utf8",
    timeout: 15000,
    env: { ...process.env, DATABASE_URL: databaseUrl }
  });
  const output = `${child.stdout || ""}${child.stderr || ""}`;

  assert.equal(child.error, undefined, "The safe-failure check process must start.");
  assert.equal(child.status, 1, "The migration CLI must fail when its local database is unreachable.");
  assert.equal(
    output.trim(),
    "BREAK DISH application database migration failed.",
    "The migration CLI must return only its generic connection-failure message."
  );
  assert.equal(output.includes(sentinel), false, "Synthetic URL credentials must never be printed.");
  assert.equal(output.includes(databaseUrl), false, "The synthetic connection URL must never be printed.");
});
