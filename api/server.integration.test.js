import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

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
  process.env.ALLOWED_ORIGINS = "http://localhost:5500";
  process.env.NODE_ENV = "test";
  process.env.PORT = "0";
  delete process.env.RESEND_API_KEY;
  delete process.env.CONTACT_FROM_EMAIL;

  const [{ auth, database, closeAuthDatabase }, { start, shutDown }] = await Promise.all([
    import("./auth.js"),
    import("./server.js")
  ]);
  const server = await start({
    emailSender: { async sendContactEmail() {} },
    getAuthInstance: async () => auth
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

  try {
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
    const signUpPlayer = async (name) => {
      const created = await fetchFromSite("/api/auth/sign-up/email", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, email: `${name.toLowerCase().replace(/\s+/g, "-")}-${crypto.randomUUID()}@example.test`, password: "correct-horse-battery-staple" })
      });
      assert.equal(created.status, 200, await created.clone().text());
      return cookieFrom(created);
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
    assert.ok(racingTransfers.every((item) => item.status === 201), "Concurrent authorised transfers are serialized as sequential, non-overlapping history.");
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
    const matchPostJson = (path, sessionCookie, body) => fetchFromSite(path, {
      method: "POST", headers: { cookie: sessionCookie, "content-type": "application/json", "x-forwarded-for": "203.0.113.141" },
      body: JSON.stringify(body)
    });
    const matchPutJson = (path, sessionCookie, body) => fetchFromSite(path, {
      method: "PUT", headers: { cookie: sessionCookie, "content-type": "application/json", "x-forwarded-for": "203.0.113.142" },
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

    const formatV1Frames = ["singles", "singles", "doubles", "singles", "doubles"].map((type) => ({ type }));
    response = await matchPutJson(`/api/leagues/${approval.league.id}/match-format`, firstUserCookie, {
      name: "Match engine integration format v1", frames: formatV1Frames
    });
    assert.equal(response.status, 200, await response.clone().text());
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
    response = await fetchFromSite(`/api/matches/${matchUnderTest.id}`);
    assert.equal(response.status, 200, await response.clone().text());
    let matchDetail = await response.json();
    assert.equal(matchDetail.match.type, "team_league");
    assert.equal(matchDetail.frames.length, 5);
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
    response = await matchPutJson(`/api/leagues/${approval.league.id}/match-format`, firstUserCookie, {
      name: "Restored mixed format", frames: formatV1Frames, applyToFuture: true
    });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).format.updatedMatches, 2,
      "League administrators can apply a new revision to all future unplayed fixtures.");
    response = await fetchFromSite(`/api/matches/${matchUnderTest.id}`);
    assert.equal((await response.json()).frames.length, 5);

    response = await fetchFromSite(`/api/matches/${matchUnderTest.id}/eligible-players?side=1`);
    assert.equal(response.status, 401, "Eligible-player reads require a session.");
    response = await fetchFromSite(`/api/matches/${matchUnderTest.id}/eligible-players?side=1`, { headers: { cookie: firstUserCookie } });
    assert.equal(response.status, 200);
    const eligibleHomePlayers = (await response.json()).players;
    assert.deepEqual(eligibleHomePlayers.map((player) => player.userId).sort(), [firstUserId, secondProfile.userId].sort(),
      "Team scoreboard choices come only from active registrations to the correct team.");

    response = await matchPostJson(`/api/matches/${matchUnderTest.id}/start`, thirdUserCookie, {});
    assert.equal(response.status, 200, "Any authenticated player can start an active scoreboard.");
    const setFrameSide = async (matchId, frame, side, selection) => {
      const result = await matchPutJson(`/api/matches/${matchId}/frames/${frame}/players`, firstUserCookie, { side, ...selection });
      assert.equal(result.status, 200, await result.clone().text());
      return result.json();
    };
    const recordFrame = async (matchId, frame, details) => {
      const result = await matchPutJson(`/api/matches/${matchId}/frames/${frame}/result`, firstUserCookie, details);
      assert.equal(result.status, 200, await result.clone().text());
      return result.json();
    };
    await setFrameSide(matchUnderTest.id, 1, 1, { players: [firstUserId] });
    await setFrameSide(matchUnderTest.id, 1, 2, { players: [thirdProfile.userId] });
    await recordFrame(matchUnderTest.id, 1, { outcome: "played", winnerSide: 1, dishEvent: "dish", dishPlayerId: firstUserId });
    await setFrameSide(matchUnderTest.id, 2, 1, { bye: true, players: [] });
    await setFrameSide(matchUnderTest.id, 2, 2, { players: [fourthProfile.userId] });
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
    assert.equal(matchDetail.match.homeScore, 2);
    assert.equal(matchDetail.match.awayScore, 3);
    assert.equal(matchDetail.match.framesRemaining, 0);
    assert.ok(matchDetail.frames[0].players.some((player) => player.userId === firstUserId));
    assert.ok(matchDetail.frames[2].players.some((player) => player.userId === firstUserId), "A player may play repeatedly across frames.");
    const frameEvents = await database.query("SELECT frame_number,event_type FROM match_frame_events WHERE match_id=$1 ORDER BY frame_number", [matchUnderTest.id]);
    assert.deepEqual(frameEvents.rows, [{ frame_number: 1, event_type: "dish" }, { frame_number: 3, event_type: "counter_dish" }]);
    const byeDecoration = await database.query("SELECT count(*)::integer AS count FROM match_frame_events WHERE match_id=$1 AND frame_number=2", [matchUnderTest.id]);
    assert.equal(byeDecoration.rows[0].count, 0, "Bye wins cannot carry Dish or Counter Dish records.");

    response = await matchPostJson(`/api/matches/${matchUnderTest.id}/confirm`, firstUserCookie, { side: 1 });
    assert.equal(response.status, 200, await response.clone().text());
    response = await matchPostJson(`/api/matches/${matchUnderTest.id}/confirm`, secondUserCookie, { side: 2 });
    assert.equal(response.status, 200, await response.clone().text());
    response = await matchPostJson(`/api/matches/${matchUnderTest.id}/finalize`, thirdUserCookie, {});
    assert.equal(response.status, 200, "Both distinct sides' confirmations allow finalization.");
    matchDetail = await response.json();
    assert.equal(matchDetail.match.status, "completed");
    const finalizedAudit = await fetchFromSite(`/api/matches/${matchUnderTest.id}/audit`, { headers: { cookie: firstUserCookie } });
    assert.equal(finalizedAudit.status, 200);
    const auditActions = (await finalizedAudit.json()).events.map((event) => event.action_type);
    for (const action of ["match_started", "player_selection_changed", "frame_result_entered", "bye_entered", "confirmation_confirmed", "match_finalized"]) {
      assert.ok(auditActions.includes(action), `Missing immutable audit action ${action}.`);
    }
    const officialTeamStats = await database.query("SELECT matches_played, matches_won, matches_lost FROM official_competitive_player_statistics WHERE user_id=$1", [firstUserId]);
    assert.equal(Number(officialTeamStats.rows[0].matches_played), 1);
    assert.equal(Number(officialTeamStats.rows[0].matches_lost), 1, "The official match winner is derived from the frame winners.");

    response = await matchPostJson("/api/tournaments", firstUserCookie, { name: `Local Flyer ${crypto.randomUUID()}`, venue: "Test room" });
    assert.equal(response.status, 201, await response.clone().text());
    const tournamentEvent = (await response.json()).event;
    response = await matchPostJson("/api/matches", firstUserCookie, {
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

    response = await matchPostJson("/api/matches", firstUserCookie, {
      type: "doubles_league", leagueId: approval.league.id, seasonId: matchSeason.id,
      participants: [
        { userId: firstUserId, side: 1 }, { userId: secondProfile.userId, side: 1 },
        { userId: thirdProfile.userId, side: 2 }, { userId: fourthProfile.userId, side: 2 }
      ]
    });
    assert.equal(response.status, 201, await response.clone().text());
    const doublesLeagueMatch = (await response.json()).match;
    assert.equal(doublesLeagueMatch.type, "doubles_league");
    response = await matchPutJson(`/api/leagues/${approval.league.id}/match-format`, firstUserCookie, {
      name: "Single-frame dispute test", frames: [{ type: "singles" }]
    });
    assert.equal(response.status, 200, await response.clone().text());
    response = await matchPostJson("/api/matches", firstUserCookie, {
      type: "singles_league", leagueId: approval.league.id, seasonId: matchSeason.id,
      participants: [{ userId: firstUserId, side: 1 }, { userId: secondProfile.userId, side: 2 }]
    });
    assert.equal(response.status, 201, await response.clone().text());
    const singlesMatch = (await response.json()).match;
    assert.equal(singlesMatch.type, "singles_league");
    response = await matchPostJson(`/api/matches/${singlesMatch.id}/start`, firstUserCookie, {});
    assert.equal(response.status, 200);
    await matchPutJson(`/api/matches/${singlesMatch.id}/frames/1/players`, firstUserCookie, { side: 1, players: [firstUserId] }).then(async (item) => assert.equal(item.status, 200, await item.clone().text()));
    await matchPutJson(`/api/matches/${singlesMatch.id}/frames/1/players`, firstUserCookie, { side: 2, players: [secondProfile.userId] }).then(async (item) => assert.equal(item.status, 200, await item.clone().text()));
    response = await matchPutJson(`/api/matches/${singlesMatch.id}/frames/1/result`, firstUserCookie, { outcome: "played", winnerSide: 1 });
    assert.equal(response.status, 200, await response.clone().text());
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
    response = await matchPostJson(`/api/matches/${singlesMatch.id}/finalize`, firstUserCookie, {});
    assert.equal(response.status, 200, await response.clone().text());
    const disputeAudit = await fetchFromSite(`/api/matches/${singlesMatch.id}/audit`, { headers: { cookie: firstUserCookie } });
    const disputeActions = (await disputeAudit.json()).events.map((event) => event.action_type);
    assert.ok(disputeActions.includes("dispute_raised"));
    assert.ok(disputeActions.includes("dispute_resolved"));

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
    assert.equal(response.status, 200, "Money Match start requires both players and the appointed admin's manual acknowledgements.");

    response = await matchPostJson("/api/matches", firstUserCookie, {
      type: "practice", participants: [{ userId: firstUserId, side: 1 }, { userId: secondProfile.userId, side: 2 }],
      frames: [{ type: "singles" }], formatName: "Friendly singles practice"
    });
    assert.equal(response.status, 201, await response.clone().text());
    const practiceMatch = (await response.json()).match;
    assert.equal(practiceMatch.type, "practice");
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

    const unrelatedMatchResponse = await fetchFromSite("/api/matches", { headers: { cookie: thirdUserCookie } });
    assert.equal(unrelatedMatchResponse.status, 200, await unrelatedMatchResponse.clone().text());
    const unrelatedMatchIds = (await unrelatedMatchResponse.json()).matches.map((item) => item.id);
    assert.equal([practiceMatch.id, moneyMatch.id].some((id) => unrelatedMatchIds.includes(id)), false,
      "A signed-in nonparticipant cannot list another user's private matches.");

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
    await shutDown();
    await closeAuthDatabase();
  }
});
