import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { runner } from "node-pg-migrate";
import { createPlatformRoleStore, PlatformRoleError } from "./platform-role-store.js";
import { verifyViewPermissions } from "./db-view-permissions-verifier.mjs";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

async function runLatestApplicationMigration(direction, count = 1) {
  await runner({
    databaseUrl: testDatabaseUrl,
    direction,
    count,
    dir: fileURLToPath(new URL("./migrations", import.meta.url)),
    migrationsTable: "breakdish_app_migrations",
    createSchema: false
  });
}

async function captureViewPermissionVerification(phase, apiRole) {
  const originalLog = console.log;
  const originalExitCode = process.exitCode;
  let output = "";
  process.env.API_DATABASE_ROLE = apiRole;
  console.log = (value) => { output = String(value); };
  try {
    await verifyViewPermissions(phase);
  } finally {
    console.log = originalLog;
    process.exitCode = originalExitCode;
  }
  assert.ok(output, `The ${phase} permission verifier must produce a result.`);
  return JSON.parse(output);
}

test("Better Auth, league management and the Match Engine use PostgreSQL", {
  skip: testDatabaseUrl ? false : "Set TEST_DATABASE_URL to a disposable local PostgreSQL database ending in _test."
}, async () => {
  if (!testDatabaseUrl) return;
  const databaseUrl = new URL(testDatabaseUrl);
  const databaseName = databaseUrl.pathname.replace(/^\//, "");
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(databaseUrl.hostname), "Integration tests must use local PostgreSQL.");
  assert.match(databaseName, /_test$/i, "Use a dedicated database whose name ends in _test.");

  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.BETTER_AUTH_URL = "http://localhost:3001";
  process.env.BETTER_AUTH_SECRET = "local-test-secret-that-is-never-used-outside-this-test-run";
  process.env.ALLOWED_ORIGINS = "http://localhost:5500,https://break-dish.com";
  process.env.NODE_ENV = "test";
  process.env.PORT = "0";
  delete process.env.RESEND_API_KEY;
  delete process.env.CONTACT_FROM_EMAIL;

  const [{ auth, database, closeAuthDatabase }, { start, shutDown }] = await Promise.all([
    import("./auth.js"),
    import("./server.js")
  ]);
  const platformRoles = createPlatformRoleStore(database);
  const server = await start({
    emailSender: { async sendContactEmail() {} },
    getAuthInstance: async () => auth,
    getPlatformRoleStore: async () => platformRoles
  });
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const testIp = `198.51.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;
  const fetchFromSite = (path, options = {}) => fetch(`${endpoint}${path}`, {
    ...options,
    headers: { origin: "http://localhost:5500", "x-forwarded-for": testIp, ...(options.headers || {}) }
  });
  const setCookiesFrom = (response) => response.headers.getSetCookie?.() || [];
  const cookieFrom = (response) => setCookiesFrom(response)
    .map((cookie) => cookie.split(";", 1)[0])
    .join("; ");
  let roleTestSignupOrdinal = 0;
  const originalApiDatabaseRole = process.env.API_DATABASE_ROLE;
  let migrationApiTestRole = null;
  let migrationApiTestRoleCreated = false;

  try {
    let corsPreflight = await fetch(`${endpoint}/api/platform/test-practice-matches`, {
      method: "OPTIONS",
      headers: {
        origin: "https://break-dish.com",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,idempotency-key"
      }
    });
    assert.equal(corsPreflight.status, 204);
    assert.equal(corsPreflight.headers.get("access-control-allow-origin"), "https://break-dish.com");
    assert.equal(corsPreflight.headers.get("access-control-allow-credentials"), "true");
    assert.ok(corsPreflight.headers.get("access-control-allow-methods").split(",").map((value) => value.trim()).includes("POST"));
    const corsHeaders = corsPreflight.headers.get("access-control-allow-headers").split(",").map((value) => value.trim().toLowerCase());
    assert.ok(corsHeaders.includes("content-type"));
    assert.ok(corsHeaders.includes("idempotency-key"));
    corsPreflight = await fetch(`${endpoint}/api/platform/test-practice-matches`, {
      method: "OPTIONS",
      headers: {
        origin: "https://not-break-dish.com",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,idempotency-key"
      }
    });
    assert.equal(corsPreflight.status, 403);
    assert.equal(corsPreflight.headers.get("access-control-allow-origin"), null);
    assert.equal(corsPreflight.headers.get("access-control-allow-credentials"), null);
    assert.equal(corsPreflight.headers.get("access-control-allow-headers"), null);

    const initialPlatformRoles = await database.query("SELECT count(*)::integer AS count FROM platform_roles");
    assert.equal(initialPlatformRoles.rows[0].count, 0, "A fresh database begins with no Super Admin or Platform Admin.");
    assert.equal(await platformRoles.isSuperAdmin("not-yet-registered"), false);

    const email = `test-${crypto.randomUUID()}@example.test`;
    let response = await fetchFromSite("/api/me");
    assert.equal(response.status, 401, "Anonymous requests must not receive an authenticated session.");
    response = await fetchFromSite("/api/me/profile");
    assert.equal(response.status, 401, "Anonymous users must not read a player profile.");
    response = await fetchFromSite("/api/me/profile", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Unauthorised" })
    });
    assert.equal(response.status, 401, "Anonymous users must not change a player profile.");

    response = await fetchFromSite("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Test Player", email, password: "correct-horse-battery-staple" })
    });
    assert.equal(response.status, 200, await response.clone().text());
    let cookie = cookieFrom(response);
    assert.ok(cookie, "Registration should establish a session in the no-email local test configuration.");

    response = await fetchFromSite("/api/me", { headers: { cookie } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).user.email, email);

    response = await fetchFromSite("/api/me/profile", { headers: { cookie } });
    assert.equal(response.status, 200);
    let profile = (await response.json()).profile;
    assert.equal(profile.userId, (await (await fetchFromSite("/api/me", { headers: { cookie } })).json()).user.id);
    assert.equal(profile.displayName, "Test Player");
    const firstUserId = profile.userId;

    response = await fetchFromSite("/api/me/profile", {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        userId: "another-users-id",
        displayName: "Alex Player",
        location: "Leeds",
        biography: "Weekend league player."
      })
    });
    assert.equal(response.status, 200);
    profile = (await response.json()).profile;
    assert.equal(profile.userId, (await (await fetchFromSite("/api/me", { headers: { cookie } })).json()).user.id,
      "A submitted user ID must never change which account owns the profile.");
    assert.equal(profile.displayName, "Alex Player");

    response = await fetchFromSite("/api/me/profile", {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ displayName: " ", location: "Leeds" })
    });
    assert.equal(response.status, 400, "Empty display names must fail server-side validation.");

    response = await fetchFromSite("/api/auth/sign-out", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{}"
    });
    assert.equal(response.status, 200);

    response = await fetchFromSite("/api/me", { headers: { cookie } });
    assert.equal(response.status, 401);
    response = await fetchFromSite("/api/me/profile", { headers: { cookie } });
    assert.equal(response.status, 401, "A logged-out session must not read the player profile.");

    response = await fetchFromSite("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "correct-horse-battery-staple", rememberMe: false })
    });
    assert.equal(response.status, 200);
    const sessionCookie = setCookiesFrom(response).find((setCookie) => /session_token=/i.test(setCookie));
    assert.ok(sessionCookie, "Login with Remember me unchecked should set a session cookie.");
    assert.doesNotMatch(sessionCookie, /(?:max-age|expires)=/i,
      "Unchecked Remember me must use a browser-session cookie without a persistent expiry.");
    cookie = cookieFrom(response);
    response = await fetchFromSite("/api/me", { headers: { cookie } });
    assert.equal(response.status, 200, "A browser-session cookie should authenticate subsequent requests.");
    response = await fetchFromSite("/api/auth/sign-out", {
      method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}"
    });
    assert.equal(response.status, 200, "Logout should invalidate a non-persistent session normally.");
    response = await fetchFromSite("/api/me", { headers: { cookie } });
    assert.equal(response.status, 401);

    response = await fetchFromSite("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "incorrect-password" })
    });
    assert.ok(response.status >= 400 && response.status < 500, "Invalid credentials must be rejected.");
    assert.equal(cookieFrom(response), "", "Failed login must not establish a session.");

    const loginStartedAt = Date.now();
    response = await fetchFromSite("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "correct-horse-battery-staple", rememberMe: true })
    });
    assert.equal(response.status, 200);
    const persistentSessionCookie = setCookiesFrom(response).find((setCookie) => /session_token=/i.test(setCookie));
    assert.ok(persistentSessionCookie, "Login with Remember me checked should set a session cookie.");
    assert.match(persistentSessionCookie, /(?:^|;\s*)max-age=1209600(?:;|$)/i,
      "Remembered login cookies should persist for the configured 14 days.");
    cookie = cookieFrom(response);
    assert.ok(cookie, "Login should establish a session.");

    response = await fetchFromSite("/api/me", { headers: { cookie } });
    assert.equal(response.status, 200);
    const loggedInSession = (await response.json()).session;
    const sessionExpiry = Date.parse(loggedInSession.expiresAt);
    const fourteenDays = 60 * 60 * 24 * 14 * 1000;
    assert.ok(Math.abs(sessionExpiry - (loginStartedAt + fourteenDays)) < 15_000,
      "The authenticated database session should expire 14 days after login.");

    response = await fetchFromSite("/api/me/profile", { headers: { cookie } });
    assert.equal(response.status, 200);
    profile = (await response.json()).profile;
    assert.equal(profile.displayName, "Alex Player", "Profile edits must persist through logout and login.");
    assert.equal(profile.location, "Leeds");
    assert.equal(profile.biography, "Weekend league player.");

    response = await fetchFromSite("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Second Player", email: `other-${crypto.randomUUID()}@example.test`, password: "correct-horse-battery-staple" })
    });
    assert.equal(response.status, 200, await response.clone().text());
    const secondUserCookie = cookieFrom(response);
    assert.ok(secondUserCookie);
    response = await fetchFromSite("/api/me/profile", { headers: { cookie: secondUserCookie } });
    assert.equal(response.status, 200);
    const secondProfile = (await response.json()).profile;
    assert.notEqual(secondProfile.userId, firstUserId);
    response = await fetchFromSite("/api/me/profile", {
      method: "PUT",
      headers: { cookie: secondUserCookie, "content-type": "application/json" },
      body: JSON.stringify({ userId: firstUserId, displayName: "Second Player Updated" })
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).profile.userId, secondProfile.userId,
      "A signed-in user must only update the profile linked to their own session.");

    response = await fetchFromSite("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "correct-horse-battery-staple" })
    });
    assert.equal(response.status, 200);
    const firstUserCookie = cookieFrom(response);
    response = await fetchFromSite("/api/me/profile", { headers: { cookie: firstUserCookie } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).profile.displayName, "Alex Player",
      "Another account's profile must remain unchanged after a forged owner ID.");

    const postJson = (path, sessionCookie, body) => fetchFromSite(path, {
      method: "POST",
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      body: JSON.stringify(body)
    });

    const createRegisteredPlayer = async (name) => {
      const playerEmail = `role-test-${crypto.randomUUID()}@example.test`;
      const signup = await fetchFromSite("/api/auth/sign-up/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": `198.51.100.${++roleTestSignupOrdinal}`
        },
        body: JSON.stringify({ name, email: playerEmail, password: "correct-horse-battery-staple" })
      });
      assert.equal(signup.status, 200, await signup.clone().text());
      const playerCookie = cookieFrom(signup);
      const playerProfileResponse = await fetchFromSite("/api/me/profile", { headers: { cookie: playerCookie } });
      assert.equal(playerProfileResponse.status, 200);
      return { userId: (await playerProfileResponse.json()).profile.userId, cookie: playerCookie };
    };

    await assert.rejects(
      platformRoles.bootstrapSuperAdmin("missing-bootstrap-account"),
      (error) => error instanceof PlatformRoleError && error.status === 404,
      "Bootstrap must reject a user ID that does not exist in Better Auth."
    );
    const bootstrapAttempts = await Promise.allSettled([
      platformRoles.bootstrapSuperAdmin(firstUserId, "Local concurrency verification"),
      platformRoles.bootstrapSuperAdmin(secondProfile.userId, "Local concurrency verification")
    ]);
    const successfulBootstrapIndex = bootstrapAttempts.findIndex((attempt) => attempt.status === "fulfilled");
    assert.notEqual(successfulBootstrapIndex, -1, "One concurrent bootstrap may create the first Super Admin.");
    assert.equal(bootstrapAttempts.filter((attempt) => attempt.status === "fulfilled").length, 1,
      "Concurrent bootstrap attempts must never create two active Super Admins.");
    const rejectedBootstrap = bootstrapAttempts.find((attempt) => attempt.status === "rejected");
    assert.ok(rejectedBootstrap.reason instanceof PlatformRoleError);
    assert.equal(rejectedBootstrap.reason.status, 409);
    const superAdminUserId = successfulBootstrapIndex === 0 ? firstUserId : secondProfile.userId;
    const superAdminCookie = successfulBootstrapIndex === 0 ? firstUserCookie : secondUserCookie;
    const platformAdminUserId = successfulBootstrapIndex === 0 ? secondProfile.userId : firstUserId;
    const platformAdminCookie = successfulBootstrapIndex === 0 ? secondUserCookie : firstUserCookie;

    const founderAssignmentBeforeUpgrade = await database.query(
      "SELECT user_id, assignment_type FROM platform_roles WHERE role = 'super_admin'"
    );
    assert.deepEqual(founderAssignmentBeforeUpgrade.rows, [{ user_id: superAdminUserId, assignment_type: "founder" }]);
    await runLatestApplicationMigration("down", 2);
    const founderAfterLegacySchema = await database.query("SELECT user_id FROM platform_roles WHERE role = 'super_admin'");
    assert.deepEqual(founderAfterLegacySchema.rows, [{ user_id: superAdminUserId }],
      "Rolling back 011 before any recovery grant keeps the original migration-010 founder assignment.");
    const founderEventAfterLegacySchema = await database.query(
      "SELECT action, actor_user_id FROM platform_role_events WHERE role = 'super_admin'"
    );
    assert.deepEqual(founderEventAfterLegacySchema.rows, [{ action: "bootstrap", actor_user_id: null }],
      "The migration-010 bootstrap audit event remains untouched across the upgrade path.");
    await runLatestApplicationMigration("up");

    const migration012Views = [
      "match_scoreboard",
      "match_player_statistics",
      "practice_player_statistics",
      "official_competitive_player_statistics"
    ];
    migrationApiTestRole = `breakdish_api_view_${crypto.randomUUID().replaceAll("-", "")}`;
    await database.query(`CREATE ROLE "${migrationApiTestRole}" NOLOGIN`);
    migrationApiTestRoleCreated = true;
    await database.query(`GRANT "${migrationApiTestRole}" TO CURRENT_USER`);
    await database.query(
      `GRANT SELECT ON ${migration012Views.map((view) => `public.${view}`).join(", ")} TO "${migrationApiTestRole}"`
    );
    const viewOwnersBefore012 = await database.query(
      `SELECT c.relname AS view_name, pg_get_userbyid(c.relowner) AS owner_name
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname='public' AND c.relkind='v' AND c.relname = ANY($1::text[])
       ORDER BY c.relname`,
      [migration012Views]
    );
    assert.equal(viewOwnersBefore012.rows.length, migration012Views.length,
      "All four views must exist before migration 012 replaces them.");
    const pre012Permissions = await captureViewPermissionVerification("pre", migrationApiTestRole);
    assert.equal(pre012Permissions.success, true, "The pre-migration verifier accepts the 001–011 schema and API grants.");
    assert.equal(pre012Permissions.migrationRoleIsApiRole, false,
      "The integration test uses separate migration and API database roles.");

    await runLatestApplicationMigration("up");
    const viewOwnersAfter012 = await database.query(
      `SELECT c.relname AS view_name, pg_get_userbyid(c.relowner) AS owner_name
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname='public' AND c.relkind='v' AND c.relname = ANY($1::text[])
       ORDER BY c.relname`,
      [migration012Views]
    );
    assert.deepEqual(viewOwnersAfter012.rows, viewOwnersBefore012.rows,
      "CREATE OR REPLACE VIEW must preserve each existing view owner.");
    const apiRoleGrantsAfter012 = await database.query(
      `SELECT c.relname AS view_name, has_table_privilege($1, c.oid, 'SELECT') AS can_select
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relkind='v' AND c.relname = ANY($2::text[])
       ORDER BY c.relname`,
      [migrationApiTestRole, migration012Views]
    );
    assert.ok(apiRoleGrantsAfter012.rows.every((row) => row.can_select),
      "Existing API-role SELECT grants must survive migration 012 for all four views.");
    assert.equal(migrationApiTestRole === (await database.query("SELECT current_user AS role")).rows[0].role, false);

    const apiReader = await database.connect();
    try {
      await apiReader.query(`SET ROLE "${migrationApiTestRole}"`);
      for (const view of migration012Views) {
        await apiReader.query(`SELECT count(*) FROM public.${view}`);
      }
    } finally {
      await apiReader.query("RESET ROLE");
      apiReader.release();
    }

    await database.query(`REVOKE SELECT ON public.official_competitive_player_statistics FROM "${migrationApiTestRole}"`);
    const missingGrantVerification = await captureViewPermissionVerification("post", migrationApiTestRole);
    assert.equal(missingGrantVerification.success, false,
      "The post-migration verifier must fail when an API view grant is missing.");
    assert.equal(missingGrantVerification.viewPermissions.find((item) =>
      item.view === "official_competitive_player_statistics").apiRoleCanSelect, false);
    const deniedApiReader = await database.connect();
    try {
      await deniedApiReader.query(`SET ROLE "${migrationApiTestRole}"`);
      await assert.rejects(
        deniedApiReader.query("SELECT count(*) FROM public.official_competitive_player_statistics"),
        (error) => error.code === "42501",
        "The API role must not read a view after its required grant is removed."
      );
    } finally {
      await deniedApiReader.query("RESET ROLE");
      deniedApiReader.release();
      await database.query(`GRANT SELECT ON public.official_competitive_player_statistics TO "${migrationApiTestRole}"`);
    }
    const post012Permissions = await captureViewPermissionVerification("post", migrationApiTestRole);
    assert.equal(post012Permissions.success, true, "All required grants pass post-migration verification when restored.");
    assert.equal(post012Permissions.migrationRoleIsApiRole, false);

    const founderAfterUpgrade = await database.query(
      "SELECT user_id, assignment_type FROM platform_roles WHERE role = 'super_admin'"
    );
    assert.deepEqual(founderAfterUpgrade.rows, [{ user_id: superAdminUserId, assignment_type: "founder" }],
      "Applying 011 after a founder exists preserves and classifies that assignment in place.");

    const recoveryCandidate = await createRegisteredPlayer("Recovery Candidate");
    const concurrentCandidate = await createRegisteredPlayer("Concurrent Candidate");
    const thirdCandidate = await createRegisteredPlayer("Third Candidate");

    await assert.rejects(
      platformRoles.assignRecoverySuperAdmin(platformAdminUserId, recoveryCandidate.userId, "Unauthorised ordinary account"),
      (error) => error instanceof PlatformRoleError && error.status === 403,
      "An ordinary account cannot assign the recovery Super Admin role."
    );
    assert.equal(await platformRoles.isSuperAdmin(superAdminUserId), true);
    assert.equal(await platformRoles.isPlatformAdmin(superAdminUserId), true,
      "Super Admin must satisfy the broader platform administrator permission.");
    await platformRoles.requireSuperAdmin(superAdminUserId);
    await platformRoles.requirePlatformAdmin(superAdminUserId);
    const bootstrapEvents = await database.query(
      "SELECT role, action, actor_user_id FROM platform_role_events WHERE role='super_admin'"
    );
    assert.deepEqual(bootstrapEvents.rows, [{ role: "super_admin", action: "bootstrap", actor_user_id: null }],
      "Bootstrap must write an auditable event without misrepresenting a user as its own actor.");
    const activeSuperAdmins = await database.query("SELECT count(*)::integer AS count FROM platform_roles WHERE role='super_admin'");
    assert.equal(activeSuperAdmins.rows[0].count, 1);
    await assert.rejects(
      platformRoles.bootstrapSuperAdmin(platformAdminUserId),
      (error) => error instanceof PlatformRoleError && error.status === 409,
      "Bootstrap must refuse after an active Super Admin exists."
    );

    let roleResponse = await fetchFromSite("/api/platform/roles/admins");
    assert.equal(roleResponse.status, 401, "Anonymous users cannot list platform roles.");
    roleResponse = await fetchFromSite("/api/platform/roles/history");
    assert.equal(roleResponse.status, 401, "Anonymous users cannot view platform role history.");
    roleResponse = await postJson(`/api/platform/roles/admins/${platformAdminUserId}`, "", {});
    assert.equal(roleResponse.status, 401, "Anonymous users cannot grant Platform Admin.");
    roleResponse = await fetchFromSite(`/api/platform/roles/admins/${platformAdminUserId}`, { method: "DELETE" });
    assert.equal(roleResponse.status, 401, "Anonymous users cannot revoke Platform Admin.");
    roleResponse = await postJson(`/api/platform/roles/admins/${platformAdminUserId}`, superAdminCookie, {
      reason: "Local integration permission check",
      role: "super_admin"
    });
    assert.equal(roleResponse.status, 201, await roleResponse.clone().text());
    assert.equal((await roleResponse.json()).assignment.role, "platform_admin",
      "Client-supplied role names cannot change the fixed Platform Admin grant target.");
    assert.equal(await platformRoles.hasPlatformRole(platformAdminUserId, "platform_admin"), true);
    assert.equal(await platformRoles.isSuperAdmin(platformAdminUserId), false,
      "Platform Admin must not satisfy the Super Admin-only permission used for future Historic Results imports.");
    await platformRoles.requirePlatformAdmin(platformAdminUserId);
    await assert.rejects(
      platformRoles.requireSuperAdmin(platformAdminUserId),
      (error) => error instanceof PlatformRoleError && error.status === 403
    );
    await assert.rejects(
      platformRoles.assignRecoverySuperAdmin(platformAdminUserId, recoveryCandidate.userId, "Unauthorised platform administrator"),
      (error) => error instanceof PlatformRoleError && error.status === 403,
      "Platform Admin cannot assign a recovery Super Admin."
    );
    await assert.rejects(
      platformRoles.grantPlatformAdmin(superAdminUserId, "missing-platform-account"),
      (error) => error instanceof PlatformRoleError && error.status === 404,
      "Grant must reject an unknown Better Auth account."
    );
    await assert.rejects(
      platformRoles.revokePlatformAdmin(superAdminUserId, "missing-platform-account"),
      (error) => error instanceof PlatformRoleError && error.status === 404,
      "Revoke must reject an unknown Better Auth account."
    );
    await assert.rejects(
      platformRoles.assignRecoverySuperAdmin(superAdminUserId, platformAdminUserId, "Local verification"),
      (error) => error instanceof PlatformRoleError && error.status === 409,
      "Recovery assignment rejects a target who already holds a different platform role."
    );

    roleResponse = await fetchFromSite("/api/platform/roles/admins", { headers: { cookie: superAdminCookie } });
    assert.equal(roleResponse.status, 200);
    assert.ok((await roleResponse.json()).admins.some((admin) => admin.userId === platformAdminUserId));
    roleResponse = await fetchFromSite("/api/platform/roles/history", { headers: { cookie: superAdminCookie } });
    assert.equal(roleResponse.status, 200);
    assert.ok((await roleResponse.json()).events.some((event) => event.action === "bootstrap"));

    roleResponse = await postJson(`/api/platform/roles/admins/${secondProfile.userId}`, platformAdminCookie, {});
    assert.equal(roleResponse.status, 403, "Platform Admin cannot appoint another Platform Admin.");
    roleResponse = await fetchFromSite(`/api/platform/roles/admins/${platformAdminUserId}`, {
      method: "DELETE", headers: { cookie: platformAdminCookie }
    });
    assert.equal(roleResponse.status, 403, "Platform Admin cannot revoke a Platform Admin.");
    roleResponse = await postJson(`/api/platform/roles/admins/${superAdminUserId}`, platformAdminCookie, { role: "platform_admin" });
    assert.equal(roleResponse.status, 403, "Platform Admin cannot replace the active Super Admin.");
    roleResponse = await fetchFromSite(`/api/platform/roles/admins/${superAdminUserId}`, {
      method: "DELETE", headers: { cookie: platformAdminCookie }
    });
    assert.equal(roleResponse.status, 403, "Platform Admin cannot revoke or modify the active Super Admin.");
    roleResponse = await fetchFromSite("/api/platform/roles/admins", { headers: { cookie: platformAdminCookie } });
    assert.equal(roleResponse.status, 403, "Platform Admin cannot view or manage role assignments.");

    roleResponse = await postJson(`/api/platform/roles/admins/${platformAdminUserId}`, superAdminCookie, {});
    assert.equal(roleResponse.status, 200, "Repeated Platform Admin grants are idempotent.");
    assert.equal((await roleResponse.json()).repeated, true);
    const grantsBeforeRevoke = await database.query(
      "SELECT count(*)::integer AS count FROM platform_role_events WHERE target_user_id=$1 AND role='platform_admin' AND action='grant'",
      [platformAdminUserId]
    );
    assert.equal(grantsBeforeRevoke.rows[0].count, 1, "An idempotent grant must not duplicate audit events.");

    roleResponse = await fetchFromSite(`/api/platform/roles/admins/${platformAdminUserId}`, {
      method: "DELETE", headers: { cookie: superAdminCookie, "content-type": "application/json" },
      body: JSON.stringify({ reason: "Local revocation verification" })
    });
    assert.equal(roleResponse.status, 200);
    assert.equal((await roleResponse.json()).revoked, true);
    assert.equal(await platformRoles.isPlatformAdmin(platformAdminUserId), false,
      "A revoked Platform Admin must immediately lose platform permissions.");
    await assert.rejects(
      platformRoles.requirePlatformAdmin(platformAdminUserId),
      (error) => error instanceof PlatformRoleError && error.status === 403
    );
    roleResponse = await fetchFromSite("/api/platform/roles/admins", { headers: { cookie: platformAdminCookie } });
    assert.equal(roleResponse.status, 403, "A revoked Platform Admin loses management API access.");
    roleResponse = await fetchFromSite(`/api/platform/roles/admins/${platformAdminUserId}`, {
      method: "DELETE", headers: { cookie: superAdminCookie }
    });
    assert.equal(roleResponse.status, 200, "Repeated revocation is idempotent.");
    assert.equal((await roleResponse.json()).revoked, false);

    await assert.rejects(
      platformRoles.assignRecoverySuperAdmin(superAdminUserId, "missing-recovery-account", "Local verification"),
      (error) => error instanceof PlatformRoleError && error.status === 404,
      "Recovery assignment rejects a target ID that does not identify an existing Better Auth account."
    );
    const ownerLeagueResponse = await postJson("/api/leagues", recoveryCandidate.cookie, {
      name: `Role protection ${crypto.randomUUID()}`,
      location: "Local integration test"
    });
    assert.equal(ownerLeagueResponse.status, 201, await ownerLeagueResponse.clone().text());
    const ownerLeague = await ownerLeagueResponse.json();
    const ownerMembership = await database.query(
      "SELECT role, status FROM league_memberships WHERE league_id=$1 AND user_id=$2",
      [ownerLeague.league.id, recoveryCandidate.userId]
    );
    assert.deepEqual(ownerMembership.rows, [{ role: "owner", status: "active" }],
      "The unauthorized actor is a real league owner in the integration database.");
    await assert.rejects(
      platformRoles.assignRecoverySuperAdmin(recoveryCandidate.userId, concurrentCandidate.userId, "Unauthorised league owner"),
      (error) => error instanceof PlatformRoleError && error.status === 403,
      "League ownership does not grant permission to assign a recovery Super Admin."
    );

    await assert.rejects(
      database.query(
        `INSERT INTO platform_role_events(target_user_id, role, action, assignment_type, actor_user_id)
         VALUES($1, 'super_admin', 'recovery_grant', 'recovery', $2)`,
        [recoveryCandidate.userId, superAdminUserId]
      ),
      (error) => error.code === "23514" && error.constraint === "platform_role_events_super_admin_assignment_required",
      "A Super Admin audit event cannot be fabricated without its active role assignment."
    );
    await assert.rejects(
      database.query(
        `INSERT INTO platform_roles(user_id, role, assignment_type, granted_by)
         VALUES($1, 'super_admin', 'recovery', $2)`,
        [recoveryCandidate.userId, superAdminUserId]
      ),
      (error) => error.code === "23514" && error.constraint === "platform_roles_super_admin_audit_required",
      "A direct database assignment cannot commit without its matching append-only audit event."
    );
    const countAfterUnauditedInsert = await database.query(
      "SELECT count(*)::integer AS count FROM platform_roles WHERE role='super_admin'"
    );
    assert.equal(countAfterUnauditedInsert.rows[0].count, 1);

    await database.query(`
      CREATE FUNCTION breakdish_test_fail_recovery_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW.role = 'super_admin' AND NEW.action = 'recovery_grant' THEN
          RAISE EXCEPTION 'forced recovery audit failure' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER breakdish_test_fail_recovery_audit
        BEFORE INSERT ON platform_role_events
        FOR EACH ROW EXECUTE FUNCTION breakdish_test_fail_recovery_audit();
    `);
    try {
      await assert.rejects(
        platformRoles.assignRecoverySuperAdmin(superAdminUserId, recoveryCandidate.userId, "Force audit rollback"),
        (error) => error.code === "23514",
        "A failed audit insert must reject the recovery assignment transaction."
      );
      const recoveryRollbackState = await database.query(
        `SELECT
          (SELECT count(*)::integer FROM platform_roles WHERE role='super_admin') AS active_count,
          (SELECT count(*)::integer FROM platform_role_events WHERE role='super_admin' AND action='recovery_grant') AS recovery_events`
      );
      assert.deepEqual(recoveryRollbackState.rows, [{ active_count: 1, recovery_events: 0 }],
        "A failed audit write leaves both role state and audit history unchanged.");
    } finally {
      await database.query(`
        DROP TRIGGER breakdish_test_fail_recovery_audit ON platform_role_events;
        DROP FUNCTION breakdish_test_fail_recovery_audit();
      `);
    }

    const recoveryAttempts = await Promise.allSettled([
      platformRoles.assignRecoverySuperAdmin(superAdminUserId, recoveryCandidate.userId, "Local recovery assignment test"),
      platformRoles.assignRecoverySuperAdmin(superAdminUserId, concurrentCandidate.userId, "Concurrent local recovery attempt")
    ]);
    const recoverySuccessIndex = recoveryAttempts.findIndex((attempt) => attempt.status === "fulfilled");
    assert.notEqual(recoverySuccessIndex, -1, "One concurrent backup assignment may succeed.");
    assert.equal(recoveryAttempts.filter((attempt) => attempt.status === "fulfilled").length, 1,
      "Concurrent backup assignments must not create more than two active Super Admins.");
    const recoveryRejected = recoveryAttempts.find((attempt) => attempt.status === "rejected");
    assert.ok(recoveryRejected.reason instanceof PlatformRoleError);
    assert.equal(recoveryRejected.reason.status, 409);
    const recoveryAssignment = recoveryAttempts[recoverySuccessIndex].value;
    const recoveryUserId = recoveryAssignment.userId;
    assert.equal(recoveryAssignment.role, "super_admin");
    assert.equal(recoveryAssignment.assignmentType, "recovery");
    assert.equal(recoveryAssignment.grantedBy, superAdminUserId);
    assert.equal(await platformRoles.isSuperAdmin(superAdminUserId), true);
    assert.equal(await platformRoles.isSuperAdmin(recoveryUserId), true);
    await platformRoles.requireSuperAdmin(superAdminUserId);
    await platformRoles.requireSuperAdmin(recoveryUserId);
    await platformRoles.requirePlatformAdmin(recoveryUserId);
    await assert.rejects(
      platformRoles.assignRecoverySuperAdmin(superAdminUserId, thirdCandidate.userId, "Third Super Admin attempt"),
      (error) => error instanceof PlatformRoleError && error.status === 409,
      "The application must refuse a third active Super Admin."
    );
    const recoveryEvent = await database.query(
      `SELECT role, action, assignment_type, actor_user_id
       FROM platform_role_events WHERE target_user_id = $1 AND role = 'super_admin'`,
      [recoveryUserId]
    );
    assert.deepEqual(recoveryEvent.rows, [{
      role: "super_admin", action: "recovery_grant", assignment_type: "recovery", actor_user_id: superAdminUserId
    }], "The recovery assignment writes a correctly classified, authorising audit event.");
    const activeSuperAdminCount = await database.query(
      "SELECT count(*)::integer AS count FROM platform_roles WHERE role = 'super_admin'"
    );
    assert.equal(activeSuperAdminCount.rows[0].count, 2);
    const foundersAfterRecovery = await database.query(
      "SELECT user_id FROM platform_roles WHERE role = 'super_admin' AND assignment_type = 'founder'"
    );
    assert.deepEqual(foundersAfterRecovery.rows, [{ user_id: superAdminUserId }]);
    await assert.rejects(
      database.query(
        `INSERT INTO platform_roles(user_id, role, assignment_type, granted_by)
         VALUES($1, 'super_admin', NULL, $2)`,
        [thirdCandidate.userId, superAdminUserId]
      ),
      (error) => error.code === "23514" && error.constraint === "platform_roles_assignment_type_allowed",
      "A third Super Admin cannot bypass the two-slot unique index by using a NULL assignment type."
    );
    await assert.rejects(
      database.query(
        `INSERT INTO platform_roles(user_id, role, assignment_type, granted_by)
         VALUES($1, 'super_admin', 'founder', NULL)`,
        [thirdCandidate.userId]
      ),
      (error) => error.code === "23505" || error.code === "23514",
      "Database triggers and slot constraints must reject a third assignment even when application checks are bypassed."
    );
    await assert.rejects(
      database.query(
        `INSERT INTO platform_roles(user_id, role, assignment_type, granted_by)
         VALUES($1, 'super_admin', 'recovery', $2)`,
        [thirdCandidate.userId, superAdminUserId]
      ),
      (error) => error.code === "23514",
      "The database must reject a concurrent or direct third recovery assignment."
    );
    await assert.rejects(
      database.query(
        "UPDATE platform_role_events SET reason='changed' WHERE target_user_id=$1 AND action='bootstrap'",
        [superAdminUserId]
      ),
      (error) => error.code === "55000" && error.constraint === "platform_role_events_append_only",
      "The immutable migration-010 founder bootstrap audit event cannot be rewritten."
    );
    await assert.rejects(
      database.query(
        "UPDATE platform_roles SET user_id=$1 WHERE user_id=$2 AND role='super_admin'",
        [thirdCandidate.userId, superAdminUserId]
      ),
      (error) => error.code === "55000" && error.constraint === "platform_roles_super_admin_immutable",
      "The founder Super Admin identity and assignment cannot be edited or replaced."
    );
    await assert.rejects(
      database.query("DELETE FROM platform_roles WHERE user_id=$1 AND role='super_admin'", [superAdminUserId]),
      (error) => error.code === "55000" && error.constraint === "platform_roles_super_admin_removal_review",
      "The founder Super Admin slot cannot be removed through direct DML."
    );
    await assert.rejects(
      database.query(
        "DELETE FROM platform_role_events WHERE target_user_id=$1 AND action='bootstrap'",
        [superAdminUserId]
      ),
      (error) => error.code === "55000" && error.constraint === "platform_role_events_append_only",
      "Founder audit history cannot be deleted."
    );
    await runLatestApplicationMigration("down");
    const migration011Rollback = runLatestApplicationMigration("down");
    await assert.rejects(
      migration011Rollback,
      /Cannot roll back migration 011 after a recovery Super Admin assignment has been recorded/,
      "Rollback must stop once a recovery assignment has been recorded."
    );
    const latestMigration = await database.query(
      "SELECT name FROM breakdish_app_migrations ORDER BY run_on DESC, id DESC LIMIT 1"
    );
    assert.match(latestMigration.rows[0].name, /^011_backup_super_admin$/,
      "A blocked 011 rollback leaves the tested role schema in place.");
    await runLatestApplicationMigration("up");
    const retainedRoleHistory = await database.query(
      "SELECT action, actor_user_id, reason FROM platform_role_events WHERE target_user_id=$1 AND role='platform_admin' ORDER BY created_at",
      [platformAdminUserId]
    );
    assert.deepEqual(retainedRoleHistory.rows.map((event) => event.action), ["grant", "revoke"],
      "The complete role history remains after the active assignment is removed.");
    assert.ok(retainedRoleHistory.rows.every((event) => event.actor_user_id === superAdminUserId),
      "Grant and revocation audit events retain the authorizing Super Admin.");
    assert.equal(retainedRoleHistory.rows[1].reason, "Local revocation verification");
    await assert.rejects(
      database.query("UPDATE platform_role_events SET reason='changed' WHERE target_user_id=$1", [platformAdminUserId]),
      (error) => error.code === "55000" && error.constraint === "platform_role_events_append_only",
      "The database must reject changes to recorded platform role history."
    );
    await assert.rejects(
      database.query("DELETE FROM platform_role_events WHERE target_user_id=$1", [platformAdminUserId]),
      (error) => error.code === "55000" && error.constraint === "platform_role_events_append_only",
      "The database must reject deletion of platform role history."
    );
    await assert.rejects(
      database.query("TRUNCATE platform_role_events"),
      (error) => error.code === "55000" && error.constraint === "platform_role_events_append_only",
      "The database trigger must also reject ordinary TRUNCATE attempts against role history."
    );

    const createLeague = async (sessionCookie, details) => {
      const created = await postJson("/api/leagues", sessionCookie, details);
      assert.equal(created.status, 201, await created.clone().text());
      return created.json();
    };

    response = await fetchFromSite("/api/leagues");
    assert.equal(response.status, 200);
    const initialDirectory = (await response.json()).leagues;
    const storedPublicLeagues = await database.query("SELECT id FROM leagues WHERE status IN ('open', 'active') ORDER BY name ASC, created_at ASC");
    assert.deepEqual(initialDirectory.map((league) => league.id), storedPublicLeagues.rows.map((league) => league.id),
      "The public directory must reflect persisted rows, not fabricated fixture data.");
    response = await postJson("/api/leagues", "", { name: "Anonymous league" });
    assert.equal(response.status, 401, "League creation requires an authenticated account.");
    response = await postJson("/api/leagues/not-a-uuid/join", secondUserCookie, {});
    assert.equal(response.status, 400, "Malformed league IDs must be rejected before reaching PostgreSQL.");
    const missingLeagueId = crypto.randomUUID();
    response = await postJson(`/api/leagues/${missingLeagueId}/join`, secondUserCookie, {});
    assert.equal(response.status, 404, "A validly formed but unknown league ID must be handled safely.");
    response = await fetchFromSite(`/api/leagues/${missingLeagueId}`);
    assert.equal(response.status, 404, "Unknown league details must not leak database errors.");

    const approval = await createLeague(firstUserCookie, {
      name: `Approval League ${crypto.randomUUID()}`,
      description: "A local integration-test league.",
      location: "Leeds",
      joinPolicy: "approval",
      createdBy: secondProfile.userId,
      status: "active"
    });
    const open = await createLeague(firstUserCookie, {
      name: `Open League ${crypto.randomUUID()}`,
      joinPolicy: "open"
    });
    assert.equal(approval.membership.userId, firstUserId);
    assert.equal(approval.membership.role, "owner");
    assert.equal(approval.membership.status, "active");
    assert.equal(approval.league.status, "open", "The API must choose the safe initial league state.");
    assert.equal(approval.league.joinPolicy, "approval");

    const ownerRows = await database.query(
      `SELECT m.role, m.status, l.created_by, l.join_policy
       FROM league_memberships m JOIN leagues l ON l.id = m.league_id
       WHERE m.league_id = $1 AND m.user_id = $2`,
      [approval.league.id, firstUserId]
    );
    assert.deepEqual(ownerRows.rows[0], {
      role: "owner", status: "active", created_by: firstUserId, join_policy: "approval"
    }, "The database trigger must assign the authenticated creator as active owner.");

    response = await fetchFromSite("/api/me/leagues", { headers: { cookie: firstUserCookie } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).leagues.some((league) => league.id === approval.league.id), false,
      "Automatic owner membership alone must not make a league appear in My Leagues as player participation.");
    response = await fetchFromSite("/api/me/managed-leagues", { headers: { cookie: firstUserCookie } });
    assert.equal(response.status, 200);
    const ownerManagedLeagues = (await response.json()).leagues;
    assert.equal(ownerManagedLeagues.find((league) => league.id === approval.league.id)?.viewerMembership.role, "owner",
      "League creators must appear in Admin with the distinct Owner role.");

    const publicDirectoryResponse = await fetchFromSite("/api/leagues", { headers: { cookie: secondUserCookie } });
    assert.equal(publicDirectoryResponse.status, 200);
    const publicLeagues = (await publicDirectoryResponse.json()).leagues;
    assert.ok(publicLeagues.some((league) => league.id === approval.league.id));
    assert.ok(publicLeagues.some((league) => league.id === open.league.id));
    response = await fetchFromSite(`/api/leagues/${approval.league.id}`, { headers: { cookie: secondUserCookie } });
    assert.equal(response.status, 200, "Public league details should be readable without management rights.");

    const concurrentJoins = await Promise.all([
      postJson(`/api/leagues/${open.league.id}/join`, secondUserCookie, {}),
      postJson(`/api/leagues/${open.league.id}/join`, secondUserCookie, {})
    ]);
    assert.ok(concurrentJoins.every((joinResponse) => [200, 201].includes(joinResponse.status)));
    const concurrentJoinBodies = await Promise.all(concurrentJoins.map((joinResponse) => joinResponse.json()));
    assert.ok(concurrentJoinBodies.every(({ membership }) => membership.status === "active"));
    assert.equal(concurrentJoinBodies.filter(({ repeated }) => repeated).length, 1,
      "Concurrent open joins should serialize into one new membership and one idempotent response.");
    const openMemberCount = await database.query(
      `SELECT count(*)::integer AS count FROM league_memberships WHERE league_id = $1 AND user_id = $2 AND status = 'active'`,
      [open.league.id, secondProfile.userId]
    );
    assert.equal(openMemberCount.rows[0].count, 1, "The unique league/user constraint must prevent duplicate memberships.");
    response = await postJson(`/api/leagues/${open.league.id}/join`, secondUserCookie, {});
    assert.equal(response.status, 200, "Repeated joins must be idempotent.");
    response = await fetchFromSite("/api/me/leagues", { headers: { cookie: secondUserCookie } });
    assert.ok((await response.json()).leagues.some((league) => league.id === open.league.id),
      "An ordinary active league member must see the league in My Leagues.");
    response = await fetchFromSite("/api/me/managed-leagues", { headers: { cookie: secondUserCookie } });
    assert.equal((await response.json()).leagues.some((league) => league.id === open.league.id), false,
      "An ordinary member must not receive Admin access to their league.");
    response = await fetchFromSite(`/api/me/managed-leagues?userId=${encodeURIComponent(firstUserId)}`, { headers: { cookie: secondUserCookie } });
    assert.equal((await response.json()).leagues.some((league) => league.id === approval.league.id), false,
      "The Admin endpoint must ignore attempts to request another account's managed leagues.");

    response = await postJson(`/api/leagues/${approval.league.id}/join`, secondUserCookie, {});
    assert.equal(response.status, 201);
    assert.equal((await response.json()).membership.status, "pending");
    response = await postJson(`/api/leagues/${approval.league.id}/join`, secondUserCookie, {});
    assert.equal(response.status, 200, "Duplicate approval requests must not create another membership.");
    assert.equal((await response.json()).membership.status, "pending");
    const pendingCount = await database.query(
      `SELECT count(*)::integer AS count FROM league_memberships WHERE league_id = $1 AND user_id = $2 AND status = 'pending'`,
      [approval.league.id, secondProfile.userId]
    );
    assert.equal(pendingCount.rows[0].count, 1);

    response = await fetchFromSite(`/api/leagues/${approval.league.id}/requests`, { headers: { cookie: firstUserCookie } });
    assert.equal(response.status, 200, "The owner should be able to review join requests.");
    assert.equal((await response.json()).requests.length, 1);
    response = await postJson(`/api/leagues/${approval.league.id}/requests/${secondProfile.userId}`, firstUserCookie, { action: "approve" });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).membership.status, "active");

    await database.query("UPDATE leagues SET status = 'active' WHERE id = $1", [approval.league.id]);
    await assert.rejects(
      database.query("UPDATE league_memberships SET status = 'left' WHERE league_id = $1 AND user_id = $2", [approval.league.id, firstUserId]),
      (error) => error.code === "23514" && /active owner/i.test(error.message),
      "The database must block removal of the last active owner from an active league."
    );
    const protectedOwner = await database.query(
      "SELECT status FROM league_memberships WHERE league_id = $1 AND user_id = $2 AND role = 'owner'",
      [approval.league.id, firstUserId]
    );
    assert.equal(protectedOwner.rows[0]?.status, "active");

    response = await fetchFromSite(`/api/leagues/${approval.league.id}/members/${secondProfile.userId}/role`, {
      method: "PATCH", headers: { cookie: firstUserCookie, "content-type": "application/json" },
      body: JSON.stringify({ role: "administrator" })
    });
    assert.equal(response.status, 200, "Only the owner may assign an administrator.");
    response = await fetchFromSite("/api/me/managed-leagues", { headers: { cookie: secondUserCookie } });
    const secondManagedLeagues = (await response.json()).leagues;
    assert.equal(secondManagedLeagues.find((league) => league.id === approval.league.id)?.viewerMembership.role, "administrator",
      "An administrator must receive Admin access for the league they administer.");
    assert.equal(secondManagedLeagues.some((league) => league.id === open.league.id), false,
      "The Admin Control Centre must exclude leagues the administrator does not manage.");
    response = await fetchFromSite("/api/me/leagues", { headers: { cookie: secondUserCookie } });
    assert.equal((await response.json()).leagues.some((league) => league.id === approval.league.id), false,
      "An administrator who has not separately joined or played must not be described as a player.");
    response = await fetchFromSite(`/api/leagues/${approval.league.id}/members/${firstUserId}/role`, {
      method: "PATCH", headers: { cookie: firstUserCookie, "content-type": "application/json" },
      body: JSON.stringify({ role: "member" })
    });
    assert.equal(response.status, 409, "The owner cannot demote themselves through role management.");
    response = await fetchFromSite(`/api/leagues/${approval.league.id}/members/${firstUserId}/role`, {
      method: "PATCH", headers: { cookie: firstUserCookie, "content-type": "application/json" },
      body: JSON.stringify({ role: "owner" })
    });
    assert.equal(response.status, 400, "Ownership cannot be reassigned through the member role endpoint.");

    response = await fetchFromSite("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Third Player", email: `third-${crypto.randomUUID()}@example.test`, password: "correct-horse-battery-staple" })
    });
    assert.equal(response.status, 200, await response.clone().text());
    const thirdUserCookie = cookieFrom(response);
    const thirdProfileResponse = await fetchFromSite("/api/me/profile", { headers: { cookie: thirdUserCookie } });
    assert.equal(thirdProfileResponse.status, 200);
    const thirdProfile = (await thirdProfileResponse.json()).profile;
    response = await postJson(`/api/leagues/${approval.league.id}/join`, thirdUserCookie, {});
    assert.equal(response.status, 201);
    response = await fetchFromSite(`/api/leagues/${approval.league.id}/requests`, { headers: { cookie: thirdUserCookie } });
    assert.equal(response.status, 403, "A requesting member cannot inspect the private request list.");
    response = await postJson(`/api/leagues/${approval.league.id}/requests/${thirdProfile.userId}`, thirdUserCookie, { action: "approve" });
    assert.equal(response.status, 403, "A member cannot approve their own request or another player's request.");
    response = await fetchFromSite(`/api/leagues/${approval.league.id}/members/${thirdProfile.userId}/role`, {
      method: "PATCH", headers: { cookie: thirdUserCookie, "content-type": "application/json" },
      body: JSON.stringify({ role: "administrator" })
    });
    assert.equal(response.status, 403, "A member cannot promote themselves or another user.");
    response = await fetchFromSite(`/api/leagues/${approval.league.id}/requests`, { headers: { cookie: secondUserCookie } });
    assert.equal(response.status, 200, "An administrator should be able to manage requests.");
    response = await postJson(`/api/leagues/${approval.league.id}/requests/${thirdProfile.userId}`, secondUserCookie, { action: "decline" });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).membership.status, "declined");
    response = await postJson(`/api/leagues/${approval.league.id}/join`, thirdUserCookie, {});
    assert.equal(response.status, 201, "A declined member may submit a fresh request later.");
    assert.equal((await response.json()).membership.status, "pending");
    response = await postJson(`/api/leagues/${approval.league.id}/requests/${thirdProfile.userId}`, secondUserCookie, { action: "approve" });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).membership.status, "active");
    await assert.rejects(
      platformRoles.assignRecoverySuperAdmin(thirdProfile.userId, thirdProfile.userId, "League member privilege check"),
      (error) => error instanceof PlatformRoleError && error.status === 403,
      "An active League Member cannot assign a recovery Super Admin."
    );
    response = await postJson(`/api/leagues/${approval.league.id}/requests/${thirdProfile.userId}`, secondUserCookie, { action: "decline" });
    assert.equal(response.status, 409, "A resolved request cannot be decided twice.");
    response = await fetchFromSite(`/api/leagues/${approval.league.id}/members/${thirdProfile.userId}/role`, {
      method: "PATCH", headers: { cookie: secondUserCookie, "content-type": "application/json" },
      body: JSON.stringify({ role: "administrator" })
    });
    assert.equal(response.status, 403, "An administrator cannot grant administrator privileges.");

    const patchJson = (path, sessionCookie, body) => fetchFromSite(path, {
      method: "PATCH",
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const signingTestIp = "203.0.113.77";
    const signingPostJson = (path, sessionCookie, body) => fetchFromSite(path, {
      method: "POST",
      headers: { cookie: sessionCookie, "content-type": "application/json", "x-forwarded-for": signingTestIp },
      body: JSON.stringify(body)
    });
    const signingPatchJson = (path, sessionCookie, body) => fetchFromSite(path, {
      method: "PATCH",
      headers: { cookie: sessionCookie, "content-type": "application/json", "x-forwarded-for": signingTestIp },
      body: JSON.stringify(body)
    });
    const createSeason = async (details, sessionCookie = firstUserCookie) => {
      const created = await postJson(`/api/leagues/${approval.league.id}/seasons`, sessionCookie, details);
      assert.equal(created.status, 201, await created.clone().text());
      return (await created.json()).season;
    };
    let signUpTestAddress = 10;
    const signUpPlayer = async (name) => {
      const testAddress = `192.0.2.${signUpTestAddress++}`;
      const created = await fetchFromSite("/api/auth/sign-up/email", {
        method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": testAddress },
        body: JSON.stringify({ name, email: `${name.toLowerCase().replace(/\s+/g, "-")}-${crypto.randomUUID()}@example.test`, password: "correct-horse-battery-staple" })
      });
      assert.equal(created.status, 200, await created.clone().text());
      return cookieFrom(created);
    };
    roleResponse = await postJson(`/api/platform/roles/admins/${platformAdminUserId}`, platformAdminCookie, {
      role: "super_admin"
    });
    assert.equal(roleResponse.status, 403, "A Platform Admin cannot grant a role to themselves or elevate the requested role.");
    const secondPlatformAdminCookie = await signUpPlayer("Platform Role Second Admin");
    const secondPlatformAdminUserResponse = await fetchFromSite("/api/me", { headers: { cookie: secondPlatformAdminCookie } });
    const secondPlatformAdminUserId = (await secondPlatformAdminUserResponse.json()).user.id;
    await platformRoles.grantPlatformAdmin(superAdminUserId, secondPlatformAdminUserId, "Second administrator permission test");
    roleResponse = await postJson(`/api/platform/roles/admins/${secondPlatformAdminUserId}`, platformAdminCookie, {});
    assert.equal(roleResponse.status, 403, "A Platform Admin cannot grant or change another Platform Admin assignment.");
    roleResponse = await fetchFromSite(`/api/platform/roles/admins/${secondPlatformAdminUserId}`, {
      method: "DELETE", headers: { cookie: platformAdminCookie }
    });
    assert.equal(roleResponse.status, 403, "A Platform Admin cannot revoke another Platform Admin assignment.");
    const secondPlatformAdminCleanup = await platformRoles.revokePlatformAdmin(
      superAdminUserId, secondPlatformAdminUserId, "Clean up second administrator permission test"
    );
    assert.equal(secondPlatformAdminCleanup.revoked, true);

    const auditFailureCookie = await signUpPlayer("Platform Role Audit Failure");
    const auditFailureUserResponse = await fetchFromSite("/api/me", { headers: { cookie: auditFailureCookie } });
    const auditFailureUserId = (await auditFailureUserResponse.json()).user.id;
    await database.query(`
      CREATE FUNCTION breakdish_test_fail_platform_role_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW.reason = 'force audit write failure' THEN
          RAISE EXCEPTION 'test-only audit write failure' USING ERRCODE = 'P0001';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER breakdish_test_fail_platform_role_audit
        BEFORE INSERT ON platform_role_events
        FOR EACH ROW EXECUTE FUNCTION breakdish_test_fail_platform_role_audit();
    `);
    try {
      await assert.rejects(
        platformRoles.grantPlatformAdmin(superAdminUserId, auditFailureUserId, "force audit write failure"),
        (error) => error.code === "P0001",
        "A failed grant audit insert must abort the role assignment transaction."
      );
      let failedGrantState = await database.query("SELECT count(*)::integer AS count FROM platform_roles WHERE user_id=$1", [auditFailureUserId]);
      assert.equal(failedGrantState.rows[0].count, 0);
      let failedGrantHistory = await database.query("SELECT count(*)::integer AS count FROM platform_role_events WHERE target_user_id=$1", [auditFailureUserId]);
      assert.equal(failedGrantHistory.rows[0].count, 0);

      await platformRoles.grantPlatformAdmin(superAdminUserId, auditFailureUserId, "Grant for revoke rollback test");
      await assert.rejects(
        platformRoles.revokePlatformAdmin(superAdminUserId, auditFailureUserId, "force audit write failure"),
        (error) => error.code === "P0001",
        "A failed revoke audit insert must roll back the role removal."
      );
      failedGrantState = await database.query("SELECT role FROM platform_roles WHERE user_id=$1", [auditFailureUserId]);
      assert.deepEqual(failedGrantState.rows, [{ role: "platform_admin" }]);
      failedGrantHistory = await database.query("SELECT action FROM platform_role_events WHERE target_user_id=$1", [auditFailureUserId]);
      assert.deepEqual(failedGrantHistory.rows, [{ action: "grant" }]);
    } finally {
      await database.query(`
        DROP TRIGGER breakdish_test_fail_platform_role_audit ON platform_role_events;
        DROP FUNCTION breakdish_test_fail_platform_role_audit();
      `);
    }
    const auditFailureCleanup = await platformRoles.revokePlatformAdmin(
      superAdminUserId, auditFailureUserId, "Clean up transaction integration test"
    );
    assert.equal(auditFailureCleanup.revoked, true);

    const assertPlatformRoleMutationsDenied = async (sessionCookie, description) => {
      const grant = await postJson(`/api/platform/roles/admins/${superAdminUserId}`, sessionCookie, { reason: "Unauthorized test" });
      assert.equal(grant.status, 403, `${description} cannot grant a platform role.`);
      const revoke = await fetchFromSite(`/api/platform/roles/admins/${superAdminUserId}`, {
        method: "DELETE", headers: { cookie: sessionCookie, "content-type": "application/json" },
        body: JSON.stringify({ reason: "Unauthorized test" })
      });
      assert.equal(revoke.status, 403, `${description} cannot revoke a platform role.`);
    };
    const ordinaryRoleCookie = await signUpPlayer("Platform Role Ordinary User");
    response = await fetchFromSite("/api/platform/roles/admins", { headers: { cookie: ordinaryRoleCookie } });
    assert.equal(response.status, 403, "An ordinary signed-in user cannot view platform role assignments.");
    await assertPlatformRoleMutationsDenied(ordinaryRoleCookie, "An ordinary user");

    const scopedOwnerCookie = await signUpPlayer("Platform Scope League Owner");
    const scopedOwnerProfileResponse = await fetchFromSite("/api/me/profile", { headers: { cookie: scopedOwnerCookie } });
    const scopedOwnerProfile = (await scopedOwnerProfileResponse.json()).profile;
    const scopedAdminCookie = await signUpPlayer("Platform Scope League Administrator");
    const scopedAdminProfileResponse = await fetchFromSite("/api/me/profile", { headers: { cookie: scopedAdminCookie } });
    const scopedAdminProfile = (await scopedAdminProfileResponse.json()).profile;
    const scopedLeague = await createLeague(scopedOwnerCookie, {
      name: `Platform Scope League ${crypto.randomUUID()}`, joinPolicy: "open"
    });
    response = await postJson(`/api/leagues/${scopedLeague.league.id}/join`, scopedAdminCookie, {});
    assert.ok([200, 201].includes(response.status));
    response = await fetchFromSite(`/api/leagues/${scopedLeague.league.id}/members/${scopedAdminProfile.userId}/role`, {
      method: "PATCH", headers: { cookie: scopedOwnerCookie, "content-type": "application/json" },
      body: JSON.stringify({ role: "administrator" })
    });
    assert.equal(response.status, 200);
    assert.notEqual(scopedOwnerProfile.userId, scopedAdminProfile.userId);
    await assert.rejects(
      platformRoles.assignRecoverySuperAdmin(scopedAdminProfile.userId, recoveryCandidate.userId, "League administrator privilege check"),
      (error) => error instanceof PlatformRoleError && error.status === 403,
      "A League Administrator cannot assign a recovery Super Admin."
    );
    response = await fetchFromSite("/api/platform/roles/admins", { headers: { cookie: scopedOwnerCookie } });
    assert.equal(response.status, 403, "League ownership alone does not grant platform role management.");
    await assertPlatformRoleMutationsDenied(scopedOwnerCookie, "A League Owner without a platform role");
    response = await fetchFromSite("/api/platform/roles/history", { headers: { cookie: scopedAdminCookie } });
    assert.equal(response.status, 403, "League administrator status alone does not grant platform role history access.");
    await assertPlatformRoleMutationsDenied(scopedAdminCookie, "A League Administrator without a platform role");

    const createDoublesEntry = async (leagueId, seasonId, userIds, status = "approved") => {
      const client = await database.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('breakdish.actor_user_id',$1,true)", [firstUserId]);
        const inserted = await client.query(
          `INSERT INTO competition_entries(entry_type,league_id,season_id,created_by)
           VALUES('doubles_league',$1,$2,$3) RETURNING id`, [leagueId, seasonId, firstUserId]
        );
        const entryId = inserted.rows[0].id;
        for (const userId of userIds) {
          await client.query(
            `INSERT INTO competition_entry_participants(entry_id,user_id,added_by) VALUES($1,$2,$3)`,
            [entryId, userId, firstUserId]
          );
        }
        if (status === "approved") {
          await client.query("UPDATE competition_entries SET status='payment_confirmed' WHERE id=$1", [entryId]);
          await client.query("UPDATE competition_entries SET status='approved' WHERE id=$1", [entryId]);
        } else if (status !== "pending") {
          await client.query("UPDATE competition_entries SET status=$2 WHERE id=$1", [entryId, status]);
        }
        await client.query("COMMIT");
        return entryId;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    };

    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const season = await createSeason({ name: `Winter ${crypto.randomUUID()}`, startsOn: tomorrow, endsOn: "2027-04-30", createdBy: secondProfile.userId });
    assert.equal(season.status, "draft");
    assert.equal(season.leagueId, approval.league.id);
    response = await postJson(`/api/leagues/${approval.league.id}/seasons`, secondUserCookie, { name: season.name.toUpperCase() });
    assert.equal(response.status, 409, "Case-insensitive duplicate season names must not be created.");
    response = await postJson(`/api/seasons/${season.id}/divisions`, thirdUserCookie, { name: "Unauthorised Division" });
    assert.equal(response.status, 403, "A regular league member cannot create divisions.");

    const premierResponse = await postJson(`/api/seasons/${season.id}/divisions`, firstUserCookie, { name: "Premier" });
    assert.equal(premierResponse.status, 201);
    const premier = (await premierResponse.json()).division;
    const secondDivisionResponse = await postJson(`/api/seasons/${season.id}/divisions`, secondUserCookie, { name: "Division Two" });
    assert.equal(secondDivisionResponse.status, 201, "A league administrator can create divisions.");
    const secondDivision = (await secondDivisionResponse.json()).division;
    response = await postJson(`/api/seasons/${season.id}/teams`, firstUserCookie, {
      name: `North Club ${crypto.randomUUID()}`, homeVenue: "The Local Club", divisionId: premier.id
    });
    assert.equal(response.status, 201);
    const northTeam = (await response.json()).team;
    assert.equal(northTeam.leagueId, approval.league.id, "The season route determines the team's league association.");
    response = await postJson(`/api/seasons/${season.id}/teams`, secondUserCookie, { name: `Independent Club ${crypto.randomUUID()}` });
    assert.equal(response.status, 201, "Teams can be created without a division.");
    const independentTeam = (await response.json()).team;
    assert.equal(independentTeam.divisionId, null);

    const otherSeason = await createSeason({ name: `Spring ${crypto.randomUUID()}` });
    const otherDivisionResponse = await postJson(`/api/seasons/${otherSeason.id}/divisions`, firstUserCookie, { name: "Other Premier" });
    assert.equal(otherDivisionResponse.status, 201);
    const otherDivision = (await otherDivisionResponse.json()).division;
    const undatedTeamResponse = await postJson(`/api/seasons/${otherSeason.id}/teams`, firstUserCookie, { name: `Undated ${crypto.randomUUID()}` });
    assert.equal(undatedTeamResponse.status, 201);
    const undatedTeam = (await undatedTeamResponse.json()).team;
    response = await postJson(`/api/teams/${undatedTeam.id}/members`, firstUserCookie, { userId: firstUserId });
    assert.equal(response.status, 409, "Registrations require an official season start date.");
    response = await postJson(`/api/seasons/${season.id}/teams`, firstUserCookie, {
      name: "Wrong Season Team", divisionId: otherDivision.id
    });
    assert.equal(response.status, 400, "A team cannot reference a division from another season.");
    response = await postJson(`/api/seasons/${season.id}/teams`, firstUserCookie, { name: northTeam.name.toUpperCase(), divisionId: secondDivision.id });
    assert.equal(response.status, 409, "Team names must be unique within a season regardless of division.");

    const seasonRow = await database.query(
      "SELECT league_id, created_by, status FROM seasons WHERE id = $1", [season.id]
    );
    assert.deepEqual(seasonRow.rows[0], { league_id: approval.league.id, created_by: firstUserId, status: "draft" },
      "Season ownership and league association must come from the authenticated request and route.");
    const teamRows = await database.query(
      "SELECT league_id, season_id, division_id FROM teams WHERE id = $1", [northTeam.id]
    );
    assert.deepEqual(teamRows.rows[0], { league_id: approval.league.id, season_id: season.id, division_id: premier.id });
    await assert.rejects(
      database.query(
        "INSERT INTO teams (league_id,season_id,name,created_by) VALUES ($1,$2,$3,$4)",
        [open.league.id, season.id, `Cross League ${crypto.randomUUID()}`, firstUserId]
      ),
      (error) => error.code === "23503" && error.constraint === "teams_season_league_fk",
      "The database must reject a team whose league does not own its season."
    );

    response = await patchJson(`/api/seasons/${season.id}`, firstUserCookie, { status: "completed" });
    assert.equal(response.status, 409, "A draft season cannot skip directly to completed.");
    response = await patchJson(`/api/seasons/${season.id}`, thirdUserCookie, { status: "active" });
    assert.equal(response.status, 403, "Only a league owner or administrator can change season status.");
    response = await patchJson(`/api/seasons/${season.id}`, secondUserCookie, { status: "active" });
    assert.equal(response.status, 200, "An administrator can activate a draft season.");
    response = await patchJson(`/api/seasons/${season.id}`, firstUserCookie, { status: "draft" });
    assert.equal(response.status, 409, "An active season cannot move backward to draft.");
    response = await postJson(`/api/seasons/${season.id}/divisions`, firstUserCookie, { name: "Late Division" });
    assert.equal(response.status, 409, "Division structure is frozen once a season is active.");
    response = await patchJson(`/api/teams/${northTeam.id}`, firstUserCookie, { name: "Renamed Too Late" });
    assert.equal(response.status, 409, "A team's season identity cannot change after activation.");

    const fourthUserCookie = await signUpPlayer("Fourth Player");
    response = await postJson(`/api/leagues/${approval.league.id}/join`, fourthUserCookie, {});
    assert.equal(response.status, 201);
    const fourthProfileResponse = await fetchFromSite("/api/me/profile", { headers: { cookie: fourthUserCookie } });
    const fourthProfile = (await fourthProfileResponse.json()).profile;
    response = await postJson(`/api/leagues/${approval.league.id}/requests/${fourthProfile.userId}`, firstUserCookie, { action: "approve" });
    assert.equal(response.status, 200, "Only an approved active league member may be eligible for a roster.");

    const fifthUserCookie = await signUpPlayer("Fifth Player");
    const fifthProfileResponse = await fetchFromSite("/api/me/profile", { headers: { cookie: fifthUserCookie } });
    const fifthProfile = (await fifthProfileResponse.json()).profile;
    const concurrentRosterChanges = await Promise.all([
      postJson(`/api/teams/${northTeam.id}/members`, firstUserCookie, { userId: thirdProfile.userId }),
      postJson(`/api/teams/${northTeam.id}/members`, firstUserCookie, { userId: thirdProfile.userId })
    ]);
    assert.ok(concurrentRosterChanges.every((item) => [200, 201].includes(item.status)), "Concurrent duplicate roster changes should be safe and idempotent.");
    const rosterResponses = await Promise.all(concurrentRosterChanges.map((item) => item.json()));
    assert.equal(rosterResponses.filter((item) => item.repeated).length, 1);
    response = await postJson(`/api/teams/${northTeam.id}/members`, firstUserCookie, { userId: secondProfile.userId });
    assert.equal(response.status, 201);
    response = await fetchFromSite("/api/me/leagues", { headers: { cookie: secondUserCookie } });
    const overlappingMembership = (await response.json()).leagues.find((league) => league.id === approval.league.id);
    assert.equal(overlappingMembership?.viewerMembership.role, "administrator");
    assert.equal(overlappingMembership?.viewerIsPlayer, true,
      "An administrator with an active team registration must appear in both My Leagues and Admin.");
    response = await fetchFromSite("/api/me/managed-leagues", { headers: { cookie: secondUserCookie } });
    assert.equal((await response.json()).leagues.find((league) => league.id === approval.league.id)?.viewerMembership.role, "administrator");
    response = await postJson(`/api/teams/${northTeam.id}/members`, thirdUserCookie, { userId: fourthProfile.userId });
    assert.equal(response.status, 403, "A player cannot edit a roster unless they are its captain or a league manager.");
    response = await postJson(`/api/teams/${northTeam.id}/members`, firstUserCookie, { userId: fifthProfile.userId });
    assert.equal(response.status, 409, "Roster additions require active membership in the same league.");
    await assert.rejects(
      database.query(
        "INSERT INTO team_memberships (team_id,user_id,role,status) VALUES ($1,$2,'player','active')",
        [northTeam.id, fifthProfile.userId]
      ),
      (error) => error.code === "23514" && error.constraint === "team_member_active_league_membership",
      "The database trigger must reject an ineligible active team member even if the API is bypassed."
    );

    response = await fetchFromSite(`/api/teams/${northTeam.id}/eligible-players`, { headers: { cookie: firstUserCookie } });
    assert.equal(response.status, 200);
    const eligiblePlayers = (await response.json()).players;
    assert.ok(eligiblePlayers.some((player) => player.id === thirdProfile.userId && player.onTeam));
    assert.ok(eligiblePlayers.some((player) => player.id === fifthProfile.userId) === false,
      "Non-members of the league must not appear in eligible roster choices.");

    response = await fetchFromSite(`/api/teams/${northTeam.id}/captain`, {
      method: "PUT", headers: { cookie: firstUserCookie, "content-type": "application/json" },
      body: JSON.stringify({ userId: fifthProfile.userId })
    });
    assert.equal(response.status, 409, "A captain must be selected from the active team roster.");
    response = await fetchFromSite(`/api/teams/${northTeam.id}/captain`, {
      method: "PUT", headers: { cookie: firstUserCookie, "content-type": "application/json" },
      body: JSON.stringify({ userId: thirdProfile.userId })
    });
    assert.equal(response.status, 200);
    response = await fetchFromSite("/api/me/managed-leagues", { headers: { cookie: thirdUserCookie } });
    assert.equal((await response.json()).leagues.some((league) => league.id === approval.league.id), false,
      "Team captaincy alone must not grant the league-wide Admin role.");
    response = await fetchFromSite("/api/platform/roles/admins", { headers: { cookie: thirdUserCookie } });
    assert.equal(response.status, 403, "Team captaincy alone does not grant platform role management.");
    await assertPlatformRoleMutationsDenied(thirdUserCookie, "A Team Captain without a platform role");
    await assert.rejects(
      platformRoles.assignRecoverySuperAdmin(thirdProfile.userId, fourthProfile.userId, "Team captain privilege check"),
      (error) => error instanceof PlatformRoleError && error.status === 403,
      "A Team Captain cannot assign a recovery Super Admin."
    );
    await assert.rejects(
      database.query("UPDATE team_memberships SET role = 'captain' WHERE team_id = $1 AND user_id = $2", [northTeam.id, secondProfile.userId]),
      (error) => error.code === "23505" && error.constraint === "team_memberships_single_active_captain",
      "The database must prevent two active captains from being assigned concurrently."
    );
    response = await postJson(`/api/teams/${northTeam.id}/members`, thirdUserCookie, { userId: fourthProfile.userId });
    assert.equal(response.status, 201, "The assigned captain can add an active member of the same league.");
    response = await postJson(`/api/teams/${independentTeam.id}/transfers`, thirdUserCookie, { userId: fourthProfile.userId });
    assert.equal(response.status, 403, "A team captain cannot transfer players between teams.");
    response = await postJson(`/api/teams/${northTeam.id}/members`, thirdUserCookie, { userId: fifthProfile.userId });
    assert.equal(response.status, 409, "A captain cannot add a player who has not joined the league.");
    response = await postJson(`/api/teams/${independentTeam.id}/members`, thirdUserCookie, { userId: fourthProfile.userId });
    assert.equal(response.status, 403, "A captain cannot manage another team's roster.");
    response = await fetchFromSite(`/api/teams/${northTeam.id}/members/${thirdProfile.userId}`, {
      method: "DELETE", headers: { cookie: thirdUserCookie }
    });
    assert.equal(response.status, 403, "A captain cannot remove a captain assignment.");

    response = await fetchFromSite(`/api/teams/${northTeam.id}/captain`, {
      method: "PUT", headers: { cookie: secondUserCookie, "content-type": "application/json" },
      body: JSON.stringify({ userId: secondProfile.userId })
    });
    assert.equal(response.status, 200, "An administrator can reassign the captain from the active roster.");
    const captainRows = await database.query(
      `SELECT user_id, role FROM team_memberships WHERE team_id = $1 AND status = 'active' AND role = 'captain'`,
      [northTeam.id]
    );
    assert.deepEqual(captainRows.rows, [{ user_id: secondProfile.userId, role: "captain" }],
      "There must be only one active captain after a reassignment.");
    response = await fetchFromSite(`/api/teams/${northTeam.id}/captain`, {
      method: "DELETE", headers: { cookie: thirdUserCookie }
    });
    assert.equal(response.status, 403, "A team captain cannot unassign captains.");
    response = await fetchFromSite(`/api/teams/${northTeam.id}/captain`, {
      method: "DELETE", headers: { cookie: firstUserCookie }
    });
    assert.equal(response.status, 200, "A league owner can unassign the current captain.");

    response = await signingPostJson(`/api/leagues/${approval.league.id}/join`, fifthUserCookie, {});
    assert.equal(response.status, 201, "A player can request membership before signing for a team.");
    await response.json();
    response = await signingPostJson(`/api/leagues/${approval.league.id}/requests/${fifthProfile.userId}`, firstUserCookie, { action: "approve" });
    assert.equal(response.status, 200);

    const createSigningTeam = async (seasonId, name) => {
      const created = await signingPostJson(`/api/seasons/${seasonId}/teams`, firstUserCookie, { name: `${name} ${crypto.randomUUID()}` });
      assert.equal(created.status, 201, await created.clone().text());
      return (await created.json()).team;
    };
    const preseasonResponse = await signingPostJson(`/api/leagues/${approval.league.id}/seasons`, firstUserCookie, { name: `Preseason ${crypto.randomUUID()}`, startsOn: tomorrow });
    assert.equal(preseasonResponse.status, 201, await preseasonResponse.clone().text());
    const preseasonSeason = (await preseasonResponse.json()).season;
    const preseasonTeam = await createSigningTeam(preseasonSeason.id, "Preseason Team");
    response = await signingPostJson(`/api/teams/${preseasonTeam.id}/members`, firstUserCookie, { userId: thirdProfile.userId });
    assert.equal(response.status, 201);
    const preseasonRegistration = await database.query(
      "SELECT signing_type FROM team_registrations WHERE team_id=$1 AND user_id=$2 AND ended_at IS NULL",
      [preseasonTeam.id, thirdProfile.userId]
    );
    assert.equal(preseasonRegistration.rows[0].signing_type, "preseason", "A signing before the official start date is free.");
    response = await signingPatchJson(`/api/seasons/${preseasonSeason.id}`, firstUserCookie, { startsOn: new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10) });
    assert.equal(response.status, 409, "The official start date cannot be moved after registrations begin.");

    const signingSeasonResponse = await signingPostJson(`/api/leagues/${approval.league.id}/seasons`, firstUserCookie, { name: `Signing Rules ${crypto.randomUUID()}`, startsOn: yesterday });
    assert.equal(signingSeasonResponse.status, 201, await signingSeasonResponse.clone().text());
    const signingSeason = (await signingSeasonResponse.json()).season;
    const sourceTeam = await createSigningTeam(signingSeason.id, "Transfer Source");
    const cappedTeam = await createSigningTeam(signingSeason.id, "Capped Team");
    const receivingTeam = await createSigningTeam(signingSeason.id, "Receiving Team");
    const concurrentTeamOne = await createSigningTeam(signingSeason.id, "Concurrent Team One");
    const concurrentTeamTwo = await createSigningTeam(signingSeason.id, "Concurrent Team Two");
    const concurrentTeamThree = await createSigningTeam(signingSeason.id, "Concurrent Team Three");
    response = await signingPostJson(`/api/teams/${sourceTeam.id}/members`, firstUserCookie, { userId: firstUserId, reason: "x".repeat(501) });
    assert.equal(response.status, 400, "Invalid signing requests are rejected before database writes.");
    response = await signingPostJson(`/api/teams/${sourceTeam.id}/members`, firstUserCookie, { userId: firstUserId, startedAt: "2000-01-01T00:00:00Z" });
    assert.equal(response.status, 201, "The first post-start signing is accepted.");
    const nonBackdated = await database.query("SELECT started_at >= now() - interval '1 minute' AS current_time FROM team_registrations WHERE team_id=$1 AND user_id=$2 AND ended_at IS NULL", [sourceTeam.id, firstUserId]);
    assert.equal(nonBackdated.rows[0].current_time, true, "Client supplied dates cannot backdate a signing.");
    for (const playerId of [secondProfile.userId, thirdProfile.userId, fourthProfile.userId]) {
      response = await signingPostJson(`/api/teams/${cappedTeam.id}/members`, firstUserCookie, { userId: playerId });
      assert.equal(response.status, 201, "Each of the first three post-start signings is accepted.");
    }
    response = await signingPostJson(`/api/teams/${cappedTeam.id}/transfers`, firstUserCookie, { userId: firstUserId, reason: "Test transfer" });
    assert.equal(response.status, 409, "A transfer into a team consumes a signing slot and the fourth is rejected.");
    let registrationState = await database.query(
      "SELECT team_id,ended_at FROM team_registrations WHERE league_id=$1 AND season_id=$2 AND user_id=$3 ORDER BY started_at",
      [approval.league.id, signingSeason.id, firstUserId]
    );
    assert.equal(registrationState.rows.length, 1);
    assert.equal(registrationState.rows[0].team_id, sourceTeam.id);
    assert.equal(registrationState.rows[0].ended_at, null, "A failed transfer leaves the source registration intact.");

    response = await signingPostJson(`/api/teams/${receivingTeam.id}/transfers`, firstUserCookie, { userId: firstUserId, reason: "Approved move" });
    assert.equal(response.status, 201, "A league owner can atomically transfer a player.");
    assert.equal((await response.json()).signing.signing_type, "transfer");
    response = await signingPostJson(`/api/teams/${receivingTeam.id}/members`, firstUserCookie, { userId: firstUserId });
    assert.equal(response.status, 200, "Repeating an active signing is idempotent and does not use another slot.");
    response = await fetchFromSite(`/api/teams/${receivingTeam.id}/members/${firstUserId}`, { method: "DELETE", headers: { cookie: firstUserCookie, "x-forwarded-for": signingTestIp } });
    assert.equal(response.status, 200);
    response = await fetchFromSite(`/api/teams/${receivingTeam.id}/members/${firstUserId}`, { method: "DELETE", headers: { cookie: firstUserCookie, "x-forwarded-for": signingTestIp } });
    assert.equal(response.status, 404, "Repeated removal is rejected and does not alter history.");
    response = await signingPostJson(`/api/teams/${receivingTeam.id}/members`, firstUserCookie, { userId: firstUserId, reason: "Return signing one" });
    assert.equal(response.status, 201, "A former player can sign back on and consume another slot.");
    assert.equal((await response.json()).signing.signing_type, "return_signing");
    response = await fetchFromSite(`/api/teams/${receivingTeam.id}/members/${firstUserId}`, { method: "DELETE", headers: { cookie: firstUserCookie, "x-forwarded-for": signingTestIp } });
    assert.equal(response.status, 200);
    response = await signingPostJson(`/api/teams/${receivingTeam.id}/members`, firstUserCookie, { userId: firstUserId, reason: "Return signing two" });
    assert.equal(response.status, 201);
    response = await fetchFromSite(`/api/teams/${receivingTeam.id}/members/${firstUserId}`, { method: "DELETE", headers: { cookie: firstUserCookie, "x-forwarded-for": signingTestIp } });
    assert.equal(response.status, 200);
    response = await signingPostJson(`/api/teams/${receivingTeam.id}/members`, firstUserCookie, { userId: fifthProfile.userId });
    assert.equal(response.status, 409, "Transfers and repeat signings permanently consume all three team slots.");
    const registrationHistory = await database.query(
      "SELECT id,signing_type,started_at,ended_at,authorized_by FROM team_registrations WHERE team_id=$1 AND user_id=$2 ORDER BY started_at",
      [receivingTeam.id, firstUserId]
    );
    assert.equal(registrationHistory.rows.length, 3);
    assert.deepEqual(registrationHistory.rows.map(({ signing_type }) => signing_type), ["transfer", "return_signing", "return_signing"]);
    assert.equal(registrationHistory.rows.every((entry) => entry.authorized_by === firstUserId), true);
    assert.equal(registrationHistory.rows.every((entry) => entry.ended_at !== null), true, "Removals preserve signed registration history.");
    const transferredOut = await database.query(
      "SELECT end_event_type,ended_by,end_reason FROM team_registrations WHERE team_id=$1 AND user_id=$2 AND ended_at IS NOT NULL",
      [sourceTeam.id, firstUserId]
    );
    assert.deepEqual(transferredOut.rows[0], { end_event_type: "transferred_out", ended_by: firstUserId, end_reason: "Approved move" });
    response = await fetchFromSite(`/api/teams/${receivingTeam.id}/signing-history`, { headers: { cookie: firstUserCookie } });
    assert.equal(response.status, 200);
    const teamEvents = (await response.json()).events;
    assert.ok(teamEvents.length >= 6, "The manager can inspect signing and end events after roster changes.");
    await assert.rejects(
      database.query("DELETE FROM team_registrations WHERE id=$1", [registrationHistory.rows[0].id]),
      (error) => error.code === "55000" && error.constraint === "team_registration_history_immutable",
      "Registration rows cannot be erased after removal or transfer."
    );
    await assert.rejects(
      database.query("DELETE FROM team_registration_events WHERE id=$1", [teamEvents[0].id]),
      (error) => error.code === "55000",
      "Registration events are append-only."
    );

    const competingSignings = await Promise.all([
      signingPostJson(`/api/teams/${concurrentTeamOne.id}/members`, firstUserCookie, { userId: fifthProfile.userId }),
      signingPostJson(`/api/teams/${concurrentTeamTwo.id}/members`, firstUserCookie, { userId: fifthProfile.userId })
    ]);
    assert.equal(competingSignings.filter((item) => item.status === 201).length, 1, "Concurrent signings to different teams serialize to one active registration.");
    assert.equal(competingSignings.filter((item) => item.status === 409).length, 1);
    const winningTeam = competingSignings[0].status === 201 ? concurrentTeamOne : concurrentTeamTwo;
    const racingTransfers = await Promise.all([
      signingPostJson(`/api/teams/${concurrentTeamTwo.id === winningTeam.id ? concurrentTeamThree.id : concurrentTeamTwo.id}/transfers`, firstUserCookie, { userId: fifthProfile.userId }),
      signingPostJson(`/api/teams/${concurrentTeamThree.id === winningTeam.id ? concurrentTeamTwo.id : concurrentTeamThree.id}/transfers`, firstUserCookie, { userId: fifthProfile.userId })
    ]);
    const racingTransferResults = await Promise.all(racingTransfers.map(async (item) => ({ status: item.status, body: await item.clone().text() })));
    assert.ok(racingTransfers.every((item) => item.status === 201),
      `Concurrent authorised transfers are serialized as sequential, non-overlapping history: ${JSON.stringify(racingTransferResults)}`);
    const activeRegistration = await database.query(
      "SELECT team_id FROM team_registrations WHERE league_id=$1 AND season_id=$2 AND user_id=$3 AND ended_at IS NULL",
      [approval.league.id, signingSeason.id, fifthProfile.userId]
    );
    assert.equal(activeRegistration.rows.length, 1);
    const overlapCount = await database.query(
      `SELECT count(*)::integer AS count FROM team_registrations a JOIN team_registrations b
       ON a.league_id=b.league_id AND a.season_id=b.season_id AND a.user_id=b.user_id AND a.id<b.id
       AND tstzrange(a.started_at,coalesce(a.ended_at,'infinity'::timestamptz),'[)') &&
           tstzrange(b.started_at,coalesce(b.ended_at,'infinity'::timestamptz),'[)')
       WHERE a.league_id=$1 AND a.season_id=$2`,
      [approval.league.id, signingSeason.id]
    );
    assert.equal(overlapCount.rows[0].count, 0, "Registration intervals never overlap, including concurrent transfers.");

    response = await fetchFromSite(`/api/leagues/${approval.league.id}/competition`, { headers: { cookie: firstUserCookie } });
    assert.equal(response.status, 200);
    let competition = (await response.json()).competition;
    assert.ok(competition.seasons.some((item) => item.id === season.id && item.divisions.some((division) => division.id === premier.id)));
    assert.ok(competition.seasons.find((item) => item.id === season.id).teams.some((item) => item.id === independentTeam.id && item.divisionId === null));
    response = await fetchFromSite(`/api/leagues/${approval.league.id}/competition`);
    assert.equal(response.status, 200);
    competition = (await response.json()).competition;
    assert.equal(competition.seasons.some((item) => item.id === otherSeason.id), false,
      "Draft seasons remain private to league managers.");

    // Match Engine Phase 1 uses only the disposable local PostgreSQL test database.
    const matchPostJson = (path, sessionCookie, body, extraHeaders = {}) => fetchFromSite(path, {
      method: "POST", headers: { cookie: sessionCookie, "content-type": "application/json", "x-forwarded-for": "203.0.113.141", ...extraHeaders },
      body: JSON.stringify(body)
    });
    const matchPutJson = (path, sessionCookie, body) => fetchFromSite(path, {
      method: "PUT", headers: { cookie: sessionCookie, "content-type": "application/json", "x-forwarded-for": "203.0.113.142" },
      body: JSON.stringify(body)
    });
    const matchPatchJson = (path, sessionCookie, body) => fetchFromSite(path, {
      method: "PATCH", headers: { cookie: sessionCookie, "content-type": "application/json", "x-forwarded-for": "203.0.113.143" },
      body: JSON.stringify(body)
    });
    const matchSeasonResponse = await signingPostJson(`/api/leagues/${approval.league.id}/seasons`, firstUserCookie, {
      name: `Match Engine ${crypto.randomUUID()}`, startsOn: yesterday, endsOn: "2027-10-13"
    });
    assert.equal(matchSeasonResponse.status, 201, await matchSeasonResponse.clone().text());
    const matchSeason = (await matchSeasonResponse.json()).season;
    const homeMatchTeam = await createSigningTeam(matchSeason.id, "Match Home");
    const awayMatchTeam = await createSigningTeam(matchSeason.id, "Match Away");
    for (const [team, playerId] of [
      [homeMatchTeam, firstUserId], [homeMatchTeam, secondProfile.userId],
      [awayMatchTeam, thirdProfile.userId], [awayMatchTeam, fourthProfile.userId]
    ]) {
      response = await signingPostJson(`/api/teams/${team.id}/members`, firstUserCookie, { userId: playerId });
      assert.equal(response.status, 201, await response.clone().text());
    }
    const homePlayerRole = await database.query(
      "SELECT role FROM team_memberships WHERE team_id=$1 AND user_id=$2 AND status='active'", [homeMatchTeam.id, firstUserId]
    );
    assert.equal(homePlayerRole.rows[0]?.role, "player", "The home-side scorer is not a captain.");
    const otherMatchTeam = await createSigningTeam(matchSeason.id, "Match Other");
    response = await signingPostJson(`/api/teams/${otherMatchTeam.id}/members`, firstUserCookie, { userId: fifthProfile.userId });
    assert.equal(response.status, 201, await response.clone().text());
    response = await fetchFromSite("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "192.0.2.246" },
      body: JSON.stringify({
        name: "Other League Match Player",
        email: `other-league-match-${crypto.randomUUID()}@example.test`,
        password: "correct-horse-battery-staple"
      })
    });
    assert.equal(response.status, 200, await response.clone().text());
    const otherLeaguePlayerCookie = cookieFrom(response);
    response = await signingPostJson(`/api/leagues/${open.league.id}/join`, otherLeaguePlayerCookie, {});
    assert.ok([200, 201].includes(response.status), await response.clone().text());
    const otherLeaguePlayerSession = await fetchFromSite("/api/me", { headers: { cookie: otherLeaguePlayerCookie } });
    const otherLeaguePlayerId = (await otherLeaguePlayerSession.json()).user.id;
    response = await fetchFromSite(`/api/leagues/${open.league.id}/members/${otherLeaguePlayerId}/role`, {
      method: "PATCH", headers: { cookie: firstUserCookie, "content-type": "application/json" },
      body: JSON.stringify({ role: "administrator" })
    });
    assert.equal(response.status, 200, "The other account has administrator authority only in its own league.");

    const formatV1Frames = ["singles", "singles", "doubles", "singles", "doubles"].map((type) => ({ type }));
    response = await matchPutJson(`/api/leagues/${approval.league.id}/match-format`, firstUserCookie, {
      name: "Match engine integration format v1", frames: formatV1Frames
    });
    assert.equal(response.status, 200, await response.clone().text());

    const roundRobinPostJson = (path, sessionCookie, body) => fetchFromSite(path, {
      method: "POST", headers: { cookie: sessionCookie, "content-type": "application/json", "x-forwarded-for": "203.0.113.244" },
      body: JSON.stringify(body)
    });
    const rrPath = `/api/leagues/${approval.league.id}/seasons`;
    const rrSeasonResponse = await signingPostJson(rrPath, firstUserCookie, {
      name: `Round Robin ${crypto.randomUUID()}`, startsOn: tomorrow, endsOn: "2027-10-13"
    });
    assert.equal(rrSeasonResponse.status, 201, await rrSeasonResponse.clone().text());
    const rrSeason = (await rrSeasonResponse.json()).season;
    const createRoundRobinDivision = async (name) => {
      const created = await signingPostJson(`/api/seasons/${rrSeason.id}/divisions`, firstUserCookie, { name });
      assert.equal(created.status, 201, await created.clone().text());
      return (await created.json()).division;
    };
    const rrTeamDivision = await createRoundRobinDivision("Round Robin Teams");
    const rrTeamReturnDivision = await createRoundRobinDivision("Round Robin Return Leg");
    const rrSinglesDivision = await createRoundRobinDivision("Round Robin Singles");
    const rrDoublesDivision = await createRoundRobinDivision("Round Robin Doubles");
    const createRoundRobinTeam = async (divisionId, label, homeVenue) => {
      const created = await signingPostJson(`/api/seasons/${rrSeason.id}/teams`, firstUserCookie, {
        name: `${label} ${crypto.randomUUID()}`, divisionId, homeVenue
      });
      assert.equal(created.status, 201, await created.clone().text());
      return (await created.json()).team;
    };
    const rrTeams = [];
    for (let index = 1; index <= 5; index++) rrTeams.push(await createRoundRobinTeam(rrTeamDivision.id, `RR Team ${index}`, `Venue ${index}`));
    const rrReturnTeams = [];
    for (let index = 1; index <= 4; index++) rrReturnTeams.push(await createRoundRobinTeam(rrTeamReturnDivision.id, `RR Return Team ${index}`, `Return Venue ${index}`));

    const sixthRegistration = await fetchFromSite("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.243" },
      body: JSON.stringify({
        name: "Sixth RR Player", email: `sixth-rr-${crypto.randomUUID()}@example.test`,
        password: "correct-horse-battery-staple"
      })
    });
    assert.equal(sixthRegistration.status, 200, await sixthRegistration.clone().text());
    const sixthUserCookie = cookieFrom(sixthRegistration);
    const sixthProfileResponse = await fetchFromSite("/api/me/profile", { headers: { cookie: sixthUserCookie } });
    assert.equal(sixthProfileResponse.status, 200);
    const sixthProfile = (await sixthProfileResponse.json()).profile;
    response = await signingPostJson(`/api/leagues/${approval.league.id}/join`, sixthUserCookie, {});
    assert.equal(response.status, 201);
    response = await signingPostJson(`/api/leagues/${approval.league.id}/requests/${sixthProfile.userId}`, firstUserCookie, { action: "approve" });
    assert.equal(response.status, 200);

    const createSinglesEntry = async (userId, entryStatus = "approved") => {
      const entryClient = await database.connect();
      try {
        await entryClient.query("BEGIN");
        await entryClient.query("SELECT set_config('breakdish.actor_user_id',$1,true)", [firstUserId]);
        const inserted = await entryClient.query(
          `INSERT INTO competition_entries(entry_type,league_id,season_id,created_by)
           VALUES('singles_league',$1,$2,$3) RETURNING id`, [approval.league.id, rrSeason.id, firstUserId]
        );
        const entryId = inserted.rows[0].id;
        await entryClient.query(
          "INSERT INTO competition_entry_participants(entry_id,user_id,added_by) VALUES($1,$2,$3)",
          [entryId, userId, firstUserId]
        );
        if (entryStatus === "approved") {
          await entryClient.query("UPDATE competition_entries SET status='payment_confirmed' WHERE id=$1", [entryId]);
          await entryClient.query("UPDATE competition_entries SET status='approved' WHERE id=$1", [entryId]);
        }
        await entryClient.query("COMMIT");
        return entryId;
      } catch (error) {
        await entryClient.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        entryClient.release();
      }
    };
    const rrSingles = [firstUserId, secondProfile.userId, thirdProfile.userId];
    for (const playerId of rrSingles) await createSinglesEntry(playerId);
    const pendingSinglesPlayerId = fourthProfile.userId;
    await createSinglesEntry(pendingSinglesPlayerId, "pending");
    const rrDoublesEntries = [
      await createDoublesEntry(approval.league.id, rrSeason.id, [firstUserId, secondProfile.userId]),
      await createDoublesEntry(approval.league.id, rrSeason.id, [thirdProfile.userId, fourthProfile.userId]),
      await createDoublesEntry(approval.league.id, rrSeason.id, [fifthProfile.userId, sixthProfile.userId])
    ];

    const rrParticipantsPath = `/api/leagues/${approval.league.id}/seasons/${rrSeason.id}/round-robin/participants`;
    response = await fetchFromSite(rrParticipantsPath);
    assert.equal(response.status, 401, "Anonymous visitors cannot read organiser participant choices.");
    response = await fetchFromSite(rrParticipantsPath, { headers: { cookie: thirdUserCookie } });
    assert.equal(response.status, 403, "Ordinary members cannot read organiser participant choices.");
    response = await fetchFromSite(rrParticipantsPath, { headers: { cookie: firstUserCookie } });
    assert.equal(response.status, 200, await response.clone().text());
    const rrEligible = (await response.json()).participants;
    assert.equal(rrEligible.teams.length, 9);
    assert.equal(rrEligible.singles.length, 3, "Only approved Singles League entries are selectable.");
    assert.equal(rrEligible.singles.some((entry) => entry.id === pendingSinglesPlayerId), false);
    assert.deepEqual(rrEligible.doubles.map((entry) => entry.id).sort(), rrDoublesEntries.sort());
    assert.ok(rrEligible.doubles.every((entry) => entry.players.length === 2));

    const rrStartAt = new Date(Date.now() + 45 * 86400000).toISOString();
    const teamRoundRobin = {
      type: "team_league", divisionId: rrTeamDivision.id, meetings: 1,
      participantIds: rrTeams.map((team) => team.id), firstScheduledAt: rrStartAt, intervalDays: 7,
      defaultVenue: "Fallback venue"
    };
    response = await roundRobinPostJson(`/api/leagues/${approval.league.id}/seasons/${rrSeason.id}/round-robin/preview`, "", teamRoundRobin);
    assert.equal(response.status, 401, "Anonymous visitors cannot preview schedules.");
    response = await roundRobinPostJson(`/api/leagues/${approval.league.id}/seasons/${rrSeason.id}/round-robin/preview`, thirdUserCookie, teamRoundRobin);
    assert.equal(response.status, 403, "Ordinary members cannot preview schedules.");
    response = await roundRobinPostJson(`/api/leagues/${approval.league.id}/seasons/${rrSeason.id}/round-robin/save`, "", teamRoundRobin);
    assert.equal(response.status, 401, "Anonymous visitors cannot save schedules.");
    response = await roundRobinPostJson(`/api/leagues/${approval.league.id}/seasons/${rrSeason.id}/round-robin/save`, thirdUserCookie, {
      ...teamRoundRobin, formatVersion: 1
    });
    assert.equal(response.status, 403, "Ordinary members cannot save schedules.");
    response = await roundRobinPostJson(`/api/leagues/${approval.league.id}/seasons/${rrSeason.id}/round-robin/preview`, firstUserCookie, teamRoundRobin);
    assert.equal(response.status, 200, await response.clone().text());
    let rrPreview = (await response.json()).preview;
    assert.equal(rrPreview.fixtureCount, 5 * 4 / 2);
    assert.equal(rrPreview.roundCount, 5);
    assert.equal(rrPreview.rounds.reduce((sum, round) => sum + round.fixtures.length, 0), 10);
    assert.ok(rrPreview.rounds.every((round) => round.fixtures.length === 2 && round.bye));
    assert.equal(rrPreview.format.version, 1);
    assert.equal(rrPreview.rounds.flatMap((round) => round.fixtures).some((fixture) => !fixture.sideOne.id || !fixture.sideTwo.id), false,
      "A bye is shown separately and never creates a fake match.");
    let rrDatabaseCount = await database.query("SELECT count(*)::integer AS count FROM matches WHERE season_id=$1 AND match_type='team_league'", [rrSeason.id]);
    assert.equal(rrDatabaseCount.rows[0].count, 0, "Generating a preview performs no match inserts.");
    assert.ok(rrPreview.rounds.flatMap((round) => round.fixtures).every((fixture) => fixture.venue === rrTeams.find((team) => team.id === fixture.sideOne.id).homeVenue),
      "Team fixtures use the home team's existing home venue where available.");
    const teamSaveBody = { ...teamRoundRobin, formatVersion: rrPreview.format.version };
    const teamSaveResponse = await roundRobinPostJson(`/api/leagues/${approval.league.id}/seasons/${rrSeason.id}/round-robin/save`, firstUserCookie, teamSaveBody);
    assert.equal(teamSaveResponse.status, 201, await teamSaveResponse.clone().text());
    const teamSaved = await teamSaveResponse.json();
    assert.equal(teamSaved.savedCount, 10);
    assert.equal(teamSaved.removedCount, 0);
    const teamRoundRows = await database.query(
      `SELECT round_number, home_team_id, away_team_id, venue FROM matches
       WHERE season_id=$1 AND division_id=$2 AND match_type='team_league' ORDER BY round_number, id`,
      [rrSeason.id, rrTeamDivision.id]
    );
    assert.equal(teamRoundRows.rows.length, 10);
    assert.deepEqual([...new Set(teamRoundRows.rows.map((row) => row.round_number))].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
    assert.ok(teamRoundRows.rows.every((row) => rrTeams.some((team) => team.id === row.home_team_id && team.homeVenue === row.venue)));
    const listedRoundMatch = await fetchFromSite(`/api/matches?leagueId=${approval.league.id}`);
    assert.equal(listedRoundMatch.status, 200);
    const publicRoundMatch = (await listedRoundMatch.json()).matches.find((match) => match.id === teamSaved.matches[0].id);
    assert.equal(publicRoundMatch?.roundNumber, teamSaved.matches[0].roundNumber,
      "Match Centre listing exposes the saved round identifier.");
    const detailedRoundMatch = await fetchFromSite(`/api/matches/${teamSaved.matches[0].id}`);
    assert.equal((await detailedRoundMatch.json()).match.roundNumber, teamSaved.matches[0].roundNumber,
      "Match details expose the saved round identifier.");
    await assert.rejects(
      database.query("UPDATE matches SET round_number=round_number+1 WHERE id=$1", [teamSaved.matches[0].id]),
      (error) => error.constraint === "matches_round_number_immutable",
      "Persisted fixture rounds cannot be silently rewritten."
    );

    const teamDoubleRoundRobin = {
      ...teamRoundRobin, divisionId: rrTeamReturnDivision.id, meetings: 2,
      participantIds: rrReturnTeams.map((team) => team.id)
    };
    response = await roundRobinPostJson(`/api/leagues/${approval.league.id}/seasons/${rrSeason.id}/round-robin/preview`, firstUserCookie, teamDoubleRoundRobin);
    assert.equal(response.status, 200, await response.clone().text());
    rrPreview = (await response.json()).preview;
    assert.equal(rrPreview.fixtureCount, 4 * 3);
    assert.equal(rrPreview.roundCount, 6);
    for (const round of rrPreview.rounds.slice(0, 3)) {
      const returnRound = rrPreview.rounds[round.roundNumber + 2];
      assert.ok(round.fixtures.every((fixture) => returnRound.fixtures.some((candidate) =>
        candidate.sideOne.id === fixture.sideTwo.id && candidate.sideTwo.id === fixture.sideOne.id)),
      "The second meeting reverses each home/away side.");
    }
    const teamDoubleSaveBody = { ...teamDoubleRoundRobin, formatVersion: rrPreview.format.version };
    const concurrentTeamSaves = await Promise.all([
      roundRobinPostJson(`/api/leagues/${approval.league.id}/seasons/${rrSeason.id}/round-robin/save`, firstUserCookie, teamDoubleSaveBody),
      roundRobinPostJson(`/api/leagues/${approval.league.id}/seasons/${rrSeason.id}/round-robin/save`, firstUserCookie, teamDoubleSaveBody)
    ]);
    assert.deepEqual(concurrentTeamSaves.map((item) => item.status).sort(), [201, 409],
      "Concurrent duplicate saves serialize; exactly one complete schedule is accepted.");
    const teamDoubleSavedResponse = concurrentTeamSaves.find((item) => item.status === 201);
    const teamDoubleSaved = await teamDoubleSavedResponse.json();
    assert.equal(teamDoubleSaved.savedCount, 12);
    rrDatabaseCount = await database.query("SELECT count(*)::integer AS count FROM matches WHERE season_id=$1 AND division_id=$2 AND match_type='team_league'", [rrSeason.id, rrTeamReturnDivision.id]);
    assert.equal(rrDatabaseCount.rows[0].count, 12, "The losing concurrent save leaves no partial fixtures.");

    const maliciousSinglesBody = {
      type: "singles_league", divisionId: rrSinglesDivision.id, meetings: 1,
      participantIds: [...rrSingles, pendingSinglesPlayerId], firstScheduledAt: rrStartAt, intervalDays: 7
    };
    response = await roundRobinPostJson(`/api/leagues/${approval.league.id}/seasons/${rrSeason.id}/round-robin/preview`, firstUserCookie, maliciousSinglesBody);
    assert.equal(response.status, 409, "Pending Singles entries cannot be included in a generated schedule.");
    const singlesRoundRobin = { ...maliciousSinglesBody, participantIds: rrSingles };
    response = await roundRobinPostJson(`/api/leagues/${approval.league.id}/seasons/${rrSeason.id}/round-robin/preview`, firstUserCookie, singlesRoundRobin);
    assert.equal(response.status, 200, await response.clone().text());
    rrPreview = (await response.json()).preview;
    assert.equal(rrPreview.fixtureCount, 3);
    assert.equal(rrPreview.roundCount, 3);
    assert.ok(rrPreview.rounds.every((round) => round.fixtures.length === 1 && round.bye),
      "Odd Singles participation produces one explicit bye per round and no fake player match.");
    const singlesSave = await roundRobinPostJson(`/api/leagues/${approval.league.id}/seasons/${rrSeason.id}/round-robin/save`, firstUserCookie,
      { ...singlesRoundRobin, formatVersion: rrPreview.format.version });
    assert.equal(singlesSave.status, 201, await singlesSave.clone().text());
    assert.equal((await singlesSave.json()).savedCount, 3);
    const singlesRows = await database.query(
      `SELECT m.round_number, count(mp.user_id)::integer AS player_count, s.template_version
       FROM matches m JOIN match_participants mp ON mp.match_id=m.id
       JOIN match_format_snapshots s ON s.match_id=m.id
       WHERE m.season_id=$1 AND m.division_id=$2 AND m.match_type='singles_league'
       GROUP BY m.id,m.round_number,s.template_version ORDER BY m.round_number`, [rrSeason.id, rrSinglesDivision.id]
    );
    assert.equal(singlesRows.rows.length, 3);
    assert.ok(singlesRows.rows.every((row) => row.player_count === 2 && row.template_version === 1));

    const doublesRoundRobin = {
      type: "doubles_league", divisionId: rrDoublesDivision.id, meetings: 2,
      participantIds: rrDoublesEntries, firstScheduledAt: rrStartAt, intervalDays: 7,
      defaultVenue: "Doubles test hall"
    };
    response = await roundRobinPostJson(`/api/leagues/${approval.league.id}/seasons/${rrSeason.id}/round-robin/preview`, firstUserCookie, doublesRoundRobin);
    assert.equal(response.status, 200, await response.clone().text());
    rrPreview = (await response.json()).preview;
    assert.equal(rrPreview.fixtureCount, 3 * 2);
    assert.equal(rrPreview.roundCount, 6);
    assert.ok(rrPreview.rounds.every((round) => round.fixtures.length === 1 && round.bye),
      "Odd Doubles participation produces explicit pair byes without a fake pair.");
    for (const round of rrPreview.rounds.slice(0, 3)) {
      const returnRound = rrPreview.rounds[round.roundNumber + 2];
      assert.ok(round.fixtures.every((fixture) => returnRound.fixtures.some((candidate) =>
        candidate.sideOne.id === fixture.sideTwo.id && candidate.sideTwo.id === fixture.sideOne.id)));
    }
    const doublesSave = await roundRobinPostJson(`/api/leagues/${approval.league.id}/seasons/${rrSeason.id}/round-robin/save`, firstUserCookie,
      { ...doublesRoundRobin, formatVersion: rrPreview.format.version });
    assert.equal(doublesSave.status, 201, await doublesSave.clone().text());
    const doublesSaved = await doublesSave.json();
    assert.equal(doublesSaved.savedCount, 6);
    const doublesRoundRows = await database.query(
      `SELECT m.round_number, count(DISTINCT s.entry_id)::integer AS sides,
         count(DISTINCT mp.user_id)::integer AS players, fs.template_version
       FROM matches m JOIN match_doubles_league_sides s ON s.match_id=m.id
       JOIN match_participants mp ON mp.match_id=m.id JOIN match_format_snapshots fs ON fs.match_id=m.id
       WHERE m.season_id=$1 AND m.division_id=$2 AND m.match_type='doubles_league'
       GROUP BY m.id,m.round_number,fs.template_version ORDER BY m.round_number`, [rrSeason.id, rrDoublesDivision.id]
    );
    assert.equal(doublesRoundRows.rows.length, 6);
    assert.ok(doublesRoundRows.rows.every((row) => row.sides === 2 && row.players === 4 && row.template_version === 1),
      "Generated Doubles fixtures preserve two approved entry sides and four historical player snapshots with the current format.");
    const teamCountBeforeRetry = await database.query("SELECT count(*)::integer AS count FROM matches WHERE season_id=$1 AND division_id=$2 AND match_type='team_league'", [rrSeason.id, rrTeamReturnDivision.id]);
    response = await roundRobinPostJson(`/api/leagues/${approval.league.id}/seasons/${rrSeason.id}/round-robin/save`, firstUserCookie, teamDoubleSaveBody);
    assert.equal(response.status, 409, "A repeated generator request is rejected rather than duplicating fixtures.");
    const teamCountAfterRetry = await database.query("SELECT count(*)::integer AS count FROM matches WHERE season_id=$1 AND division_id=$2 AND match_type='team_league'", [rrSeason.id, rrTeamReturnDivision.id]);
    assert.equal(teamCountAfterRetry.rows[0].count, teamCountBeforeRetry.rows[0].count);

    const collisionDivisionResponse = await signingPostJson(`/api/seasons/${rrSeason.id}/divisions`, firstUserCookie, { name: "Manual collision" });
    assert.equal(collisionDivisionResponse.status, 201);
    const collisionDivision = (await collisionDivisionResponse.json()).division;
    const collisionTeams = [
      await createRoundRobinTeam(collisionDivision.id, "Manual collision A", "Existing Hall"),
      await createRoundRobinTeam(collisionDivision.id, "Manual collision B", "Other Hall")
    ];
    const manualCollision = await matchPostJson("/api/matches", firstUserCookie, {
      type: "team_league", leagueId: approval.league.id, seasonId: rrSeason.id, divisionId: collisionDivision.id,
      homeTeamId: collisionTeams[0].id, awayTeamId: collisionTeams[1].id, scheduledAt: rrStartAt
    });
    assert.equal(manualCollision.status, 201, await manualCollision.clone().text());
    const manualCollisionMatch = (await manualCollision.json()).match;
    assert.equal(manualCollisionMatch.roundNumber, null, "Manually created historical fixtures do not receive invented round numbers.");
    const collisionSchedule = {
      ...teamRoundRobin, divisionId: collisionDivision.id, participantIds: collisionTeams.map((team) => team.id)
    };
    response = await roundRobinPostJson(`/api/leagues/${approval.league.id}/seasons/${rrSeason.id}/round-robin/preview`, firstUserCookie, collisionSchedule);
    assert.equal(response.status, 200);
    let collisionPreview = (await response.json()).preview;
    let collisionSave = await roundRobinPostJson(`/api/leagues/${approval.league.id}/seasons/${rrSeason.id}/round-robin/save`, firstUserCookie,
      { ...collisionSchedule, formatVersion: collisionPreview.format.version });
    assert.equal(collisionSave.status, 409, "A manual fixture collision is rejected without partial saves.");
    response = await matchPostJson(`/api/matches/${manualCollisionMatch.id}/cancel`, firstUserCookie, {});
    assert.equal(response.status, 200);
    response = await roundRobinPostJson(`/api/leagues/${approval.league.id}/seasons/${rrSeason.id}/round-robin/preview`, firstUserCookie, collisionSchedule);
    collisionPreview = (await response.json()).preview;
    collisionSave = await roundRobinPostJson(`/api/leagues/${approval.league.id}/seasons/${rrSeason.id}/round-robin/save`, firstUserCookie,
      { ...collisionSchedule, formatVersion: collisionPreview.format.version });
    assert.equal(collisionSave.status, 409, "Cancelled manual fixtures remain explicit duplicate conflicts.");
    assert.match((await collisionSave.json()).error, /including cancelled fixtures/i);
    const collisionGeneratedCount = await database.query("SELECT count(*)::integer AS count FROM matches WHERE season_id=$1 AND division_id=$2 AND match_type='team_league'", [rrSeason.id, collisionDivision.id]);
    assert.equal(collisionGeneratedCount.rows[0].count, 1, "Neither collision failure creates any round-robin fixture.");

    const createTeamMatch = async (cookie = firstUserCookie) => {
      const created = await matchPostJson("/api/matches", cookie, {
        type: "team_league", leagueId: approval.league.id, seasonId: matchSeason.id,
        homeTeamId: homeMatchTeam.id, awayTeamId: awayMatchTeam.id,
        scheduledAt: new Date(Date.now() + 30 * 86400000).toISOString(), venue: "Local test venue"
      });
      assert.equal(created.status, 201, await created.clone().text());
      return (await created.json()).match;
    };
    response = await matchPostJson("/api/matches", "", { type: "practice" });
    assert.equal(response.status, 401, "Anonymous users cannot create matches.");
    response = await matchPostJson("/api/matches", thirdUserCookie, { type: "team_league", leagueId: approval.league.id, seasonId: matchSeason.id });
    assert.equal(response.status, 403, "League members cannot create fixtures without manager permission.");

    const matchUnderTest = await createTeamMatch();
    const untouchedFutureMatch = await createTeamMatch();
    response = await fetchFromSite(`/api/leagues/${approval.league.id}/members/${sixthProfile.userId}/role`, {
      method: "PATCH", headers: { cookie: firstUserCookie, "content-type": "application/json" },
      body: JSON.stringify({ role: "administrator" })
    });
    assert.equal(response.status, 200, "A league manager can assign an audit-view-only organiser for the scoreboard privacy test.");
    response = await matchPostJson(`/api/matches/${untouchedFutureMatch.id}/start`, "", {});
    assert.equal(response.status, 401, "Anonymous visitors cannot start a scheduled match.");
    const nonCompetingMatch = await matchPostJson("/api/matches", firstUserCookie, {
      type: "team_league", leagueId: approval.league.id, seasonId: matchSeason.id,
      homeTeamId: awayMatchTeam.id, awayTeamId: otherMatchTeam.id,
      scheduledAt: new Date(Date.now() + 30 * 86400000).toISOString()
    });
    assert.equal(nonCompetingMatch.status, 201, await nonCompetingMatch.clone().text());
    const nonCompetingMatchId = (await nonCompetingMatch.json()).match.id;
    response = await matchPostJson(`/api/matches/${nonCompetingMatchId}/start`, firstUserCookie, {});
    assert.equal(response.status, 403, "A player registered to Team A cannot operate a different Team B v Team C fixture.");
    response = await matchPostJson(`/api/matches/${nonCompetingMatchId}/start`, secondUserCookie, {});
    assert.equal(response.status, 403, "League administrator status alone does not grant normal scoreboard access.");
    response = await matchPostJson(`/api/matches/${nonCompetingMatchId}/cancel`, firstUserCookie, {});
    assert.equal(response.status, 200, "The existing manager permission remains available for fixture administration.");
    response = await matchPostJson(`/api/matches/${matchUnderTest.id}/start`, otherLeaguePlayerCookie, {});
    assert.equal(response.status, 403, "An authenticated player from another league cannot operate this fixture.");
    await platformRoles.grantPlatformAdmin(superAdminUserId, fifthProfile.userId, "Match permission isolation test");
    assert.equal(await platformRoles.hasPlatformRole(fifthProfile.userId, "platform_admin"), true);
    response = await matchPostJson(`/api/matches/${matchUnderTest.id}/start`, fifthUserCookie, {});
    assert.equal(response.status, 403, "Platform Admin status does not let a registered Team C player operate Team A v Team B.");
    response = await matchPostJson("/api/matches", firstUserCookie, {
      type: "team_league", leagueId: approval.league.id, seasonId: matchSeason.id,
      homeTeamId: homeMatchTeam.id, awayTeamId: homeMatchTeam.id,
      scheduledAt: new Date(Date.now() + 30 * 86400000).toISOString()
    });
    assert.equal(response.status, 400, "A team cannot be scheduled to play itself.");
    response = await fetchFromSite(`/api/matches/${matchUnderTest.id}`);
    assert.equal(response.status, 200, await response.clone().text());
    assert.match(response.headers.get("cache-control") || "", /no-store/i,
      "Public and viewer-scoped match details are not cached.");
    let matchDetail = await response.json();
    assert.equal(matchDetail.match.type, "team_league");
    assert.equal(matchDetail.frames.length, 5);
    assert.equal(matchDetail.match.status, "scheduled");
    assert.equal(matchDetail.permissions.canOperate, false, "Anonymous scheduled-match viewers receive no operator permission.");
    assert.equal(matchDetail.permissions.canStart, false);
    assert.equal(matchDetail.permissions.canScore, false);
    assert.ok(matchDetail.frames.every((frame) => frame.playersVisible === false && frame.players.length === 0),
      "Scheduled match details expose no unpublished frame selections.");
    response = await fetchFromSite(`/api/matches/${matchUnderTest.id}`, { headers: { cookie: firstUserCookie } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).permissions.canStart, true,
      "A registered player in a competing team may operate and start their scheduled fixture.");
    response = await fetchFromSite(`/api/matches/${matchUnderTest.id}`, { headers: { cookie: fifthUserCookie } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).permissions.canOperate, false,
      "An unrelated signed-in user receives a spectator-only scheduled match view.");
    assert.deepEqual(matchDetail.frames.map((frame) => frame.type), formatV1Frames.map((frame) => frame.type));
    const storedSnapshot = await database.query(
      `SELECT s.template_version, count(sf.frame_number)::integer AS frame_count
       FROM match_format_snapshots s JOIN match_format_snapshot_frames sf ON sf.snapshot_id=s.id
       WHERE s.match_id=$1 GROUP BY s.template_version`, [matchUnderTest.id]
    );
    assert.deepEqual(storedSnapshot.rows[0], { template_version: 1, frame_count: 5 },
      "A fixture stores the exact league format revision and ordered frame snapshot.");

    response = await matchPutJson(`/api/leagues/${approval.league.id}/match-format`, firstUserCookie, {
      name: "Single-frame revision", frames: [{ type: "singles" }]
    });
    assert.equal(response.status, 200, await response.clone().text());
    response = await fetchFromSite(`/api/matches/${matchUnderTest.id}`);
    assert.equal((await response.json()).frames.length, 5, "Changing the default does not silently change an existing fixture snapshot.");
    response = await matchPostJson(`/api/matches/${matchUnderTest.id}/apply-league-format`, firstUserCookie, {});
    assert.equal(response.status, 200, await response.clone().text());
    response = await fetchFromSite(`/api/matches/${matchUnderTest.id}`);
    assert.equal((await response.json()).frames.length, 1, "An explicitly selected future match receives the current format only.");
    response = await fetchFromSite(`/api/matches/${untouchedFutureMatch.id}`);
    assert.equal((await response.json()).frames.length, 5, "Updating one selected match leaves another future fixture unchanged.");
    const expectedFutureFixtures = await database.query(
      `SELECT count(*)::integer AS count FROM matches m
       JOIN seasons sea ON sea.id = m.season_id
       WHERE m.league_id = $1 AND m.status = 'scheduled' AND m.started_at IS NULL
         AND sea.status <> 'completed' AND m.scheduled_at > now()
         AND NOT EXISTS (SELECT 1 FROM match_frame_players fp WHERE fp.match_id = m.id)`,
      [approval.league.id]
    );
    response = await matchPutJson(`/api/leagues/${approval.league.id}/match-format`, firstUserCookie, {
      name: "Restored mixed format", frames: formatV1Frames, applyToFuture: true
    });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).format.updatedMatches, expectedFutureFixtures.rows[0].count,
      "League administrators can apply a new revision to all future unplayed fixtures.");
    response = await fetchFromSite(`/api/matches/${matchUnderTest.id}`);
    assert.equal((await response.json()).frames.length, 5);

    const changedSchedule = new Date(Date.now() + 45 * 86400000).toISOString();
    response = await matchPatchJson(`/api/matches/${untouchedFutureMatch.id}/schedule`, thirdUserCookie, {
      scheduledAt: changedSchedule, venue: "Unauthorised venue"
    });
    assert.equal(response.status, 403, "An ordinary league member cannot edit a fixture schedule.");
    response = await matchPatchJson(`/api/matches/${untouchedFutureMatch.id}/schedule`, firstUserCookie, {
      scheduledAt: changedSchedule, venue: "Updated local venue"
    });
    assert.equal(response.status, 200, await response.clone().text());
    let changedMatch = await response.json();
    assert.equal(changedMatch.match.venue, "Updated local venue");
    assert.equal(new Date(changedMatch.match.scheduledAt).toISOString(), changedSchedule);

    const fixtureFrames = [{ type: "doubles" }, { type: "singles" }];
    response = await matchPutJson(`/api/matches/${untouchedFutureMatch.id}/format`, thirdUserCookie, {
      name: "Unauthorised fixture format", frames: fixtureFrames
    });
    assert.equal(response.status, 403, "An ordinary member cannot change a fixture format.");
    response = await matchPutJson(`/api/matches/${untouchedFutureMatch.id}/format`, firstUserCookie, {
      name: "One-off fixture format", frames: fixtureFrames, makeDefault: false
    });
    assert.equal(response.status, 200, await response.clone().text());
    changedMatch = await response.json();
    assert.deepEqual(changedMatch.frames.map((frame) => frame.type), ["doubles", "singles"]);
    response = await fetchFromSite(`/api/leagues/${approval.league.id}/match-format`);
    assert.deepEqual((await response.json()).format.frames.map((frame) => frame.type), formatV1Frames.map((frame) => frame.type),
      "A match-only edit leaves the league default unchanged.");
    response = await matchPutJson(`/api/matches/${untouchedFutureMatch.id}/format`, firstUserCookie, {
      name: "Default from fixture edit", frames: fixtureFrames, makeDefault: true
    });
    assert.equal(response.status, 200, await response.clone().text());
    response = await fetchFromSite(`/api/leagues/${approval.league.id}/match-format`);
    assert.deepEqual((await response.json()).format.frames.map((frame) => frame.type), fixtureFrames.map((frame) => frame.type),
      "The optional make-default action updates the format for newly created fixtures.");
    response = await matchPutJson(`/api/leagues/${approval.league.id}/match-format`, firstUserCookie, {
      name: "Restore current league default", frames: formatV1Frames
    });
    assert.equal(response.status, 200, await response.clone().text());
    const newDefaultMatch = await createTeamMatch();
    assert.equal(newDefaultMatch.framesTotal, formatV1Frames.length, "New fixtures snapshot the current league default.");

    response = await fetchFromSite(`/api/matches?leagueId=${approval.league.id}`);
    assert.equal(response.status, 200, await response.clone().text());
    let listedMatches = (await response.json()).matches;
    const listedFixture = listedMatches.find((item) => item.id === newDefaultMatch.id);
    assert.ok(listedFixture, "The public Match Centre feed immediately lists a created fixture.");
    assert.deepEqual([listedFixture.homeScore, listedFixture.awayScore], [0, 0]);
    assert.equal(listedFixture.status, "scheduled");
    assert.equal(listedFixture.venue, "Local test venue");

    response = await matchPostJson(`/api/matches/${newDefaultMatch.id}/cancel`, thirdUserCookie, {});
    assert.equal(response.status, 403, "An ordinary member cannot cancel a fixture.");
    response = await matchPostJson(`/api/matches/${newDefaultMatch.id}/cancel`, firstUserCookie, {});
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).match.status, "cancelled");
    response = await matchPostJson(`/api/matches/${newDefaultMatch.id}/cancel`, firstUserCookie, {});
    assert.equal(response.status, 409, "A cancelled fixture cannot be cancelled a second time.");

    response = await fetchFromSite(`/api/matches/${matchUnderTest.id}/eligible-players?side=1`);
    assert.equal(response.status, 401, "Eligible-player reads require a session.");
    response = await fetchFromSite(`/api/matches/${matchUnderTest.id}/eligible-players?side=1`, { headers: { cookie: firstUserCookie } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control") || "", /no-store/i,
      "Match-specific eligible-player lists are not cached.");
    const eligibleHomePlayers = (await response.json()).players;
    assert.deepEqual(eligibleHomePlayers.map((player) => player.userId).sort(), [firstUserId, secondProfile.userId].sort(),
      "Team scoreboard choices come only from active registrations to the correct team.");
    response = await fetchFromSite(`/api/matches/${matchUnderTest.id}/eligible-players?side=2`, { headers: { cookie: thirdUserCookie } });
    assert.equal(response.status, 200, "A registered player from the opposing side can view the match's eligible selections.");
    assert.deepEqual((await response.json()).players.map((player) => player.userId).sort(), [thirdProfile.userId, fourthProfile.userId].sort());
    response = await fetchFromSite(`/api/matches/${matchUnderTest.id}/eligible-players?side=1`, { headers: { cookie: fifthUserCookie } });
    assert.equal(response.status, 403, "A same-league player outside both competing teams cannot access scoreboard choices.");
    response = await fetchFromSite(`/api/matches/${matchUnderTest.id}/eligible-players?side=1`, { headers: { cookie: otherLeaguePlayerCookie } });
    assert.equal(response.status, 403, "A player from another league cannot access scoreboard choices.");

    response = await matchPostJson(`/api/matches/${matchUnderTest.id}/start`, thirdUserCookie, {});
    assert.equal(response.status, 200, "A registered player from either competing team can start the scoreboard.");
    const startedDetail = await response.json();
    assert.ok(Number.isFinite(Date.parse(startedDetail.match.startedAt)), "The server stores the canonical match start timestamp.");
    response = await fetchFromSite(`/api/matches/${matchUnderTest.id}`, { headers: { cookie: thirdUserCookie } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).permissions.canScore, true,
      "The authorized competing player receives the server scoring capability on the detail response.");
    response = await fetchFromSite(`/api/matches/${matchUnderTest.id}`, { headers: { cookie: fifthUserCookie } });
    assert.equal(response.status, 200);
    let spectatorMatchDetail = await response.json();
    assert.equal(spectatorMatchDetail.permissions.canOperate, false);
    assert.equal(spectatorMatchDetail.permissions.canScore, false,
      "An unrelated signed-in user remains unable to operate an in-progress match.");
    response = await matchPutJson(`/api/matches/${matchUnderTest.id}/frames/1/result`, "", { outcome: "played", winnerSide: 1 });
    assert.equal(response.status, 401, "Anonymous spectators cannot submit a score directly to the API.");
    response = await matchPutJson(`/api/matches/${matchUnderTest.id}/frames/1/result`, fifthUserCookie, { outcome: "played", winnerSide: 1 });
    assert.equal(response.status, 403, "An unrelated signed-in spectator cannot submit a score directly to the API.");
    response = await matchPutJson(`/api/matches/${matchUnderTest.id}/frames/1/result`, fifthUserCookie, { outcome: "played", winnerSide: 1 });
    assert.equal(response.status, 403, "A Platform Admin outside the competing sides cannot record a frame score.");
    response = await matchPostJson(`/api/matches/${matchUnderTest.id}/finalize`, firstUserCookie, {});
    assert.equal(response.status, 409, "A match with incomplete frames cannot be finalized.");
    response = await matchPostJson(`/api/matches/${matchUnderTest.id}/start`, firstUserCookie, {});
    assert.equal(response.status, 409, "A repeated Start Match request is safely rejected after the first transition.");
    response = await fetchFromSite("/api/matches/live");
    assert.equal(response.status, 200, await response.clone().text());
    assert.match(response.headers.get("cache-control"), /no-store/i);
    let livePayload = await response.json();
    assert.ok(Number.isFinite(Date.parse(livePayload.serverTime)), "The live feed supplies the server clock used by viewers.");
    let liveFixture = livePayload.matches.find((item) => item.id === matchUnderTest.id);
    assert.ok(liveFixture, "Anonymous visitors can read public in-progress matches.");
    assert.equal(liveFixture.status, "in_progress");
    assert.equal(new Date(liveFixture.startedAt).toISOString(), new Date(startedDetail.match.startedAt).toISOString(),
      "The live feed and detail page share the server-side started_at timestamp.");
    assert.equal(liveFixture.homeTeam, homeMatchTeam.name);
    assert.equal(liveFixture.awayTeam, awayMatchTeam.name);
    assert.equal(liveFixture.currentFrame.number, 1);
    assert.ok(!livePayload.matches.some((item) => item.id === untouchedFutureMatch.id), "Scheduled fixtures do not appear as live.");
    assert.ok(livePayload.matches.every((item) => item.status === "in_progress"), "The Live Matches endpoint returns only in-progress status.");
    response = await matchPutJson(`/api/matches/${matchUnderTest.id}/format`, firstUserCookie, {
      name: "Too late", frames: [{ type: "singles" }]
    });
    assert.equal(response.status, 409, "Started match snapshots are locked.");
    response = await matchPatchJson(`/api/matches/${matchUnderTest.id}/schedule`, firstUserCookie, {
      scheduledAt: new Date(Date.now() + 50 * 86400000).toISOString(), venue: "Too late"
    });
    assert.equal(response.status, 409, "Started fixture scheduling is locked.");
    response = await matchPostJson(`/api/matches/${matchUnderTest.id}/cancel`, firstUserCookie, {});
    assert.equal(response.status, 409, "Started fixtures cannot be cancelled as unstarted fixtures.");
    response = await matchPutJson(`/api/leagues/${approval.league.id}/match-format`, firstUserCookie, {
      name: "Future fixtures only", frames: [{ type: "singles" }], applyToFuture: true
    });
    assert.equal(response.status, 200, await response.clone().text());
    response = await fetchFromSite(`/api/matches/${matchUnderTest.id}`);
    assert.equal((await response.json()).frames.length, 5,
      "Applying the new league default to future fixtures leaves a started match snapshot unchanged.");
    const setFrameSide = async (matchId, frame, side, selection) => {
      const result = await matchPutJson(`/api/matches/${matchId}/frames/${frame}/players`, firstUserCookie, { side, ...selection });
      assert.equal(result.status, 200, await result.clone().text());
      assert.match(result.headers.get("cache-control") || "", /no-store/i,
        "Mutation responses containing viewer-scoped selection data are not cached.");
      return result.json();
    };
    const setFrameSideAs = async (matchId, frame, side, selection, cookie) => {
      const result = await matchPutJson(`/api/matches/${matchId}/frames/${frame}/players`, cookie, { side, ...selection });
      assert.equal(result.status, 200, await result.clone().text());
      return result.json();
    };
    const recordFrame = async (matchId, frame, details, cookie = firstUserCookie) => {
      const result = await matchPutJson(`/api/matches/${matchId}/frames/${frame}/result`, cookie, details);
      assert.equal(result.status, 200, await result.clone().text());
      return result.json();
    };
    response = await matchPutJson(`/api/matches/${matchUnderTest.id}/frames/2/players`, "", { side: 1, bye: true, players: [] });
    assert.equal(response.status, 401, "Anonymous spectators cannot submit future-frame player selections.");
    response = await matchPutJson(`/api/matches/${matchUnderTest.id}/frames/2/players`, fifthUserCookie, { side: 1, bye: true, players: [] });
    assert.equal(response.status, 403, "An unrelated signed-in spectator cannot submit future-frame player selections.");
    response = await matchPutJson(`/api/matches/${matchUnderTest.id}/frames/1/players`, firstUserCookie, { side: 1, players: [fifthProfile.userId] });
    assert.equal(response.status, 409, "A scorer cannot select a registered player from Team C for Team A's frame side.");
    await setFrameSide(matchUnderTest.id, 1, 1, { players: [firstUserId] });
    await setFrameSideAs(matchUnderTest.id, 1, 2, { players: [thirdProfile.userId] }, thirdUserCookie);
    const futureSelection = await setFrameSide(matchUnderTest.id, 2, 1, { bye: true, players: [] });
    assert.equal(futureSelection.frames[1].playersVisible, true,
      "A match-authorized player's mutation response confirms their saved future-frame selection.");
    assert.ok(futureSelection.frames[1].players.some((player) => player.isBye),
      "Authorized players can see the Bye saved for an upcoming frame.");
    const updatedFutureSelection = await setFrameSide(matchUnderTest.id, 2, 2, { players: [fourthProfile.userId] });
    assert.ok(updatedFutureSelection.frames[1].players.some((player) => player.userId === fourthProfile.userId),
      "Authorized players can prepare, save and verify selections for an upcoming frame.");
    response = await fetchFromSite(`/api/matches/${matchUnderTest.id}/audit`, { headers: { cookie: firstUserCookie } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control") || "", /no-store/i,
      "Private match audit history is not cached.");
    const privateAudit = await response.json();
    const upcomingSelectionEvents = privateAudit.events.filter((event) => event.action_type === "player_selection_changed" && event.frame_number === 2);
    assert.ok(upcomingSelectionEvents.length, "Future player selection changes remain auditable.");
    assert.ok(upcomingSelectionEvents.some((event) => JSON.stringify(event.new_value).includes(fourthProfile.userId)),
      "A match-authorized participant can review their future selections in the audit history.");
    response = await fetchFromSite(`/api/matches/${matchUnderTest.id}/audit`, { headers: { cookie: sixthUserCookie } });
    assert.equal(response.status, 200, "A league organiser outside the match retains its audit-view permission.");
    assert.match(response.headers.get("cache-control") || "", /no-store/i,
      "Organiser audit responses are not cached.");
    const organizerAudit = await response.json();
    const organizerUpcomingEvents = organizerAudit.events.filter((event) => event.action_type === "player_selection_changed" && event.frame_number === 2);
    assert.ok(organizerUpcomingEvents.length);
    assert.ok(organizerUpcomingEvents.every((event) => event.previous_value === null && event.new_value === null),
      "An organiser without match-scoring permission cannot view confidential future selections in the audit API.");
    response = await fetchFromSite(`/api/matches/${matchUnderTest.id}`);
    spectatorMatchDetail = await response.json();
    assert.equal(spectatorMatchDetail.frames[0].playersVisible, true,
      "The active frame's player selections are public to spectators.");
    assert.equal(spectatorMatchDetail.frames[1].playersVisible, false);
    assert.deepEqual(spectatorMatchDetail.frames[1].players, [],
      "Anonymous detail responses omit upcoming player IDs and names even after they are selected.");
    response = await fetchFromSite(`/api/matches/${matchUnderTest.id}`, { headers: { cookie: fifthUserCookie } });
    spectatorMatchDetail = await response.json();
    assert.deepEqual(spectatorMatchDetail.frames[1].players, [],
      "Unrelated authenticated viewers receive the same redacted upcoming-frame response.");
    response = await fetchFromSite("/api/matches/live");
    livePayload = await response.json();
    liveFixture = livePayload.matches.find((item) => item.id === matchUnderTest.id);
    assert.equal(liveFixture.currentFrame.number, 1,
      "The public Live Matches feed continues to expose only the active frame.");
    assert.doesNotMatch(JSON.stringify(liveFixture.currentFrame), new RegExp(fourthProfile.userId),
      "The public Live Matches response does not leak an unpublished future-frame selection.");
    response = await fetchFromSite(`/api/matches/${matchUnderTest.id}`, { headers: { cookie: sixthUserCookie } });
    const organizerMatchDetail = await response.json();
    assert.equal(organizerMatchDetail.permissions.canScore, false,
      "League organiser authority does not grant match-scoring permission.");
    assert.equal(organizerMatchDetail.permissions.canOperate, false,
      "The audit-view-only organiser is not a registered player on either side.");
    assert.equal(organizerMatchDetail.frames[1].playersVisible, false,
      "Organisers without match-scoring permission do not see confidential upcoming selections.");
    assert.deepEqual(organizerMatchDetail.frames[1].players, []);
    response = await matchPutJson(`/api/matches/${matchUnderTest.id}/frames/1/players`, thirdUserCookie, { side: 2, players: [firstUserId] });
    assert.equal(response.status, 409, "A scorer cannot move a competing player onto the wrong side.");
    response = await fetchFromSite("/api/matches/live");
    livePayload = await response.json();
    liveFixture = livePayload.matches.find((item) => item.id === matchUnderTest.id);
    assert.deepEqual(liveFixture.currentFrame.players.map((player) => player.name), [profile.displayName, thirdProfile.displayName],
      "Live frame player selections are reflected from the server.");
    const firstFrameResult = { outcome: "played", winnerSide: 1, dishEvent: "dish", dishPlayerId: firstUserId };
    const initialFrameAuditCount = await database.query(
      "SELECT count(*)::integer AS count FROM match_audit_events WHERE match_id = $1 AND frame_number = 1",
      [matchUnderTest.id]
    );
    const initialDishEvents = await database.query(
      "SELECT count(*)::integer AS count FROM match_frame_events WHERE match_id = $1 AND frame_number = 1",
      [matchUnderTest.id]
    );
    await recordFrame(matchUnderTest.id, 1, firstFrameResult);
    const afterFirstFrameAuditCount = await database.query(
      "SELECT count(*)::integer AS count FROM match_audit_events WHERE match_id = $1 AND frame_number = 1",
      [matchUnderTest.id]
    );
    const duplicateFrameResponses = await Promise.all([
      matchPutJson(`/api/matches/${matchUnderTest.id}/frames/1/result`, firstUserCookie, firstFrameResult),
      matchPutJson(`/api/matches/${matchUnderTest.id}/frames/1/result`, firstUserCookie, firstFrameResult)
    ]);
    for (const duplicateResponse of duplicateFrameResponses) assert.equal(duplicateResponse.status, 200, await duplicateResponse.clone().text());
    const duplicateFrameResult = await duplicateFrameResponses[0].json();
    const afterDuplicateFrameAuditCount = await database.query(
      "SELECT count(*)::integer AS count FROM match_audit_events WHERE match_id = $1 AND frame_number = 1",
      [matchUnderTest.id]
    );
    const afterDuplicateDishEvents = await database.query(
      "SELECT count(*)::integer AS count FROM match_frame_events WHERE match_id = $1 AND frame_number = 1",
      [matchUnderTest.id]
    );
    assert.deepEqual([duplicateFrameResult.match.homeScore, duplicateFrameResult.match.awayScore], [1, 0],
      "An exact repeated frame-result request preserves the stored score.");
    assert.equal(afterDuplicateFrameAuditCount.rows[0].count, afterFirstFrameAuditCount.rows[0].count,
      "An exact repeated frame-result request does not create a duplicate audit event.");
    assert.equal(afterFirstFrameAuditCount.rows[0].count, initialFrameAuditCount.rows[0].count + 2,
      "The initial frame and Dish are both recorded in the append-only audit history.");
    assert.equal(afterDuplicateDishEvents.rows[0].count, initialDishEvents.rows[0].count + 1,
      "An exact repeated frame result does not duplicate the Dish record.");
    response = await fetchFromSite(`/api/matches/${matchUnderTest.id}/frames/1/result`, { method: "DELETE" });
    assert.equal(response.status, 401, "Anonymous spectators cannot retract a frame result.");
    response = await fetchFromSite(`/api/matches/${matchUnderTest.id}/frames/1/result`, {
      method: "DELETE", headers: { cookie: fifthUserCookie }
    });
    assert.equal(response.status, 403, "Unrelated signed-in viewers cannot retract a frame result.");
    response = await fetchFromSite(`/api/matches/${matchUnderTest.id}/frames/1/result`, {
      method: "DELETE", headers: { cookie: sixthUserCookie }
    });
    assert.equal(response.status, 403, "A league organiser with finalization authority cannot retract a frame result without participant status.");
    const concurrentFrameRetractions = await Promise.all([
      fetchFromSite(`/api/matches/${matchUnderTest.id}/frames/1/result`, { method: "DELETE", headers: { cookie: firstUserCookie } }),
      fetchFromSite(`/api/matches/${matchUnderTest.id}/frames/1/result`, { method: "DELETE", headers: { cookie: firstUserCookie } })
    ]);
    assert.deepEqual(concurrentFrameRetractions.map((item) => item.status).sort(), [200, 409],
      "Concurrent frame retractions commit once and reject the duplicate without extra audit entries.");
    response = concurrentFrameRetractions.find((item) => item.status === 200);
    assert.ok(response);
    const retractedFrameDetail = await response.json();
    assert.deepEqual([retractedFrameDetail.match.homeScore, retractedFrameDetail.match.awayScore], [0, 0],
      "Retracting the latest played frame removes only its derived frame point without assigning it to the opponent.");
    assert.equal(retractedFrameDetail.frames[0].status, "scheduled", "The retracted frame is reopened for a corrected result.");
    assert.equal(retractedFrameDetail.frames[0].event, null, "A Dish attached to a retracted result is removed from current statistics.");
    const frameRetractionAudit = await database.query(
      `SELECT action_type, count(*)::integer AS count FROM match_audit_events
       WHERE match_id = $1 AND frame_number = 1 GROUP BY action_type`, [matchUnderTest.id]
    );
    assert.ok(frameRetractionAudit.rows.some((row) => row.action_type === "frame_result_changed" && row.count === 1),
      "The result retraction is preserved as an append-only frame correction audit event.");
    assert.ok(frameRetractionAudit.rows.some((row) => row.action_type === "frame_decoration_changed" && row.count === 2),
      "The original Dish and its removal during retraction are both preserved in the audit history.");
    const retractionAuditTotal = frameRetractionAudit.rows.reduce((total, row) => total + row.count, 0);
    assert.equal(retractionAuditTotal, afterDuplicateFrameAuditCount.rows[0].count + 2,
      "A successful result retraction writes one result audit event and one event-removal audit event.");
    response = await fetchFromSite(`/api/matches/${matchUnderTest.id}/frames/1/result`, {
      method: "DELETE", headers: { cookie: firstUserCookie }
    });
    assert.equal(response.status, 409, "A repeated retraction cannot create duplicate audit actions.");
    const replayedFrameResult = await recordFrame(matchUnderTest.id, 1, firstFrameResult);
    assert.deepEqual([replayedFrameResult.match.homeScore, replayedFrameResult.match.awayScore], [1, 0],
      "A participant can record the reopened frame again through the normal result route.");
    response = await fetchFromSite("/api/matches/live");
    livePayload = await response.json();
    liveFixture = livePayload.matches.find((item) => item.id === matchUnderTest.id);
    assert.deepEqual([liveFixture.homeScore, liveFixture.awayScore], [1, 0], "The live score comes from completed frame results.");
    assert.equal(liveFixture.currentFrame.number, 2, "Completing a frame advances the live current-frame display.");
    assert.equal(liveFixture.currentFrame.playersVisible, undefined,
      "The live-list current-frame contract remains its existing compact public shape.");
    assert.ok(futureSelection.frames[1].players.some((player) => player.isBye),
      "An earlier authorized mutation response remains an immutable snapshot of its saved upcoming Bye.");
    assert.equal(futureSelection.frames[1].players.some((player) => player.userId === fourthProfile.userId), false,
      "Later opponent selections do not appear retroactively in that earlier response snapshot.");
    response = await fetchFromSite(`/api/matches/${matchUnderTest.id}`);
    const advancedDetail = await response.json();
    assert.equal(advancedDetail.frames[1].playersVisible, true,
      "Selections become visible when their frame advances to current.");
    assert.deepEqual(advancedDetail.frames[1].players.map((player) => player.name).filter(Boolean).sort(), [fourthProfile.displayName].sort(),
      "The newly current frame identifies its selected participant accurately.");
    await recordFrame(matchUnderTest.id, 2, { outcome: "bye" });
    await setFrameSide(matchUnderTest.id, 3, 1, { players: [firstUserId, secondProfile.userId] });
    await setFrameSide(matchUnderTest.id, 3, 2, { players: [thirdProfile.userId, fourthProfile.userId] });
    await recordFrame(matchUnderTest.id, 3, { outcome: "played", winnerSide: 2, dishEvent: "counter_dish", dishPlayerId: thirdProfile.userId });
    await setFrameSide(matchUnderTest.id, 4, 1, { players: [secondProfile.userId] });
    await setFrameSide(matchUnderTest.id, 4, 2, { players: [thirdProfile.userId] });
    await recordFrame(matchUnderTest.id, 4, { outcome: "played", winnerSide: 1 });
    await setFrameSide(matchUnderTest.id, 5, 1, { players: [firstUserId, secondProfile.userId] });
    await setFrameSide(matchUnderTest.id, 5, 2, { players: [thirdProfile.userId, fourthProfile.userId] });
    matchDetail = await recordFrame(matchUnderTest.id, 5, { outcome: "played", winnerSide: 2 });
    assert.equal(matchDetail.match.status, "awaiting_confirmation", "Completing all snapshot frames moves the match to confirmation, not directly to final.");
    response = await fetchFromSite(`/api/matches/${matchUnderTest.id}`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).permissions.canFinalize, false, "Anonymous match viewers cannot finalize results.");
    response = await fetchFromSite(`/api/matches/${matchUnderTest.id}`, { headers: { cookie: fifthUserCookie } });
    assert.equal(response.status, 200);
    const unrelatedMatchPermissions = (await response.json()).permissions;
    assert.equal(unrelatedMatchPermissions.canFinalize, false, "Platform Admin status does not let an unrelated player finalize.");
    assert.deepEqual(unrelatedMatchPermissions.retractableSides, [], "An unrelated Platform Admin cannot retract a side confirmation.");
    response = await fetchFromSite(`/api/matches/${matchUnderTest.id}`, { headers: { cookie: otherLeaguePlayerCookie } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).permissions.canFinalize, false,
      "An administrator of a different league cannot finalize this competition's match.");
    response = await fetchFromSite(`/api/matches/${matchUnderTest.id}`, { headers: { cookie: thirdUserCookie } });
    assert.equal((await response.json()).permissions.canFinalize, true, "A registered player on a competing side can finalize.");
    response = await fetchFromSite(`/api/matches/${matchUnderTest.id}`, { headers: { cookie: secondUserCookie } });
    const organizerPermissions = (await response.json()).permissions;
    assert.equal(organizerPermissions.canFinalize, true, "An active league administrator can finalize as an explicitly authorised organiser.");
    assert.equal(organizerPermissions.canScore, false, "Organizer finalization permission does not grant scoring rights.");
    assert.equal(organizerPermissions.canOperate, false, "An organizer outside the match remains in read-only scoreboard mode.");
    response = await fetchFromSite("/api/matches/live");
    assert.ok(!(await response.json()).matches.some((item) => item.id === matchUnderTest.id),
      "A match leaves the Live Matches feed as soon as it moves to awaiting confirmation.");
    assert.equal(matchDetail.match.homeScore, 2);
    assert.equal(matchDetail.match.awayScore, 3);
    assert.equal(matchDetail.match.framesRemaining, 0);
    assert.ok(matchDetail.frames[0].players.some((player) => player.userId === firstUserId));
    assert.ok(matchDetail.frames[2].players.some((player) => player.userId === firstUserId), "A player may play repeatedly across frames.");
    const frameEvents = await database.query("SELECT frame_number,event_type FROM match_frame_events WHERE match_id=$1 ORDER BY frame_number", [matchUnderTest.id]);
    assert.deepEqual(frameEvents.rows, [{ frame_number: 1, event_type: "dish" }, { frame_number: 3, event_type: "counter_dish" }]);
    const byeDecoration = await database.query("SELECT count(*)::integer AS count FROM match_frame_events WHERE match_id=$1 AND frame_number=2", [matchUnderTest.id]);
    assert.equal(byeDecoration.rows[0].count, 0, "Bye wins cannot carry Dish or Counter Dish records.");
    response = await matchPutJson(`/api/matches/${matchUnderTest.id}/frames/1/event`, firstUserCookie, { type: "dish", userId: firstUserId });
    assert.equal(response.status, 200, "A competing player can make an audited frame-event correction while results await confirmation.");
    const scorerAudit = await database.query(
      `SELECT DISTINCT actor_user_id, action_type FROM match_audit_events
       WHERE match_id=$1 AND action_type IN ('match_started','player_selection_changed','frame_result_entered','frame_decoration_changed')`, [matchUnderTest.id]
    );
    assert.ok(scorerAudit.rows.some((event) => event.actor_user_id === thirdProfile.userId && event.action_type === "match_started"),
      "The authenticated competing player who starts the scoreboard remains auditable.");
    assert.ok(scorerAudit.rows.some((event) => event.actor_user_id === firstUserId && event.action_type === "player_selection_changed"),
      "A non-captain player from the other competing team can make an audited selection.");
    assert.ok(scorerAudit.rows.some((event) => event.actor_user_id === firstUserId && event.action_type === "frame_result_entered"),
      "The authenticated scoring actor remains recorded for frame results.");
    assert.ok(scorerAudit.rows.some((event) => event.actor_user_id === firstUserId && event.action_type === "frame_decoration_changed"),
      "An awaiting-confirmation correction remains auditable and keeps its lifecycle unchanged.");

    response = await matchPostJson(`/api/matches/${matchUnderTest.id}/confirm`, firstUserCookie, { side: 1 });
    assert.equal(response.status, 200, await response.clone().text());
    response = await matchPostJson(`/api/matches/${matchUnderTest.id}/confirm`, secondUserCookie, { side: 2 });
    assert.equal(response.status, 200, await response.clone().text());
    response = await fetchFromSite(`/api/matches/${matchUnderTest.id}/finalize`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}"
    });
    assert.equal(response.status, 401, "Anonymous users cannot finalize even a fully confirmed result.");
    response = await matchPostJson(`/api/matches/${matchUnderTest.id}/finalize`, fifthUserCookie, {});
    assert.equal(response.status, 403, "An unrelated Platform Admin cannot finalize a fully confirmed result.");
    response = await matchPostJson(`/api/matches/${matchUnderTest.id}/finalize`, otherLeaguePlayerCookie, {});
    assert.equal(response.status, 403, "An administrator of a different league cannot finalize this result.");
    response = await fetchFromSite(`/api/matches/${matchUnderTest.id}`);
    assert.equal((await response.json()).match.status, "awaiting_confirmation", "Rejected finalization attempts leave the result awaiting confirmation.");
    const concurrentFinalizations = await Promise.all([
      matchPostJson(`/api/matches/${matchUnderTest.id}/finalize`, secondUserCookie, {}),
      matchPostJson(`/api/matches/${matchUnderTest.id}/finalize`, thirdUserCookie, {})
    ]);
    assert.deepEqual(concurrentFinalizations.map((item) => item.status).sort(), [200, 409],
      "Concurrent participant/organiser finalization permits one transition and rejects the stale request.");
    matchDetail = await concurrentFinalizations.find((item) => item.status === 200).json();
    assert.equal(matchDetail.match.status, "completed");
    response = await fetchFromSite(`/api/matches/${matchUnderTest.id}`);
    const completedPublicDetail = await response.json();
    assert.equal(completedPublicDetail.permissions.canScore, false, "A completed match is read-only even for a competing player.");
    assert.ok(completedPublicDetail.frames.every((frame) => frame.playersVisible === true),
      "Completed matches retain public frame participants for historical review.");
    response = await matchPutJson(`/api/matches/${matchUnderTest.id}/frames/1/result`, thirdUserCookie, { outcome: "played", winnerSide: 2 });
    assert.equal(response.status, 403, "A regular competing player cannot mutate a completed result through the scorer endpoint.");
    response = await fetchFromSite("/api/matches/live");
    assert.ok(!(await response.json()).matches.some((item) => item.id === matchUnderTest.id),
      "Completed matches do not remain in the Live Matches feed.");
    const finalizedAudit = await fetchFromSite(`/api/matches/${matchUnderTest.id}/audit`, { headers: { cookie: firstUserCookie } });
    assert.equal(finalizedAudit.status, 200);
    const auditActions = (await finalizedAudit.json()).events.map((event) => event.action_type);
    for (const action of ["match_started", "player_selection_changed", "frame_result_entered", "bye_entered", "confirmation_confirmed", "match_finalized"]) {
      assert.ok(auditActions.includes(action), `Missing immutable audit action ${action}.`);
    }
    const finalizationCount = await database.query(
      "SELECT count(*)::integer AS count FROM match_audit_events WHERE match_id=$1 AND action_type='match_finalized'",
      [matchUnderTest.id]
    );
    assert.equal(finalizationCount.rows[0].count, 1, "Concurrent requests produce exactly one finalization audit event.");
    const platformAdminCleanup = await platformRoles.revokePlatformAdmin(
      superAdminUserId, fifthProfile.userId, "Match permission isolation test cleanup"
    );
    assert.equal(platformAdminCleanup.revoked, true);
    response = await matchPatchJson(`/api/matches/${matchUnderTest.id}/schedule`, firstUserCookie, {
      scheduledAt: new Date(Date.now() + 60 * 86400000).toISOString(), venue: "Completed change rejected"
    });
    assert.equal(response.status, 409, "Completed match schedules remain immutable.");
    response = await matchPostJson(`/api/matches/${matchUnderTest.id}/cancel`, firstUserCookie, {});
    assert.equal(response.status, 409, "Completed matches cannot be cancelled.");
    response = await matchPutJson(`/api/matches/${matchUnderTest.id}/format`, firstUserCookie, {
      name: "Completed change rejected", frames: [{ type: "singles" }]
    });
    assert.equal(response.status, 409, "Completed match format snapshots remain immutable.");
    const officialTeamStats = await database.query("SELECT matches_played, matches_won, matches_lost FROM official_competitive_player_statistics WHERE user_id=$1", [firstUserId]);
    assert.equal(Number(officialTeamStats.rows[0].matches_played), 1);
    assert.equal(Number(officialTeamStats.rows[0].matches_lost), 1, "The official match winner is derived from the frame winners.");

    response = await matchPostJson("/api/tournaments", fifthUserCookie, { name: `Local Flyer ${crypto.randomUUID()}`, venue: "Test room" });
    assert.equal(response.status, 201, await response.clone().text());
    const tournamentEvent = (await response.json()).event;
    response = await matchPostJson("/api/matches", fifthUserCookie, {
      type: "tournament_flyer", tournamentEventId: tournamentEvent.id,
      frames: [{ type: "doubles" }],
      participants: [
        { userId: firstUserId, side: 1 }, { userId: secondProfile.userId, side: 1 },
        { userId: thirdProfile.userId, side: 2 }, { userId: fourthProfile.userId, side: 2 }
      ]
    });
    assert.equal(response.status, 201, await response.clone().text());
    const flyerMatch = (await response.json()).match;
    assert.equal(flyerMatch.type, "tournament_flyer");
    response = await matchPostJson(`/api/matches/${flyerMatch.id}/start`, firstUserCookie, {});
    assert.equal(response.status, 200);
    response = await matchPutJson(`/api/matches/${flyerMatch.id}/frames/1/players`, firstUserCookie, { side: 1, bye: true, players: [firstUserId] });
    assert.equal(response.status, 400, "The API rejects a partial Doubles Bye before it writes a selection.");
    await matchPutJson(`/api/matches/${flyerMatch.id}/frames/1/players`, firstUserCookie, { side: 1, bye: true, players: [] }).then(async (item) => assert.equal(item.status, 200, await item.clone().text()));
    await matchPutJson(`/api/matches/${flyerMatch.id}/frames/1/players`, firstUserCookie, { side: 2, players: [thirdProfile.userId, fourthProfile.userId] }).then(async (item) => assert.equal(item.status, 200, await item.clone().text()));
    response = await matchPutJson(`/api/matches/${flyerMatch.id}/frames/1/result`, firstUserCookie, { outcome: "bye" });
    assert.equal(response.status, 200, await response.clone().text());
    const fullDoublesBye = (await response.json()).frames[0];
    assert.equal(fullDoublesBye.outcome, "bye");
    assert.equal(fullDoublesBye.winnerSide, 2, "A full Doubles Bye awards the frame to the valid opposing pair.");
    await matchPostJson(`/api/matches/${flyerMatch.id}/confirm`, firstUserCookie, { side: 1 })
      .then(async (item) => assert.equal(item.status, 200, await item.clone().text()));
    await matchPostJson(`/api/matches/${flyerMatch.id}/confirm`, thirdUserCookie, { side: 2 })
      .then(async (item) => assert.equal(item.status, 200, await item.clone().text()));
    response = await matchPostJson("/api/tournaments", otherLeaguePlayerCookie, { name: `Unrelated Flyer ${crypto.randomUUID()}` });
    assert.equal(response.status, 201, await response.clone().text());
    const unrelatedTournament = (await response.json()).event;
    response = await fetchFromSite(`/api/matches/${flyerMatch.id}`, { headers: { cookie: fifthUserCookie } });
    assert.equal((await response.json()).permissions.canFinalize, true,
      "The tournament event creator can finalize a match even when not a recorded player.");
    response = await fetchFromSite(`/api/matches/${flyerMatch.id}`, { headers: { cookie: otherLeaguePlayerCookie } });
    assert.equal((await response.json()).permissions.canFinalize, false,
      "An organiser of a different tournament event cannot finalize this match.");
    response = await matchPostJson(`/api/matches/${flyerMatch.id}/finalize`, fifthUserCookie, {});
    assert.equal(response.status, 200, "The exact tournament organiser may finalize after both sides confirm.");
    assert.notEqual(tournamentEvent.id, unrelatedTournament.id);

    response = await fetchFromSite(`/api/leagues/${approval.league.id}/seasons/${matchSeason.id}/doubles-entries`);
    assert.equal(response.status, 401, "Anonymous users cannot enumerate registered Doubles League pairs.");
    response = await fetchFromSite(`/api/leagues/${approval.league.id}/seasons/${matchSeason.id}/doubles-entries`, { headers: { cookie: thirdUserCookie } });
    assert.equal(response.status, 403, "Ordinary members cannot enumerate private organiser entry choices.");

    const sideOneEntryId = await createDoublesEntry(approval.league.id, matchSeason.id, [firstUserId, secondProfile.userId]);
    const sideTwoEntryId = await createDoublesEntry(approval.league.id, matchSeason.id, [thirdProfile.userId, fourthProfile.userId]);
    const pendingDoublesEntryId = await createDoublesEntry(approval.league.id, matchSeason.id, [firstUserId, fifthProfile.userId], "pending");
    const rejectedDoublesEntryId = await createDoublesEntry(approval.league.id, matchSeason.id, [secondProfile.userId, fifthProfile.userId], "rejected");
    const withdrawnDoublesEntryId = await createDoublesEntry(approval.league.id, matchSeason.id, [thirdProfile.userId, fifthProfile.userId], "withdrawn");
    const onePlayerEntryId = await createDoublesEntry(approval.league.id, matchSeason.id, [firstUserId]);
    const threePlayerEntryId = await createDoublesEntry(approval.league.id, matchSeason.id, [firstUserId, secondProfile.userId, fifthProfile.userId]);
    const wrongSeasonEntryId = await createDoublesEntry(approval.league.id, otherSeason.id, [firstUserId, secondProfile.userId]);
    const openSeasonResponse = await postJson(`/api/leagues/${open.league.id}/seasons`, firstUserCookie, { name: `Other league ${crypto.randomUUID()}` });
    assert.equal(openSeasonResponse.status, 201, await openSeasonResponse.clone().text());
    const openSeason = (await openSeasonResponse.json()).season;
    const wrongLeagueEntryId = await createDoublesEntry(open.league.id, openSeason.id, [firstUserId, secondProfile.userId]);

    response = await fetchFromSite(`/api/leagues/${approval.league.id}/seasons/${matchSeason.id}/doubles-entries`, { headers: { cookie: firstUserCookie } });
    assert.equal(response.status, 200, await response.clone().text());
    const selectablePairs = (await response.json()).entries;
    assert.equal(selectablePairs.length, 2, "Only approved entries with exactly two active league players are selectable.");
    assert.deepEqual(selectablePairs.map((entry) => entry.id).sort(), [sideOneEntryId, sideTwoEntryId].sort());
    assert.ok(selectablePairs.every((entry) => entry.players.length === 2 && entry.displayName.includes(" / ")),
      "The organiser sees both player names while choosing each pair.");
    response = await matchPostJson("/api/matches", thirdUserCookie, {
      type: "doubles_league", leagueId: approval.league.id, seasonId: matchSeason.id,
      doublesEntryIds: [sideOneEntryId, sideTwoEntryId], scheduledAt: new Date(Date.now() + 30 * 86400000).toISOString()
    });
    assert.equal(response.status, 403, "Only an active league owner or administrator can create a Doubles League fixture.");

    const doublesFormat = [{ type: "doubles" }, { type: "singles" }];
    response = await matchPutJson(`/api/leagues/${approval.league.id}/match-format`, firstUserCookie, {
      name: "Doubles League test format", frames: doublesFormat
    });
    assert.equal(response.status, 200, await response.clone().text());
    const createDoublesFixture = (entryIds, cookie = firstUserCookie) => matchPostJson("/api/matches", cookie, {
      type: "doubles_league", leagueId: approval.league.id, seasonId: matchSeason.id,
      doublesEntryIds: entryIds, scheduledAt: new Date(Date.now() + 30 * 86400000).toISOString(), venue: "Doubles venue"
    });
    for (const invalidIds of [
      [sideOneEntryId, sideOneEntryId], [pendingDoublesEntryId, sideTwoEntryId],
      [rejectedDoublesEntryId, sideTwoEntryId], [withdrawnDoublesEntryId, sideTwoEntryId],
      [onePlayerEntryId, sideTwoEntryId], [threePlayerEntryId, sideTwoEntryId],
      [wrongSeasonEntryId, sideTwoEntryId], [wrongLeagueEntryId, sideTwoEntryId]
    ]) {
      response = await createDoublesFixture(invalidIds);
      assert.ok([400, 409].includes(response.status), `Invalid Doubles League pair selection was accepted: ${await response.clone().text()}`);
    }
    response = await createDoublesFixture([sideOneEntryId, sideTwoEntryId]);
    assert.equal(response.status, 201, await response.clone().text());
    const scheduledDoublesDetail = await response.json();
    const scheduledDoublesMatch = scheduledDoublesDetail.match;
    assert.equal(scheduledDoublesMatch.type, "doubles_league");
    assert.deepEqual(scheduledDoublesDetail.frames.map((frame) => frame.type), doublesFormat.map((frame) => frame.type),
      "Doubles League fixtures use the league's configured match format.");
    assert.equal(scheduledDoublesMatch.homeSideName, "Alex Player / Second Player Updated");
    assert.equal(scheduledDoublesMatch.awaySideName, "Fourth Player / Third Player");
    const storedDoublesSides = await database.query(
      `SELECT s.side, s.entry_id, count(mp.user_id)::integer AS players
       FROM match_doubles_league_sides s JOIN match_participants mp ON mp.match_id=s.match_id AND mp.side=s.side
       WHERE s.match_id=$1 GROUP BY s.side,s.entry_id ORDER BY s.side`, [scheduledDoublesMatch.id]
    );
    assert.deepEqual(storedDoublesSides.rows.map((row) => ({ side: row.side, entry_id: row.entry_id, players: row.players })), [
      { side: 1, entry_id: sideOneEntryId, players: 2 }, { side: 2, entry_id: sideTwoEntryId, players: 2 }
    ]);
    const publicDoublesResponse = await fetchFromSite(`/api/matches?leagueId=${approval.league.id}`);
    assert.equal(publicDoublesResponse.status, 200);
    const listedDoublesMatch = (await publicDoublesResponse.json()).matches.find((match) => match.id === scheduledDoublesMatch.id);
    assert.equal(listedDoublesMatch?.homeSideName, "Alex Player / Second Player Updated",
      "Anonymous Match Centre listing includes the saved public doubles-pair names.");
    assert.equal(listedDoublesMatch?.awaySideName, "Fourth Player / Third Player");

    await database.query("DELETE FROM competition_entry_participants WHERE entry_id=$1 AND user_id=$2", [sideOneEntryId, firstUserId]);
    await database.query(
      "INSERT INTO competition_entry_participants(entry_id,user_id,added_by) VALUES($1,$2,$3)",
      [sideOneEntryId, fifthProfile.userId, firstUserId]
    );
    const historicalSide = await fetchFromSite(`/api/matches/${scheduledDoublesMatch.id}`, { headers: { cookie: firstUserCookie } });
    assert.equal(historicalSide.status, 200);
    assert.equal((await historicalSide.json()).match.homeSideName, "Alex Player / Second Player Updated",
      "Changing the current entry roster does not rewrite the match participant snapshot.");
    const historicalEligible = await fetchFromSite(`/api/matches/${scheduledDoublesMatch.id}/eligible-players?side=1`, { headers: { cookie: firstUserCookie } });
    assert.deepEqual((await historicalEligible.json()).players.map((player) => player.userId).sort(), [firstUserId, secondProfile.userId].sort());
    await assert.rejects(
      database.query("DELETE FROM match_participants WHERE match_id=$1 AND user_id=$2", [scheduledDoublesMatch.id, firstUserId]),
      (error) => error.constraint === "match_doubles_participants_immutable",
      "Doubles participant snapshots cannot be deleted after an entry changes."
    );
    await assert.rejects(
      database.query("UPDATE match_doubles_league_sides SET entry_id=$2 WHERE match_id=$1 AND side=1", [scheduledDoublesMatch.id, sideTwoEntryId]),
      (error) => error.constraint === "match_doubles_league_sides_immutable",
      "A recorded Doubles League side cannot be silently replaced."
    );
    await assert.rejects(
      database.query("UPDATE competition_entries SET season_id=$2 WHERE id=$1", [sideOneEntryId, otherSeason.id]),
      (error) => error.constraint === "competition_entry_doubles_identity_immutable",
      "An entry linked to match history cannot later change its league-season identity."
    );

    response = await matchPatchJson(`/api/matches/${scheduledDoublesMatch.id}/schedule`, firstUserCookie, {
      scheduledAt: new Date(Date.now() + 60 * 86400000).toISOString(), venue: "Rescheduled doubles venue"
    });
    assert.equal(response.status, 200, "Managers can edit an unstarted Doubles League schedule.");
    response = await matchPostJson(`/api/matches/${scheduledDoublesMatch.id}/cancel`, firstUserCookie, {});
    assert.equal(response.status, 200, "Managers can cancel an unstarted Doubles League fixture.");
    assert.equal((await response.json()).match.status, "cancelled");

    response = await createDoublesFixture([sideOneEntryId, sideTwoEntryId]);
    assert.equal(response.status, 201, await response.clone().text());
    const playingDoublesMatch = (await response.json()).match;
    response = await matchPostJson(`/api/matches/${playingDoublesMatch.id}/start`, firstUserCookie, {});
    assert.equal(response.status, 403, "A league administrator who is absent from both Doubles entries cannot operate the match.");
    response = await fetchFromSite(`/api/matches/${playingDoublesMatch.id}/eligible-players?side=1`, { headers: { cookie: sixthUserCookie } });
    assert.equal(response.status, 403, "An unrelated registered league player cannot access a Doubles match's player selections.");
    response = await matchPostJson(`/api/matches/${playingDoublesMatch.id}/start`, sixthUserCookie, {});
    assert.equal(response.status, 403, "Only players in the two recorded Doubles entries can start that fixture.");
    response = await matchPostJson(`/api/matches/${playingDoublesMatch.id}/start`, secondUserCookie, {});
    assert.equal(response.status, 200);
    response = await fetchFromSite("/api/matches/live");
    livePayload = await response.json();
    const liveDoublesMatch = livePayload.matches.find((item) => item.id === playingDoublesMatch.id);
    assert.ok(liveDoublesMatch);
    assert.equal(liveDoublesMatch.homeSideName, "Fifth Player / Second Player Updated");
    assert.equal(liveDoublesMatch.awaySideName, "Fourth Player / Third Player",
      "Live Doubles sides show approved pair names instead of fabricated team names.");
    response = await matchPatchJson(`/api/matches/${playingDoublesMatch.id}/schedule`, firstUserCookie, {
      scheduledAt: new Date(Date.now() + 90 * 86400000).toISOString(), venue: "Too late"
    });
    assert.equal(response.status, 409, "Started Doubles League fixture scheduling is locked.");
    response = await matchPostJson(`/api/matches/${playingDoublesMatch.id}/cancel`, firstUserCookie, {});
    assert.equal(response.status, 409, "Started Doubles League fixtures cannot be cancelled as unstarted.");
    response = await matchPutJson(`/api/matches/${playingDoublesMatch.id}/frames/1/players`, secondUserCookie, { side: 1, players: [secondProfile.userId] });
    assert.equal(response.status, 400, "Doubles League doubles frames require both pair players.");
    response = await matchPutJson(`/api/matches/${playingDoublesMatch.id}/frames/1/players`, secondUserCookie, { side: 1, players: [firstUserId, secondProfile.userId] });
    assert.equal(response.status, 409, "Players removed from the current entry cannot replace a recorded match-side player.");
    await setFrameSideAs(playingDoublesMatch.id, 1, 1, { players: [secondProfile.userId, fifthProfile.userId] }, secondUserCookie);
    await setFrameSideAs(playingDoublesMatch.id, 1, 2, { players: [thirdProfile.userId, fourthProfile.userId] }, thirdUserCookie);
    await recordFrame(playingDoublesMatch.id, 1, { outcome: "played", winnerSide: 1 }, secondUserCookie);
    response = await matchPutJson(`/api/matches/${playingDoublesMatch.id}/frames/2/players`, secondUserCookie, { side: 1, players: [secondProfile.userId, fifthProfile.userId] });
    assert.equal(response.status, 400, "A Singles frame in a Doubles League fixture accepts only one player per side.");
    await setFrameSideAs(playingDoublesMatch.id, 2, 1, { players: [fifthProfile.userId] }, secondUserCookie);
    await setFrameSideAs(playingDoublesMatch.id, 2, 2, { players: [thirdProfile.userId] }, thirdUserCookie);
    await recordFrame(playingDoublesMatch.id, 2, { outcome: "played", winnerSide: 2 }, secondUserCookie);
    await matchPostJson(`/api/matches/${playingDoublesMatch.id}/confirm`, secondUserCookie, {}).then(async (item) => assert.equal(item.status, 200, await item.clone().text()));
    await matchPostJson(`/api/matches/${playingDoublesMatch.id}/confirm`, thirdUserCookie, {}).then(async (item) => assert.equal(item.status, 200, await item.clone().text()));
    response = await matchPostJson(`/api/matches/${playingDoublesMatch.id}/finalize`, firstUserCookie, {});
    assert.equal(response.status, 200, await response.clone().text());
    response = await fetchFromSite(`/api/matches/${playingDoublesMatch.id}/frames/2/result`, {
      method: "DELETE", headers: { cookie: secondUserCookie }
    });
    assert.equal(response.status, 409, "Completed match participants cannot retract or change a finalized frame result.");
    response = await matchPatchJson(`/api/matches/${playingDoublesMatch.id}/schedule`, firstUserCookie, {
      scheduledAt: new Date(Date.now() + 90 * 86400000).toISOString(), venue: "Completed change"
    });
    assert.equal(response.status, 409, "Completed Doubles League fixture scheduling remains protected.");
    response = await matchPostJson(`/api/matches/${playingDoublesMatch.id}/cancel`, firstUserCookie, {});
    assert.equal(response.status, 409, "Completed Doubles League fixtures cannot be cancelled.");

    response = await matchPutJson(`/api/leagues/${approval.league.id}/match-format`, firstUserCookie, {
      name: "Single-frame dispute test", frames: [{ type: "singles" }]
    });
    assert.equal(response.status, 200, await response.clone().text());
    response = await matchPostJson("/api/matches", firstUserCookie, {
      type: "singles_league", leagueId: approval.league.id, seasonId: matchSeason.id,
      scheduledAt: new Date(Date.now() + 30 * 86400000).toISOString(),
      participants: [{ userId: firstUserId, side: 1 }]
    });
    assert.equal(response.status, 400, "Singles fixtures require one player per side.");
    response = await matchPostJson("/api/matches", firstUserCookie, {
      type: "singles_league", leagueId: approval.league.id, seasonId: matchSeason.id,
      scheduledAt: new Date(Date.now() + 30 * 86400000).toISOString(),
      participants: [{ userId: firstUserId, side: 1 }, { userId: secondProfile.userId, side: 2 }]
    });
    assert.equal(response.status, 201, await response.clone().text());
    const singlesMatch = (await response.json()).match;
    assert.equal(singlesMatch.type, "singles_league");
    const singlesListResponse = await fetchFromSite(`/api/matches?leagueId=${approval.league.id}`);
    assert.equal(singlesListResponse.status, 200);
    const listedSingles = (await singlesListResponse.json()).matches.find((item) => item.id === singlesMatch.id);
    assert.ok(listedSingles);
    assert.equal(listedSingles.homeSideName, profile.displayName);
    assert.equal(listedSingles.awaySideName, "Second Player Updated",
      "Match Centre lists the two registered player names for a Singles fixture.");
    response = await matchPostJson(`/api/matches/${singlesMatch.id}/start`, thirdUserCookie, {});
    assert.equal(response.status, 403, "A registered player in the same league cannot operate a Singles match they are not entered in.");
    response = await fetchFromSite(`/api/matches/${singlesMatch.id}/eligible-players?side=1`, { headers: { cookie: thirdUserCookie } });
    assert.equal(response.status, 403, "Only one of the two Singles entrants can access the selectable players.");
    response = await matchPostJson(`/api/matches/${singlesMatch.id}/start`, firstUserCookie, {});
    assert.equal(response.status, 200);
    await matchPutJson(`/api/matches/${singlesMatch.id}/frames/1/players`, firstUserCookie, { side: 1, players: [firstUserId] }).then(async (item) => assert.equal(item.status, 200, await item.clone().text()));
    await matchPutJson(`/api/matches/${singlesMatch.id}/frames/1/players`, secondUserCookie, { side: 2, players: [secondProfile.userId] }).then(async (item) => assert.equal(item.status, 200, await item.clone().text()));
    response = await matchPutJson(`/api/matches/${singlesMatch.id}/frames/1/players`, firstUserCookie, { side: 1, players: [thirdProfile.userId] });
    assert.equal(response.status, 409, "Singles scorers cannot substitute another active league member for the recorded entrant.");
    response = await fetchFromSite("/api/matches/live");
    livePayload = await response.json();
    const liveSinglesMatch = livePayload.matches.find((item) => item.id === singlesMatch.id);
    assert.equal(liveSinglesMatch.homeSideName, profile.displayName);
    assert.equal(liveSinglesMatch.awaySideName, "Second Player Updated",
      "Live Singles fixtures identify the individual players, not team labels.");
    assert.deepEqual(liveSinglesMatch.currentFrame.players.map((player) => player.name), [profile.displayName, "Second Player Updated"]);
    response = await matchPutJson(`/api/matches/${singlesMatch.id}/frames/1/result`, firstUserCookie, { outcome: "played", winnerSide: 1 });
    assert.equal(response.status, 200, await response.clone().text());
    response = await matchPostJson(`/api/matches/${singlesMatch.id}/disputes`, "", { reason: "Anonymous dispute attempt" });
    assert.equal(response.status, 401, "Anonymous viewers cannot raise a match dispute through the API.");
    response = await matchPostJson(`/api/matches/${singlesMatch.id}/disputes`, thirdUserCookie, { reason: "Unrelated organiser dispute attempt" });
    assert.equal(response.status, 403, "An organiser who is not a competing player cannot raise a match dispute.");
    response = await fetchFromSite(`/api/matches/${singlesMatch.id}`, { headers: { cookie: secondUserCookie } });
    assert.equal((await response.json()).permissions.canScore, false,
      "League-organiser status does not grant Singles League scoring permission.");
    response = await fetchFromSite(`/api/matches/${singlesMatch.id}`, { headers: { cookie: thirdUserCookie } });
    assert.equal((await response.json()).permissions.canRaiseDispute, false,
      "An unrelated organiser is not granted dispute controls by their role.");
    response = await matchPostJson(`/api/matches/${singlesMatch.id}/disputes`, secondUserCookie, { reason: "Local integration dispute test" });
    assert.equal(response.status, 201, await response.clone().text());
    const disputedMatch = await response.json();
    assert.equal(disputedMatch.match.status, "disputed");
    response = await matchPostJson(`/api/matches/${singlesMatch.id}/finalize`, firstUserCookie, {});
    assert.equal(response.status, 409, "Open disputes block finalization.");
    const disputeId = disputedMatch.disputes[0].id;
    response = await matchPostJson(`/api/matches/${singlesMatch.id}/disputes/${disputeId}/resolve`, thirdUserCookie, { resolution: "Unauthorised" });
    assert.equal(response.status, 403, "A regular member cannot resolve a league dispute.");
    response = await matchPostJson(`/api/matches/${singlesMatch.id}/disputes/${disputeId}/resolve`, secondUserCookie, { resolution: "Score checked by the league administrator." });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).match.status, "awaiting_confirmation");
    await matchPostJson(`/api/matches/${singlesMatch.id}/confirm`, firstUserCookie, {}).then(async (item) => assert.equal(item.status, 200, await item.clone().text()));
    await matchPostJson(`/api/matches/${singlesMatch.id}/confirm`, secondUserCookie, {}).then(async (item) => assert.equal(item.status, 200, await item.clone().text()));
    response = await fetchFromSite(`/api/matches/${singlesMatch.id}`, { headers: { cookie: firstUserCookie } });
    assert.deepEqual((await response.json()).permissions.retractableSides, [1],
      "A Singles participant can retract only their own currently confirmed side.");
    response = await fetchFromSite(`/api/matches/${singlesMatch.id}/confirm/retract`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ side: 1 })
    });
    assert.equal(response.status, 401, "Anonymous users cannot retract a side confirmation.");
    response = await matchPostJson(`/api/matches/${singlesMatch.id}/confirm/retract`, firstUserCookie, { side: 2 });
    assert.equal(response.status, 403, "A participant cannot manipulate the side parameter to retract the opponent's confirmation.");
    response = await matchPostJson(`/api/matches/${singlesMatch.id}/confirm/retract`, thirdUserCookie, { side: 1 });
    assert.equal(response.status, 403, "A nonparticipant cannot retract a side confirmation.");
    const concurrentRetractions = await Promise.all([
      matchPostJson(`/api/matches/${singlesMatch.id}/confirm/retract`, firstUserCookie, {}),
      matchPostJson(`/api/matches/${singlesMatch.id}/confirm/retract`, firstUserCookie, {})
    ]);
    assert.deepEqual(concurrentRetractions.map((item) => item.status).sort(), [200, 409],
      "Concurrent requests can retract a side confirmation only once.");
    const successfulRetraction = await concurrentRetractions.find((item) => item.status === 200).json();
    assert.equal(successfulRetraction.confirmations.find((item) => item.side === 1)?.action, "retracted",
      "A valid retraction changes only the latest side state and leaves the event recorded.");
    response = await matchPostJson(`/api/matches/${singlesMatch.id}/confirm`, firstUserCookie, {});
    assert.equal(response.status, 200, "A side may confirm again after a retraction.");
    response = await matchPostJson(`/api/matches/${singlesMatch.id}/finalize`, firstUserCookie, {});
    assert.equal(response.status, 200, await response.clone().text());
    const disputeAudit = await fetchFromSite(`/api/matches/${singlesMatch.id}/audit`, { headers: { cookie: firstUserCookie } });
    const disputeActions = (await disputeAudit.json()).events.map((event) => event.action_type);
    assert.ok(disputeActions.includes("dispute_raised"));
    assert.ok(disputeActions.includes("dispute_resolved"));
    assert.ok(disputeActions.includes("confirmation_retracted"), "A side retraction is recorded in the immutable match audit.");
    const retractionAudit = await database.query(
      "SELECT actor_user_id, action_type FROM match_audit_events WHERE match_id=$1 AND action_type='confirmation_retracted'",
      [singlesMatch.id]
    );
    assert.ok(retractionAudit.rows.some((event) => event.actor_user_id === firstUserId),
      "The audit event identifies the authenticated player who retracted their side's confirmation.");

    response = await matchPostJson("/api/matches", firstUserCookie, {
      type: "money_match", participants: [{ userId: firstUserId, side: 1 }, { userId: secondProfile.userId, side: 2 }],
      frames: [{ type: "singles" }],
      moneyTerms: { wagerAmount: 5, adminUserId: thirdProfile.userId }
    });
    assert.equal(response.status, 201, await response.clone().text());
    const moneyMatch = (await response.json()).match;
    assert.equal(moneyMatch.type, "money_match");
    response = await matchPostJson(`/api/matches/${moneyMatch.id}/money-acknowledgements`, secondUserCookie, { type: "player_a_terms" });
    assert.equal(response.status, 409, "Only the assigned player or Match Admin can record each Money Match acknowledgement.");
    for (const [type, sessionCookie] of [
      ["player_a_terms", firstUserCookie], ["player_b_terms", secondUserCookie], ["admin_role", thirdUserCookie],
      ["admin_stake_confirmed", thirdUserCookie], ["player_a_winner_takes_wager", firstUserCookie],
      ["player_b_winner_takes_wager", secondUserCookie]
    ]) {
      response = await matchPostJson(`/api/matches/${moneyMatch.id}/money-acknowledgements`, sessionCookie, { type });
      assert.equal(response.status, 200, await response.clone().text());
    }
    response = await matchPostJson(`/api/matches/${moneyMatch.id}/start`, thirdUserCookie, {});
    assert.equal(response.status, 403, "The appointed Money Match Admin cannot score solely because of that role.");
    response = await matchPostJson(`/api/matches/${moneyMatch.id}/start`, firstUserCookie, {});
    assert.equal(response.status, 200, "A competing Money Match player can start after the required acknowledgements.");
    await matchPutJson(`/api/matches/${moneyMatch.id}/frames/1/players`, firstUserCookie, { side: 1, players: [firstUserId] })
      .then(async (item) => assert.equal(item.status, 200, await item.clone().text()));
    await matchPutJson(`/api/matches/${moneyMatch.id}/frames/1/players`, secondUserCookie, { side: 2, players: [secondProfile.userId] })
      .then(async (item) => assert.equal(item.status, 200, await item.clone().text()));
    response = await matchPutJson(`/api/matches/${moneyMatch.id}/frames/1/result`, firstUserCookie, { outcome: "played", winnerSide: 1 });
    assert.equal(response.status, 200, await response.clone().text());
    for (const [type, sessionCookie] of [
      ["player_a_result", firstUserCookie], ["player_b_result", secondUserCookie], ["admin_final_confirmation", thirdUserCookie]
    ]) {
      response = await matchPostJson(`/api/matches/${moneyMatch.id}/money-acknowledgements`, sessionCookie, { type });
      assert.equal(response.status, 200, await response.clone().text());
    }
    await matchPostJson(`/api/matches/${moneyMatch.id}/confirm`, firstUserCookie, { side: 1 })
      .then(async (item) => assert.equal(item.status, 200, await item.clone().text()));
    await matchPostJson(`/api/matches/${moneyMatch.id}/confirm`, secondUserCookie, { side: 2 })
      .then(async (item) => assert.equal(item.status, 200, await item.clone().text()));
    response = await fetchFromSite(`/api/matches/${moneyMatch.id}`, { headers: { cookie: thirdUserCookie } });
    assert.equal(response.status, 200, "The appointed Money Match administrator can view that private match.");
    assert.equal((await response.json()).permissions.canFinalize, true,
      "The appointed administrator can finalize only through this Money Match's explicit assignment.");
    response = await fetchFromSite(`/api/matches/${moneyMatch.id}`, { headers: { cookie: fourthUserCookie } });
    assert.equal(response.status, 403, "A user without a participant or appointment role cannot view a private Money Match.");
    response = await matchPostJson(`/api/matches/${moneyMatch.id}/finalize`, fourthUserCookie, {});
    assert.equal(response.status, 403, "A direct finalize request from a user without a match-specific role is rejected.");
    response = await matchPostJson(`/api/matches/${moneyMatch.id}/finalize`, thirdUserCookie, {});
    assert.equal(response.status, 200, "The appointed Money Match administrator can finalize after all confirmations.");

    response = await matchPostJson("/api/matches", firstUserCookie, {
      type: "practice", participants: [{ userId: firstUserId, side: 1 }, { userId: secondProfile.userId, side: 2 }],
      frames: [{ type: "singles" }], formatName: "Friendly singles practice"
    });
    assert.equal(response.status, 201, await response.clone().text());
    const practiceMatch = (await response.json()).match;
    assert.equal(practiceMatch.type, "practice");
    const normalMatchMarkerClient = await database.connect();
    try {
      await normalMatchMarkerClient.query("BEGIN");
      await normalMatchMarkerClient.query("SELECT set_config('breakdish.actor_user_id',$1,true)", [superAdminUserId]);
      await assert.rejects(
        normalMatchMarkerClient.query("UPDATE matches SET test_only=true WHERE id=$1", [practiceMatch.id]),
        (error) => error.code === "55000" && error.constraint === "matches_test_only_immutable",
        "An existing normal Practice Match cannot be converted into a test-only record after creation."
      );
    } finally {
      await normalMatchMarkerClient.query("ROLLBACK").catch(() => {});
      normalMatchMarkerClient.release();
    }
    response = await fetchFromSite(`/api/matches/${practiceMatch.id}`);
    assert.equal(response.status, 401, "Practice match details are private to a signed-in participant.");
    response = await matchPostJson(`/api/matches/${practiceMatch.id}/start`, firstUserCookie, {});
    assert.equal(response.status, 200);
    await matchPutJson(`/api/matches/${practiceMatch.id}/frames/1/players`, firstUserCookie, { side: 1, players: [firstUserId] }).then(async (item) => assert.equal(item.status, 200, await item.clone().text()));
    await matchPutJson(`/api/matches/${practiceMatch.id}/frames/1/players`, firstUserCookie, { side: 2, players: [secondProfile.userId] }).then(async (item) => assert.equal(item.status, 200, await item.clone().text()));
    await matchPutJson(`/api/matches/${practiceMatch.id}/frames/1/result`, firstUserCookie, { outcome: "played", winnerSide: 1, dishEvent: "dish", dishPlayerId: firstUserId }).then(async (item) => assert.equal(item.status, 200, await item.clone().text()));
    await matchPostJson(`/api/matches/${practiceMatch.id}/confirm`, firstUserCookie, {}).then(async (item) => assert.equal(item.status, 200, await item.clone().text()));
    await matchPostJson(`/api/matches/${practiceMatch.id}/confirm`, secondUserCookie, {}).then(async (item) => assert.equal(item.status, 200, await item.clone().text()));
    response = await matchPostJson(`/api/matches/${practiceMatch.id}/finalize`, firstUserCookie, {});
    assert.equal(response.status, 200, await response.clone().text());
    const practiceStats = await database.query("SELECT matches_played,matches_won,dishes,practice_win_percentage FROM practice_player_statistics WHERE user_id=$1", [firstUserId]);
    assert.equal(Number(practiceStats.rows[0].matches_played), 1);
    assert.equal(Number(practiceStats.rows[0].matches_won), 1);
    assert.equal(Number(practiceStats.rows[0].dishes), 1);
    assert.equal(Number(practiceStats.rows[0].practice_win_percentage), 100);
    const practiceCategoryStats = await database.query("SELECT is_official,matches_played FROM match_player_statistics WHERE user_id=$1 AND match_type='practice'", [firstUserId]);
    assert.deepEqual(practiceCategoryStats.rows[0], { is_official: false, matches_played: 1 });

    const testPracticeParticipantCookies = await Promise.all([
      signUpPlayer("Profileless Test Participant One"),
      signUpPlayer("Profileless Test Participant Two")
    ]);
    const testPracticeParticipants = [];
    for (const cookie of testPracticeParticipantCookies) {
      const accountResponse = await fetchFromSite("/api/me", { headers: { cookie } });
      assert.equal(accountResponse.status, 200, await accountResponse.clone().text());
      testPracticeParticipants.push((await accountResponse.json()).user.id);
    }
    const testParticipantProfiles = await database.query(
      "SELECT count(*)::integer AS count FROM player_profiles WHERE user_id=ANY($1::text[])", [testPracticeParticipants]
    );
    assert.equal(testParticipantProfiles.rows[0].count, 0,
      "Fresh, genuine Better Auth accounts do not need player_profiles rows to participate in a standalone test match.");
    const testPracticeBody = {
      type: "practice",
      participants: [{ userId: testPracticeParticipants[0], side: 1 }, { userId: testPracticeParticipants[1], side: 2 }],
      frames: [{ type: "singles" }],
      formatName: "Controlled Match Centre lifecycle test"
    };
    const testPracticeKey = crypto.randomUUID();
    const missingParticipantKey = crypto.randomUUID();
    const failedCreationCounts = await database.query(`
      SELECT
        (SELECT count(*) FROM matches) AS matches,
        (SELECT count(*) FROM match_format_snapshots) AS snapshots,
        (SELECT count(*) FROM match_format_snapshot_frames) AS snapshot_frames,
        (SELECT count(*) FROM match_frames) AS frames,
        (SELECT count(*) FROM match_participants) AS participants,
        (SELECT count(*) FROM match_frame_players) AS frame_players,
        (SELECT count(*) FROM match_frame_events) AS frame_events,
        (SELECT count(*) FROM match_confirmations) AS confirmations,
        (SELECT count(*) FROM match_disputes) AS disputes,
        (SELECT count(*) FROM match_dispute_resolutions) AS dispute_resolutions,
        (SELECT count(*) FROM match_audit_events) AS audit_events
    `);
    response = await matchPostJson("/api/platform/test-practice-matches", superAdminCookie, {
      ...testPracticeBody,
      participants: [{ userId: `missing-${crypto.randomUUID()}`, side: 1 }, { userId: testPracticeParticipants[1], side: 2 }]
    }, { "Idempotency-Key": missingParticipantKey });
    assert.equal(response.status, 404, "A missing participant is reported as a safe not-found response by the mounted endpoint.");
    assert.deepEqual(await response.json(), { error: "A referenced player, team, season or match could not be found." });
    const failedCreationCount = await database.query(
      "SELECT count(*)::integer AS count FROM matches WHERE test_request_key=$1", [missingParticipantKey]
    );
    assert.equal(failedCreationCount.rows[0].count, 0, "The transaction rolls back the match row when a participant reference is invalid.");
    const afterFailedCreationCounts = await database.query(`
      SELECT
        (SELECT count(*) FROM matches) AS matches,
        (SELECT count(*) FROM match_format_snapshots) AS snapshots,
        (SELECT count(*) FROM match_format_snapshot_frames) AS snapshot_frames,
        (SELECT count(*) FROM match_frames) AS frames,
        (SELECT count(*) FROM match_participants) AS participants,
        (SELECT count(*) FROM match_frame_players) AS frame_players,
        (SELECT count(*) FROM match_frame_events) AS frame_events,
        (SELECT count(*) FROM match_confirmations) AS confirmations,
        (SELECT count(*) FROM match_disputes) AS disputes,
        (SELECT count(*) FROM match_dispute_resolutions) AS dispute_resolutions,
        (SELECT count(*) FROM match_audit_events) AS audit_events
    `);
    assert.deepEqual(afterFailedCreationCounts.rows, failedCreationCounts.rows,
      "The failed creation leaves no match, snapshot, frames, participants, scoring records, confirmations, disputes or audit events.");

    response = await matchPostJson("/api/platform/test-practice-matches", "", testPracticeBody, { "Idempotency-Key": crypto.randomUUID() });
    assert.equal(response.status, 401, "Anonymous users cannot create test-only Practice Matches.");
    response = await matchPostJson("/api/platform/test-practice-matches", platformAdminCookie, testPracticeBody, { "Idempotency-Key": crypto.randomUUID() });
    assert.equal(response.status, 403, "Platform Admin cannot create test-only Practice Matches.");
    response = await matchPostJson("/api/matches", superAdminCookie, { ...testPracticeBody, testOnly: true });
    assert.equal(response.status, 400, "The ordinary match endpoint cannot accept a client-controlled test-only flag.");
    response = await matchPostJson("/api/platform/test-practice-matches", superAdminCookie,
      { ...testPracticeBody, tournamentEventId: crypto.randomUUID() }, { "Idempotency-Key": crypto.randomUUID() });
    assert.equal(response.status, 400, "Test-only Practice Matches cannot be attached to a tournament or other competition record.");

    const rejectedDirectTestInsert = async (actorId, category, constraint, code) => {
      const client = await database.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('breakdish.actor_user_id',$1,true)", [actorId]);
        await assert.rejects(
          client.query(
            "INSERT INTO matches(match_type,created_by,test_only,test_request_key) VALUES($1,$2,true,$3)",
            [category, actorId, crypto.randomUUID()]
          ),
          (error) => error.code === code && error.constraint === constraint,
          "The database itself must enforce test-only match creation policy."
        );
      } finally {
        await client.query("ROLLBACK").catch(() => {});
        client.release();
      }
    };
    await rejectedDirectTestInsert(platformAdminUserId, "practice", "matches_test_only_super_admin_required", "42501");
    await rejectedDirectTestInsert(superAdminUserId, "team_league", "matches_test_only_practice_only", "23514");

    const practiceStatsBeforeTestMatch = await database.query(
      "SELECT user_id,matches_played,matches_won,matches_lost,frames_played,frames_won,frames_lost,dishes,counter_dishes,practice_win_percentage FROM practice_player_statistics WHERE user_id=ANY($1::text[]) ORDER BY user_id",
      [testPracticeParticipants]
    );
    const competitiveStatsBeforeTestMatch = await database.query(
      "SELECT user_id,matches_played,matches_won,matches_lost,frames_played,frames_won,frames_lost,dishes,counter_dishes,competitive_win_percentage FROM official_competitive_player_statistics WHERE user_id=ANY($1::text[]) ORDER BY user_id",
      [testPracticeParticipants]
    );
    const testCreationAttempts = await Promise.all([
      matchPostJson("/api/platform/test-practice-matches", superAdminCookie, testPracticeBody, { "Idempotency-Key": testPracticeKey }),
      matchPostJson("/api/platform/test-practice-matches", superAdminCookie, testPracticeBody, { "Idempotency-Key": testPracticeKey })
    ]);
    assert.deepEqual(testCreationAttempts.map((item) => item.status).sort(), [201, 409],
      "Concurrent duplicate test requests create one match and return a safe conflict to the duplicate.");
    const testMatchResponse = await testCreationAttempts.find((item) => item.status === 201).json();
    const testPracticeMatch = testMatchResponse.match;
    assert.equal(testPracticeMatch.type, "practice");
    assert.equal(testPracticeMatch.testOnly, true);
    const oneTestMatch = await database.query("SELECT id FROM matches WHERE test_only AND test_request_key=$1", [testPracticeKey]);
    assert.deepEqual(oneTestMatch.rows, [{ id: testPracticeMatch.id }], "The idempotency key is unique and no duplicate record was created.");
    const finalMatchCountForKey = await database.query("SELECT count(*)::integer AS count FROM matches WHERE test_request_key=$1", [testPracticeKey]);
    assert.equal(finalMatchCountForKey.rows[0].count, 1);

    const markerClient = await database.connect();
    try {
      await markerClient.query("BEGIN");
      await markerClient.query("SELECT set_config('breakdish.actor_user_id',$1,true)", [superAdminUserId]);
      await assert.rejects(
        markerClient.query("UPDATE matches SET test_only=false WHERE id=$1", [testPracticeMatch.id]),
        (error) => error.code === "55000" && error.constraint === "matches_test_only_immutable",
        "The test-only marker cannot be removed or changed after creation."
      );
    } finally {
      await markerClient.query("ROLLBACK").catch(() => {});
      markerClient.release();
    }

    const anonymousTestDetails = await fetchFromSite(`/api/matches/${testPracticeMatch.id}`);
    assert.equal(anonymousTestDetails.status, 401, "Test-only Practice Match detail requires authentication.");
    const unrelatedTestDetails = await fetchFromSite(`/api/matches/${testPracticeMatch.id}`, { headers: { cookie: fifthUserCookie } });
    assert.equal(unrelatedTestDetails.status, 403, "An unrelated signed-in account cannot view a test-only Practice Match.");
    const platformAdminTestDetails = await fetchFromSite(`/api/matches/${testPracticeMatch.id}`, { headers: { cookie: platformAdminCookie } });
    assert.equal(platformAdminTestDetails.status, 403,
      "Platform Admin role alone does not reveal a private test-only Practice Match.");
    for (const deniedDetails of [anonymousTestDetails, unrelatedTestDetails, platformAdminTestDetails]) {
      const deniedBody = await deniedDetails.json();
      assert.equal(deniedBody.match, undefined, "Denied detail responses must not disclose private match data.");
      assert.equal(deniedBody.frames, undefined, "Denied detail responses must not disclose frame history.");
      assert.equal(deniedBody.permissions, undefined, "Denied detail responses must not disclose match capabilities.");
    }
    response = await fetchFromSite(`/api/matches/${testPracticeMatch.id}`, { headers: { cookie: superAdminCookie } });
    assert.equal(response.status, 200);
    let testMatchDetail = await response.json();
    assert.equal(testMatchDetail.match.testOnly, true);
    assert.equal(testMatchDetail.permissions.canOperate, false,
      "Being the Super Admin creator does not grant match-scoring permission when not a participant.");
    assert.equal(testMatchDetail.permissions.canScore, false);
    response = await matchPostJson(`/api/matches/${testPracticeMatch.id}/start`, superAdminCookie, {});
    assert.equal(response.status, 403, "Super Admin creator cannot start or score solely by role or creation authority.");
    response = await matchPostJson(`/api/matches/${testPracticeMatch.id}/start`, testPracticeParticipantCookies[0], {});
    assert.equal(response.status, 200, await response.clone().text());
    const activePublicTestListing = await fetchFromSite("/api/matches/live");
    assert.equal(activePublicTestListing.status, 200);
    assert.equal((await activePublicTestListing.json()).matches.some((item) => item.id === testPracticeMatch.id), false,
      "An in-progress test-only Practice Match is excluded from public live-match discovery.");
    const privateScoreRequest = {
      outcome: "played", winnerSide: 1
    };
    const anonymousScore = await fetchFromSite(`/api/matches/${testPracticeMatch.id}/frames/1/result`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(privateScoreRequest)
    });
    assert.equal(anonymousScore.status, 401,
      "Anonymous users cannot submit score changes to a private test-only Practice Match.");
    const unrelatedScore = await matchPutJson(`/api/matches/${testPracticeMatch.id}/frames/1/result`, fifthUserCookie, privateScoreRequest);
    assert.equal(unrelatedScore.status, 403,
      "An unrelated signed-in account cannot submit score changes to a private test-only Practice Match.");
    const platformAdminScore = await matchPutJson(`/api/matches/${testPracticeMatch.id}/frames/1/result`, platformAdminCookie, privateScoreRequest);
    assert.equal(platformAdminScore.status, 403,
      "Platform Admin role alone does not grant score changes on a private test-only Practice Match.");
    for (const deniedScore of [anonymousScore, unrelatedScore, platformAdminScore]) {
      const deniedBody = await deniedScore.json();
      assert.equal(deniedBody.match, undefined, "Rejected scoring responses must not expose private match details.");
      assert.equal(deniedBody.permissions, undefined, "Rejected scoring responses must not expose match capabilities.");
    }
    response = await fetchFromSite(`/api/matches/${testPracticeMatch.id}`, { headers: { cookie: testPracticeParticipantCookies[0] } });
    assert.equal(response.status, 200);
    testMatchDetail = await response.json();
    assert.equal(testMatchDetail.match.testOnly, true, "The participant detail API marks the test match for display.");
    assert.equal(testMatchDetail.permissions.canScore, true);
    response = await matchPutJson(`/api/matches/${testPracticeMatch.id}/frames/1/players`, testPracticeParticipantCookies[0],
      { side: 1, players: [testPracticeParticipants[0]] });
    assert.equal(response.status, 200, await response.clone().text());
    response = await matchPutJson(`/api/matches/${testPracticeMatch.id}/frames/1/players`, testPracticeParticipantCookies[1],
      { side: 2, players: [testPracticeParticipants[1]] });
    assert.equal(response.status, 200, await response.clone().text());
    response = await matchPutJson(`/api/matches/${testPracticeMatch.id}/frames/1/result`, testPracticeParticipantCookies[0],
      { outcome: "played", winnerSide: 1, dishEvent: "dish", dishPlayerId: testPracticeParticipants[0] });
    assert.equal(response.status, 200, await response.clone().text());
    response = await matchPostJson(`/api/matches/${testPracticeMatch.id}/disputes`, testPracticeParticipantCookies[1],
      { reason: "Controlled test dispute" });
    assert.equal(response.status, 201, await response.clone().text());
    const testDispute = (await response.json()).disputes[0];
    response = await matchPostJson(`/api/matches/${testPracticeMatch.id}/disputes/${testDispute.id}/resolve`, superAdminCookie,
      { resolution: "Test frame was checked; recorded result stands." });
    assert.equal(response.status, 200, "The creator has only the specific dispute-resolution authority already allowed for a standalone match.");
    await matchPostJson(`/api/matches/${testPracticeMatch.id}/confirm`, testPracticeParticipantCookies[0], {}).then(async (item) => assert.equal(item.status, 200, await item.clone().text()));
    await matchPostJson(`/api/matches/${testPracticeMatch.id}/confirm`, testPracticeParticipantCookies[1], {}).then(async (item) => assert.equal(item.status, 200, await item.clone().text()));
    response = await matchPostJson(`/api/matches/${testPracticeMatch.id}/finalize`, testPracticeParticipantCookies[0], {});
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).match.testOnly, true, "Finalization retains the test-only classification.");

    const privateTestListing = await fetchFromSite("/api/matches", { headers: { cookie: testPracticeParticipantCookies[0] } });
    assert.equal((await privateTestListing.json()).matches.find((item) => item.id === testPracticeMatch.id)?.testOnly, true,
      "An authorized participant can still find and identify the private test record.");
    for (const headers of [{}, { cookie: fifthUserCookie }]) {
      const privateListing = await fetchFromSite("/api/matches", { headers });
      assert.equal(privateListing.status, 200);
      assert.equal((await privateListing.json()).matches.some((item) => item.id === testPracticeMatch.id), false,
        "Anonymous and unrelated viewers cannot discover a private test-only Practice Match in general listings.");
    }

    const retainedTestAudit = await fetchFromSite(`/api/matches/${testPracticeMatch.id}/audit`, { headers: { cookie: testPracticeParticipantCookies[0] } });
    assert.equal(retainedTestAudit.status, 200);
    const anonymousTestAudit = await fetchFromSite(`/api/matches/${testPracticeMatch.id}/audit`);
    assert.equal(anonymousTestAudit.status, 401,
      "The audit route requires authentication before it checks private-match authorization.");
    const unrelatedTestAudit = await fetchFromSite(`/api/matches/${testPracticeMatch.id}/audit`, { headers: { cookie: fifthUserCookie } });
    assert.equal(unrelatedTestAudit.status, 403,
      "Unrelated signed-in viewers cannot access private test-match audit history.");
    const platformAdminTestAudit = await fetchFromSite(`/api/matches/${testPracticeMatch.id}/audit`, { headers: { cookie: platformAdminCookie } });
    assert.equal(platformAdminTestAudit.status, 403,
      "Platform Admin role alone does not expose private test-match audit history.");
    const creatorTestAudit = await fetchFromSite(`/api/matches/${testPracticeMatch.id}/audit`, { headers: { cookie: superAdminCookie } });
    assert.equal(creatorTestAudit.status, 200,
      "The Super Admin who created the private test match may inspect its audit without receiving scoring authority.");
    for (const deniedAudit of [anonymousTestAudit, unrelatedTestAudit, platformAdminTestAudit]) {
      const deniedBody = await deniedAudit.json();
      assert.equal(deniedBody.events, undefined, "Denied audit responses must not disclose private audit history.");
      assert.equal(deniedBody.match, undefined, "Denied audit responses must not disclose private match details.");
      assert.equal(deniedBody.permissions, undefined, "Denied audit responses must not disclose match capabilities.");
    }
    const testAuditEvents = (await retainedTestAudit.json()).events;
    const testAuditActions = testAuditEvents.map((event) => event.action_type);
    for (const action of ["match_created", "frame_result_entered", "dispute_raised", "dispute_resolved", "confirmation_confirmed", "match_finalized"]) {
      assert.ok(testAuditActions.includes(action), `Test match audit is missing ${action}.`);
    }
    const testCreationAudit = await database.query(
      "SELECT new_value->>'test_only' AS test_only FROM match_audit_events WHERE match_id=$1 AND action_type='match_created'",
      [testPracticeMatch.id]
    );
    assert.deepEqual(testCreationAudit.rows, [{ test_only: "true" }], "The immutable creation audit records the test-only marker.");
    const testAuditCountBeforeDelete = await database.query("SELECT count(*)::integer AS count FROM match_audit_events WHERE match_id=$1", [testPracticeMatch.id]);
    await assert.rejects(
      database.query("DELETE FROM match_audit_events WHERE match_id=$1", [testPracticeMatch.id]),
      (error) => error.code === "55000" && /Match audit history is append-only\./.test(error.message),
      "Test match audit rows cannot be deleted during cleanup."
    );
    const testAuditCountAfterDelete = await database.query("SELECT count(*)::integer AS count FROM match_audit_events WHERE match_id=$1", [testPracticeMatch.id]);
    assert.equal(testAuditCountAfterDelete.rows[0].count, testAuditCountBeforeDelete.rows[0].count);

    const practiceStatsAfterTestMatch = await database.query(
      "SELECT user_id,matches_played,matches_won,matches_lost,frames_played,frames_won,frames_lost,dishes,counter_dishes,practice_win_percentage FROM practice_player_statistics WHERE user_id=ANY($1::text[]) ORDER BY user_id",
      [testPracticeParticipants]
    );
    const competitiveStatsAfterTestMatch = await database.query(
      "SELECT user_id,matches_played,matches_won,matches_lost,frames_played,frames_won,frames_lost,dishes,counter_dishes,competitive_win_percentage FROM official_competitive_player_statistics WHERE user_id=ANY($1::text[]) ORDER BY user_id",
      [testPracticeParticipants]
    );
    assert.deepEqual(practiceStatsAfterTestMatch.rows, practiceStatsBeforeTestMatch.rows,
      "The completed test match never changes practice aggregates.");
    assert.deepEqual(competitiveStatsAfterTestMatch.rows, competitiveStatsBeforeTestMatch.rows,
      "The test match never changes competitive aggregates.");

    const publicMatches = await fetchFromSite("/api/matches");
    assert.equal(publicMatches.status, 200);
    const publicMatchIds = (await publicMatches.json()).matches.map((item) => item.id);
    assert.equal([practiceMatch.id, moneyMatch.id].some((id) => publicMatchIds.includes(id)), false,
      "The public match listing excludes private practice and Money Matches.");

    const creatorMatchResponse = await fetchFromSite("/api/matches", { headers: { cookie: firstUserCookie } });
    assert.equal(creatorMatchResponse.status, 200, await creatorMatchResponse.clone().text());
    const creatorMatchIds = (await creatorMatchResponse.json()).matches.map((item) => item.id);
    assert.ok(creatorMatchIds.includes(practiceMatch.id), "A signed-in creator can list their private Practice Match.");
    assert.ok(creatorMatchIds.includes(moneyMatch.id), "A signed-in creator can list their private Money Match.");

    const participantMatchResponse = await fetchFromSite("/api/matches", { headers: { cookie: secondUserCookie } });
    assert.equal(participantMatchResponse.status, 200, await participantMatchResponse.clone().text());
    const participantMatchIds = (await participantMatchResponse.json()).matches.map((item) => item.id);
    assert.ok(participantMatchIds.includes(practiceMatch.id), "A recorded Practice Match participant can list it.");
    assert.ok(participantMatchIds.includes(moneyMatch.id), "A recorded Money Match participant can list it.");

    const appointedAdminMatchResponse = await fetchFromSite("/api/matches", { headers: { cookie: thirdUserCookie } });
    assert.equal(appointedAdminMatchResponse.status, 200, await appointedAdminMatchResponse.clone().text());
    const appointedAdminMatchIds = (await appointedAdminMatchResponse.json()).matches.map((item) => item.id);
    assert.ok(appointedAdminMatchIds.includes(moneyMatch.id), "The appointed Money Match Admin can find the one private match assigned to them.");
    assert.equal(appointedAdminMatchIds.includes(practiceMatch.id), false, "Money Match appointment does not expose private Practice Matches.");

    const unrelatedMatchResponse = await fetchFromSite("/api/matches", { headers: { cookie: fourthUserCookie } });
    assert.equal(unrelatedMatchResponse.status, 200, await unrelatedMatchResponse.clone().text());
    const unrelatedMatchIds = (await unrelatedMatchResponse.json()).matches.map((item) => item.id);
    assert.equal([practiceMatch.id, moneyMatch.id].some((id) => unrelatedMatchIds.includes(id)), false,
      "A signed-in user without a match-specific appointment cannot list another user's private matches.");

    const entryClient = await database.connect();
    try {
      await entryClient.query("BEGIN");
      await entryClient.query("SELECT set_config('breakdish.actor_user_id',$1,true)", [firstUserId]);
      const entryInsert = await entryClient.query(
        `INSERT INTO competition_entries(entry_type,league_id,season_id,created_by)
         VALUES('singles_league',$1,$2,$3) RETURNING id`, [approval.league.id, matchSeason.id, firstUserId]
      );
      const entryId = entryInsert.rows[0].id;
      await entryClient.query("UPDATE competition_entries SET status='payment_confirmed' WHERE id=$1", [entryId]);
      await entryClient.query("UPDATE competition_entries SET status='approved' WHERE id=$1", [entryId]);
      const entryHistory = await entryClient.query("SELECT old_status,new_status FROM competition_entry_events WHERE entry_id=$1 ORDER BY occurred_at,id", [entryId]);
      assert.deepEqual(entryHistory.rows.map((event) => event.new_status).sort(), ["approved", "payment_confirmed", "pending"].sort());
      await entryClient.query("COMMIT");
    } catch (error) {
      await entryClient.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      entryClient.release();
    }

    response = await patchJson(`/api/seasons/${season.id}`, firstUserCookie, { status: "completed" });
    assert.equal(response.status, 200);
    response = await patchJson(`/api/seasons/${season.id}`, firstUserCookie, { status: "active" });
    assert.equal(response.status, 409, "Completed seasons cannot be reopened.");
    response = await postJson(`/api/teams/${northTeam.id}/members`, firstUserCookie, { userId: fourthProfile.userId });
    assert.equal(response.status, 409, "Completed seasons reject roster mutations.");

    const databaseGuard = await assert.rejects(
      database.query("INSERT INTO team_memberships (team_id,user_id,role,status) VALUES ($1,$2,'player','active')", [northTeam.id, fifthProfile.userId]),
      (error) => error.code === "23514" && error.constraint === "team_membership_team_available"
    ).then(() => true);
    assert.equal(databaseGuard, true, "Database guards must protect team/season eligibility from direct writes.");

    const historicSeasonsBeforeCompletion = await fetchFromSite(`/api/historic-results/${approval.league.id}/seasons`);
    assert.equal(historicSeasonsBeforeCompletion.status, 200);
    assert.equal((await historicSeasonsBeforeCompletion.json()).seasons.some((item) => item.id === matchSeason.id), false,
      "Historic browsing excludes seasons until they are completed.");
    response = await patchJson(`/api/seasons/${matchSeason.id}`, firstUserCookie, { status: "active" });
    assert.equal(response.status, 200, await response.clone().text());
    response = await patchJson(`/api/seasons/${matchSeason.id}`, firstUserCookie, { status: "completed" });
    assert.equal(response.status, 200, await response.clone().text());

    const historicDataCountsBefore = await database.query(
      `SELECT (SELECT count(*)::integer FROM matches) AS matches,
              (SELECT count(*)::integer FROM match_frames) AS frames,
              (SELECT count(*)::integer FROM match_frame_events) AS frame_events,
              (SELECT count(*)::integer FROM match_audit_events) AS audit_events`
    );
    const historicLeaguesResponse = await fetchFromSite("/api/historic-results");
    assert.equal(historicLeaguesResponse.status, 200, await historicLeaguesResponse.clone().text());
    const historicLeagues = (await historicLeaguesResponse.json()).leagues;
    const historicLeague = historicLeagues.find((item) => item.id === approval.league.id);
    assert.ok(historicLeague, "A public league appears when it has a completed season and a completed league result.");
    assert.ok(historicLeague.seasonCount >= 1 && historicLeague.resultCount >= 1);

    const historicSeasonsResponse = await fetchFromSite(`/api/historic-results/${approval.league.id}/seasons`);
    assert.equal(historicSeasonsResponse.status, 200, await historicSeasonsResponse.clone().text());
    const historicSeasons = (await historicSeasonsResponse.json()).seasons;
    const historicSeason = historicSeasons.find((item) => item.id === matchSeason.id);
    assert.ok(historicSeason, "Completed seasons with results are available within their league.");
    assert.ok(historicSeason.resultCount >= 1);

    const historicMatchesResponse = await fetchFromSite(
      `/api/historic-results/${approval.league.id}/seasons/${matchSeason.id}/matches`
    );
    assert.equal(historicMatchesResponse.status, 200, await historicMatchesResponse.clone().text());
    const historicMatches = (await historicMatchesResponse.json()).matches;
    assert.ok(historicMatches.every((item) => item.status === "completed" && item.isOfficial === true),
      "The historic results endpoint contains completed official league matches only.");
    assert.ok(historicMatches.some((item) => item.id === matchUnderTest.id), "The finalized team league fixture is listed.");
    assert.equal(historicMatches.some((item) => item.id === untouchedFutureMatch.id), false,
      "Scheduled future matches are excluded from historic results.");
    const historicTeamResult = historicMatches.find((item) => item.id === matchUnderTest.id);
    assert.equal(historicTeamResult.type, "team_league");
    assert.equal(historicTeamResult.homeTeam, homeMatchTeam.name);
    assert.equal(historicTeamResult.awayTeam, awayMatchTeam.name);
    assert.deepEqual([historicTeamResult.homeScore, historicTeamResult.awayScore], [2, 3]);
    assert.ok(historicTeamResult.completedAt, "Final results use the stored completion timestamp.");

    const unrelatedSeasonResults = await fetchFromSite(
      `/api/historic-results/${approval.league.id}/seasons/${season.id}/matches`
    );
    assert.equal(unrelatedSeasonResults.status, 200);
    assert.deepEqual((await unrelatedSeasonResults.json()).matches, [], "Historic results remain scoped to the selected league and season.");
    const historicDataCountsAfter = await database.query(
      `SELECT (SELECT count(*)::integer FROM matches) AS matches,
              (SELECT count(*)::integer FROM match_frames) AS frames,
              (SELECT count(*)::integer FROM match_frame_events) AS frame_events,
              (SELECT count(*)::integer FROM match_audit_events) AS audit_events`
    );
    assert.deepEqual(historicDataCountsAfter.rows[0], historicDataCountsBefore.rows[0],
      "Reading the historic results directory does not modify native match data.");

    response = await fetchFromSite("/api/auth/sign-out", {
      method: "POST", headers: { cookie: thirdUserCookie, "content-type": "application/json" }, body: "{}"
    });
    assert.equal(response.status, 200);

    response = await fetchFromSite("/api/auth/sign-out", {
      method: "POST",
      headers: { cookie: firstUserCookie, "content-type": "application/json" },
      body: "{}"
    });
    assert.equal(response.status, 200);

    response = await fetchFromSite("/api/me", { headers: { cookie: firstUserCookie } });
    assert.equal(response.status, 401, "A logged-out session must no longer authenticate requests.");
    response = await fetchFromSite("/api/auth/sign-out", {
      method: "POST",
      headers: { cookie: secondUserCookie, "content-type": "application/json" },
      body: "{}"
    });
    assert.equal(response.status, 200);
  } finally {
    try {
      if (migrationApiTestRoleCreated) {
        await database.query(`DROP OWNED BY "${migrationApiTestRole}"`);
        await database.query(`REVOKE "${migrationApiTestRole}" FROM CURRENT_USER`);
        await database.query(`DROP ROLE "${migrationApiTestRole}"`);
      }
    } finally {
      if (originalApiDatabaseRole === undefined) delete process.env.API_DATABASE_ROLE;
      else process.env.API_DATABASE_ROLE = originalApiDatabaseRole;
      await shutDown();
      await closeAuthDatabase();
    }
  }
});
