import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PlatformRoleError } from "./platform-role-store.js";

test("login page sends the checked state of Remember me as a boolean", async () => {
  const loginHtml = await readFile(new URL("../login.html", import.meta.url), "utf8");
  const frontendScript = await readFile(new URL("../script.js", import.meta.url), "utf8");

  assert.match(loginHtml, /<label class="remember-me-label" for="login-remember-me">[\s\S]*?<input id="login-remember-me" name="rememberMe" type="checkbox" checked>[\s\S]*?<span>Remember me<\/span>/);
  assert.match(frontendScript, /rememberMe:\s*form\.elements\.namedItem\("rememberMe"\)\?\.checked === true/,
    "Checked maps to true and unchecked maps to false for Better Auth.");
  assert.match(frontendScript, /body:\s*JSON\.stringify\(payload\)/);
  assert.doesNotMatch(frontendScript, /\b(?:localStorage|sessionStorage)\b/,
    "The frontend must not persist passwords or session credentials in browser storage.");
});

test("match API keeps public reads available and requires an authenticated user for scoreboard mutations", async () => {
  process.env.ALLOWED_ORIGINS = "http://localhost:5500";
  const { createApp } = await import("./server.js");
  const calls = [];
  const match = { id: "123e4567-e89b-42d3-a456-426614174000", type: "team_league", status: "scheduled" };
  const liveMatch = { ...match, status: "in_progress", startedAt: "2026-10-16T10:00:00.000Z", currentFrame: { number: 1 } };
  const store = {
    async listMatches(filters, viewerId, options) {
      calls.push(["list", filters, viewerId, options]);
      return filters.status === "in_progress" ? [liveMatch] : [match];
    },
    async createMatch(actorId, details) { calls.push(["create", actorId, details]); return { match }; },
    async getMatch(id, viewerId) { calls.push(["get", id, viewerId]); return { match, frames: [], confirmations: [], disputes: [] }; },
    async startMatch(id, actorId) { calls.push(["start", id, actorId]); return { match }; }
  };
  const auth = { api: { async getSession({ headers }) {
    return headers.get("x-test-session") === "player-1" ? { user: { id: "player-1" } } : null;
  } } };
  const app = createApp({ getAuthInstance: async () => auth, getMatchStore: async () => store });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, options = {}) => fetch(`${base}${path}`, {
    ...options,
    headers: { origin: "http://localhost:5500", ...(options.headers || {}) }
  });
  try {
    let response = await request("/api/matches?type=team_league");
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).matches, [match]);
    assert.deepEqual(calls[0], ["list", { type: "team_league" }, null, undefined]);

    response = await request("/api/matches/live");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control"), /no-store/i);
    const livePayload = await response.json();
    assert.deepEqual(livePayload.matches, [liveMatch]);
    assert.ok(Number.isFinite(Date.parse(livePayload.serverTime)), "Live responses include a server clock for consistent elapsed timers.");
    assert.deepEqual(calls.at(-1), ["list", { status: "in_progress" }, null, { includeCurrentFrame: true, unlimited: true }]);

    response = await request("/api/matches/live", { headers: { "x-test-session": "player-1" } });
    assert.equal(response.status, 200);
    assert.equal(calls.at(-1)[2], "player-1", "Authenticated live listing preserves the existing private-match visibility rules.");

    response = await request(`/api/matches/${match.id}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control"), /no-store/i);
    assert.ok(Number.isFinite(Date.parse((await response.json()).serverTime)));

    response = await request("/api/matches", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "practice" })
    });
    assert.equal(response.status, 401);
    assert.equal(calls.some(([method]) => method === "create"), false);

    response = await request("/api/matches", {
      method: "POST", headers: { "content-type": "application/json", "x-test-session": "player-1" }, body: JSON.stringify({ type: "practice" })
    });
    assert.equal(response.status, 201);
    assert.equal(calls.at(-1)[1], "player-1");

    response = await request("/api/matches/not-a-uuid");
    assert.equal(response.status, 400);
    response = await request(`/api/matches/${match.id}/start`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(response.status, 401);
    response = await request(`/api/matches/${match.id}/start`, {
      method: "POST", headers: { "content-type": "application/json", "x-test-session": "player-1" }, body: "{}"
    });
    assert.equal(response.status, 200);
    assert.equal(calls.at(-1)[2], "player-1");
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Match Centre shows finalization only when the server grants the viewer permission", async () => {
  const matchScript = await readFile(new URL("../match.js", import.meta.url), "utf8");
  const matchStoreScript = await readFile(new URL("./match-store.js", import.meta.url), "utf8");
  assert.match(matchScript, /signedIn\s*&&\s*result\.permissions\?\.canFinalize\s*===\s*true\s*&&\s*confirmed\.length\s*===\s*2/,
    "The finalization control requires both server authorization and two confirmed sides.");
  assert.match(matchScript, /confirmed\.length\s*&&\s*retractableSides\.length/,
    "Retraction controls are shown only when the API says at least one confirmed side is retractable by this viewer.");
  assert.match(matchScript, /Retract this side's confirmation/,
    "The interface describes confirmation as a side-level action.");
  const operatorStart = matchStoreScript.indexOf("async function canOperateMatch");
  const organizerStart = matchStoreScript.indexOf("async function hasMatchOrganizerPermission", operatorStart);
  assert.ok(operatorStart >= 0 && organizerStart > operatorStart, "Match operator authorization remains a distinct policy.");
  const operatorPolicy = matchStoreScript.slice(operatorStart, organizerStart);
  assert.match(operatorPolicy, /team_registrations/);
  assert.match(operatorPolicy, /match_participants/);
  assert.doesNotMatch(operatorPolicy, /platform_roles|super_admin|platform_admin|referee/i,
    "Platform and referee roles do not grant live scoring permission.");
});

test("historic results API provides the public league to season to final-results routes", async () => {
  process.env.ALLOWED_ORIGINS = "http://localhost:5500";
  const { createApp } = await import("./server.js");
  const calls = [];
  const leagueId = "123e4567-e89b-42d3-a456-426614174000";
  const seasonId = "123e4567-e89b-42d3-a456-426614174001";
  const store = {
    async listHistoricResultLeagues() {
      calls.push(["leagues"]);
      return [{ id: leagueId, name: "North Division", seasonCount: 1, resultCount: 4 }];
    },
    async listHistoricResultSeasons(id) {
      calls.push(["seasons", id]);
      return [{ id: seasonId, name: "2025 Season", resultCount: 4 }];
    },
    async listMatches(filters, viewerId, options) {
      calls.push(["matches", filters, viewerId, options]);
      return [{ id: "result-1", status: "completed", homeScore: 5, awayScore: 3 }];
    }
  };
  const app = createApp({ getMatchStore: async () => store });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path) => fetch(`${base}${path}`, { headers: { origin: "http://localhost:5500" } });
  try {
    let response = await request("/api/historic-results");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control"), /no-store/i);
    assert.equal((await response.json()).leagues[0].resultCount, 4);

    response = await request(`/api/historic-results/${leagueId}/seasons`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).seasons[0].id, seasonId);
    assert.deepEqual(calls.at(-1), ["seasons", leagueId]);

    response = await request(`/api/historic-results/${leagueId}/seasons/${seasonId}/matches`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).matches[0].status, "completed");
    assert.deepEqual(calls.at(-1), ["matches", { leagueId, seasonId }, null, { historicResults: true, unlimited: true }]);

    response = await request("/api/historic-results/not-a-uuid/seasons");
    assert.equal(response.status, 400);
    response = await request(`/api/historic-results/${leagueId}/seasons/not-a-uuid/matches`);
    assert.equal(response.status, 400);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("platform role management routes require a Super Admin and expose no Super Admin grant endpoint", async () => {
  process.env.ALLOWED_ORIGINS = "http://localhost:5500";
  const { createApp } = await import("./server.js");
  const calls = [];
  const store = {
    async listActivePlatformAdmins(actorId) {
      calls.push(["admins", actorId]);
      if (actorId !== "super-admin") throw new PlatformRoleError(403, "Super Admin required.");
      return [{ userId: "platform-admin", role: "platform_admin" }];
    },
    async listRoleHistory(actorId, limit) {
      calls.push(["history", actorId, limit]);
      if (actorId !== "super-admin") throw new PlatformRoleError(403, "Super Admin required.");
      return [{ action: "grant", role: "platform_admin" }];
    },
    async grantPlatformAdmin(actorId, userId, reason) {
      calls.push(["grant", actorId, userId, reason]);
      if (actorId !== "super-admin") throw new PlatformRoleError(403, "Super Admin required.");
      return { assignment: { userId, role: "platform_admin" }, repeated: false };
    },
    async revokePlatformAdmin(actorId, userId, reason) {
      calls.push(["revoke", actorId, userId, reason]);
      if (actorId !== "super-admin") throw new PlatformRoleError(403, "Super Admin required.");
      return { revoked: true, userId };
    }
  };
  const auth = { api: { async getSession({ headers }) {
    const userId = headers.get("x-test-session");
    return userId ? { user: { id: userId } } : null;
  } } };
  const app = createApp({ getAuthInstance: async () => auth, getPlatformRoleStore: async () => store });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, options = {}, actor = "") => fetch(`${base}${path}`, {
    ...options,
    headers: {
      origin: "http://localhost:5500",
      ...(actor ? { "x-test-session": actor } : {}),
      ...(options.headers || {})
    }
  });
  try {
    let response = await request("/api/platform/roles/admins");
    assert.equal(response.status, 401);
    response = await request("/api/platform/roles/history", {}, "platform-admin");
    assert.equal(response.status, 403);
    response = await request("/api/platform/roles/admins", {}, "platform-admin");
    assert.equal(response.status, 403);
    response = await request("/api/platform/roles/admins/target", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: "Not permitted" })
    }, "platform-admin");
    assert.equal(response.status, 403);
    response = await request("/api/platform/roles/admins/target", { method: "DELETE" }, "platform-admin");
    assert.equal(response.status, 403);

    response = await request("/api/platform/roles/admins", {}, "super-admin");
    assert.equal(response.status, 200);
    assert.equal((await response.json()).admins[0].role, "platform_admin");
    response = await request("/api/platform/roles/history?limit=10", {}, "super-admin");
    assert.equal(response.status, 200);
    assert.equal((await response.json()).events[0].action, "grant");
    response = await request("/api/platform/roles/history?limit=201", {}, "super-admin");
    assert.equal(response.status, 400);
    response = await request("/api/platform/roles/admins/target", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: "Approved" })
    }, "super-admin");
    assert.equal(response.status, 201);
    assert.deepEqual(calls.filter(([kind]) => kind === "grant").at(-1), ["grant", "super-admin", "target", "Approved"]);
    response = await request("/api/platform/roles/admins/target", {
      method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: "Ended" })
    }, "super-admin");
    assert.equal(response.status, 200);

    response = await request("/api/platform/roles/super-admins/target", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}"
    }, "super-admin");
    assert.equal(response.status, 404, "No HTTP endpoint can grant Super Admin.");
    assert.equal(calls.some(([kind]) => kind === "superAdminGrant"), false);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

const sentEmails = [];
const providerResponses = [];
const emailSender = {
  async sendContactEmail(email) {
    sentEmails.push(email);
    const result = providerResponses.shift();
    if (result instanceof Error) throw result;
    if (result === false) throw new Error("private provider response");
  }
};

test("contact API emails accepted submissions and safely handles failures, abuse and validation", async () => {
  process.env.ALLOWED_ORIGINS = "http://localhost:5500";
  process.env.PORT = "0";
  const { start, shutDown } = await import("./server.js");
  let authHandlerCalls = 0;
  let receivedAuthBody;
  const fakeAuth = {
    handler: async (request) => {
      authHandlerCalls++;
      receivedAuthBody = await request.text();
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    },
    api: { getSession: async () => fakeAuthSession }
  };
  let fakeAuthSession = null;
  let profileStoreCalls = 0;
  const leagueCalls = [];
  const leagueId = "123e4567-e89b-42d3-a456-426614174000";
  const profiles = new Map();
  const fakeProfileStore = {
    async getOrCreate(userId, accountName) {
      profileStoreCalls++;
      if (!profiles.has(userId)) profiles.set(userId, { userId, displayName: accountName, location: null, biography: null });
      return profiles.get(userId);
    },
    async update(userId, profile) {
      profileStoreCalls++;
      const updated = { userId, ...profile };
      profiles.set(userId, updated);
      return updated;
    }
  };
  const { LeagueStoreError } = await import("./league-store.js");
  const competitionCalls = [];
  const fakeCompetitionStore = {
    async getCompetition(id, viewerId) {
      competitionCalls.push(["getCompetition", id, viewerId]);
      return { league: { id, name: "Test League" }, viewerRole: viewerId === "player-1" ? "owner" : null, seasons: [] };
    },
    async createSeason(id, actorId, details) {
      if (actorId !== "player-1") throw new LeagueStoreError(403, "Only league managers can create seasons.");
      competitionCalls.push(["createSeason", id, actorId, details]);
      return { id: "season-1", leagueId: id, ...details, status: "draft" };
    },
    async updateSeason(id, actorId, details) {
      if (actorId !== "player-1") throw new LeagueStoreError(403, "Only league managers can update seasons.");
      competitionCalls.push(["updateSeason", id, actorId, details]);
      return { id, ...details };
    },
    async createDivision(id, actorId, name) {
      if (actorId !== "player-1") throw new LeagueStoreError(403, "Only league managers can create divisions.");
      competitionCalls.push(["createDivision", id, actorId, name]);
      return { id: "division-1", season_id: id, name };
    },
    async updateDivision(id, actorId, name) {
      if (actorId !== "player-1") throw new LeagueStoreError(403, "Only league managers can update divisions.");
      competitionCalls.push(["updateDivision", id, actorId, name]);
      return { id, name };
    },
    async createTeam(id, actorId, details) {
      if (actorId !== "player-1") throw new LeagueStoreError(403, "Only league managers can create teams.");
      competitionCalls.push(["createTeam", id, actorId, details]);
      return { id: "team-1", seasonId: id, ...details };
    },
    async updateTeam(id, actorId, details) {
      if (actorId !== "player-1") throw new LeagueStoreError(403, "Only league managers can update teams.");
      competitionCalls.push(["updateTeam", id, actorId, details]);
      return { id, ...details };
    },
    async eligiblePlayers(id, actorId) {
      if (actorId !== "player-1") throw new LeagueStoreError(403, "Only team captains or league managers can view eligible players.");
      competitionCalls.push(["eligiblePlayers", id, actorId]);
      return [];
    },
    async addTeamMember(id, actorId, userId) {
      if (actorId !== "player-1") throw new LeagueStoreError(403, "Only team captains or league managers can change rosters.");
      competitionCalls.push(["addTeamMember", id, actorId, userId]);
      return { membership: { teamId: id, userId, status: "active" }, repeated: false };
    },
    async removeTeamMember(id, actorId, userId) {
      if (actorId !== "player-1") throw new LeagueStoreError(403, "Only team captains or league managers can change rosters.");
      competitionCalls.push(["removeTeamMember", id, actorId, userId]);
      return { teamId: id, userId, status: "left" };
    },
    async assignCaptain(id, actorId, userId) {
      if (actorId !== "player-1") throw new LeagueStoreError(403, "Only league managers can assign captains.");
      competitionCalls.push(["assignCaptain", id, actorId, userId]);
      return { teamId: id, userId, role: "captain" };
    },
    async removeCaptain(id, actorId) {
      if (actorId !== "player-1") throw new LeagueStoreError(403, "Only league managers can remove captains.");
      competitionCalls.push(["removeCaptain", id, actorId]);
      return { teamId: id, role: "player" };
    }
  };
  const fakeLeagueStore = {
    async listPublic(viewerId) {
      leagueCalls.push(["listPublic", viewerId]);
      return [];
    },
    async getPublicById() {
      return { id: leagueId, name: "Test League" };
    },
    async listMine(userId) {
      leagueCalls.push(["listMine", userId]);
      if (userId === "ordinary-member") return [{ id: leagueId, viewerMembership: { role: "member", status: "active" }, viewerIsPlayer: false }];
      if (userId === "participating-admin") return [{ id: leagueId, viewerMembership: { role: "administrator", status: "active" }, viewerIsPlayer: true }];
      return [];
    },
    async listManaged(userId) {
      leagueCalls.push(["listManaged", userId]);
      if (userId === "league-owner") return [{ id: leagueId, viewerMembership: { role: "owner", status: "active" } }];
      if (userId === "league-admin" || userId === "participating-admin") return [{ id: leagueId, viewerMembership: { role: "administrator", status: "active" } }];
      return [];
    },
    async create(userId, details) {
      leagueCalls.push(["create", userId, details]);
      return { league: { id: leagueId, name: details.name }, membership: { userId, role: "owner", status: "active" } };
    },
    async join(id, userId) {
      leagueCalls.push(["join", id, userId]);
      return { membership: { leagueId: id, userId, role: "member", status: "pending" }, repeated: false };
    },
    async listPending(_id, actorId) {
      if (actorId !== "league-owner") throw new LeagueStoreError(403, "Only managers can view requests.");
      return [];
    },
    async listMembers(_id, actorId) {
      if (actorId !== "league-owner") throw new LeagueStoreError(403, "Only managers can view members.");
      return [];
    },
    async reviewRequest(_id, actorId) {
      if (actorId !== "league-owner") throw new LeagueStoreError(403, "Only managers can review requests.");
      return {};
    },
    async setMemberRole(_id, actorId) {
      if (actorId !== "league-owner") throw new LeagueStoreError(403, "Only the owner can manage roles.");
      return {};
    }
  };
  const server = await start({
    emailSender,
    getAuthInstance: async () => fakeAuth,
    getProfileStore: async () => fakeProfileStore,
    getLeagueStore: async () => fakeLeagueStore,
    getCompetitionStore: async () => fakeCompetitionStore
  });
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const send = (body, origin = "http://localhost:5500", ip = "198.51.100.1") => fetch(`${endpoint}/api/contact`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, "x-forwarded-for": ip },
    body: JSON.stringify(body)
  });

  try {
    let response = await fetch(`${endpoint}/healthz`, { headers: { origin: "http://localhost:5500" } });
    assert.equal(response.status, 200);

    response = await fetch(`${endpoint}/api/auth/get-session`, { headers: { origin: "http://localhost:5500" } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-credentials"), "true");

    const authPayload = JSON.stringify({ email: "player@example.com", password: "correct-horse-battery-staple", rememberMe: true });
    response = await fetch(`${endpoint}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { origin: "http://localhost:5500", "content-type": "application/json" },
      body: authPayload
    });
    assert.equal(response.status, 200);
    assert.equal(receivedAuthBody, authPayload, "The size guard should preserve the body Better Auth receives.");

    const noRememberPayload = JSON.stringify({ email: "player@example.com", password: "correct-horse-battery-staple", rememberMe: false });
    response = await fetch(`${endpoint}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { origin: "http://localhost:5500", "content-type": "application/json" },
      body: noRememberPayload
    });
    assert.equal(response.status, 200);
    assert.equal(receivedAuthBody, noRememberPayload, "The API must forward Remember me unchecked unchanged to Better Auth.");

    const authCallsBeforeOversizedBodies = authHandlerCalls;
    response = await fetch(`${endpoint}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { origin: "http://localhost:5500", "content-type": "application/json" },
      body: JSON.stringify({ payload: "x".repeat(13 * 1024) })
    });
    assert.equal(response.status, 413, "Oversized requests with Content-Length should be rejected.");

    response = await fetch(`${endpoint}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { origin: "http://localhost:5500", "content-type": "application/json" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ payload: "x".repeat(13 * 1024) })));
          controller.close();
        }
      }),
      duplex: "half"
    });
    assert.equal(response.status, 413, "Oversized chunked requests should be rejected by actual byte count.");
    assert.equal(authHandlerCalls, authCallsBeforeOversizedBodies, "Oversized requests must not reach Better Auth.");

    response = await fetch(`${endpoint}/api/me`, { headers: { origin: "http://localhost:5500" } });
    assert.equal(response.status, 401);

    response = await fetch(`${endpoint}/api/leagues`, { headers: { origin: "http://localhost:5500" } });
    assert.equal(response.status, 200, "The public league directory should be available without a session.");
    assert.deepEqual(leagueCalls.at(-1), ["listPublic", null]);
    response = await fetch(`${endpoint}/api/leagues/not-a-uuid`, { headers: { origin: "http://localhost:5500" } });
    assert.equal(response.status, 400);
    response = await fetch(`${endpoint}/api/leagues`, {
      method: "POST",
      headers: { origin: "http://localhost:5500", "content-type": "application/json" },
      body: JSON.stringify({ name: "Unauthorised League" })
    });
    assert.equal(response.status, 401, "Anonymous users must not create leagues.");

    fakeAuthSession = {
      user: { id: "player-1", name: "Test Player", email: "player@example.com", emailVerified: true, image: null },
      session: { token: "must-not-leak", expiresAt: "2030-01-01T00:00:00.000Z" }
    };
    response = await fetch(`${endpoint}/api/me`, { headers: { origin: "http://localhost:5500" } });
    assert.equal(response.status, 200);
    const currentUser = await response.json();
    assert.equal(currentUser.user.email, "player@example.com");
    assert.equal(currentUser.session.expiresAt, "2030-01-01T00:00:00.000Z");
    assert.doesNotMatch(JSON.stringify(currentUser), /must-not-leak/);

    response = await fetch(`${endpoint}/api/leagues`, {
      method: "POST",
      headers: { origin: "http://localhost:5500", "content-type": "application/json" },
      body: JSON.stringify({
        name: "  Tuesday League  ",
        description: " Pool night ",
        location: " Leeds ",
        joinPolicy: "approval",
        createdBy: "another-user",
        slug: "attacker-chosen-slug",
        status: "active"
      })
    });
    assert.equal(response.status, 201);
    const createdLeague = await response.json();
    assert.equal(createdLeague.membership.userId, "player-1");
    assert.equal(createdLeague.membership.role, "owner");
    assert.deepEqual(leagueCalls.at(-1), ["create", "player-1", {
      name: "Tuesday League", description: "Pool night", location: "Leeds", joinPolicy: "approval"
    }], "The API must ignore client-supplied creator, slug and status values.");

    response = await fetch(`${endpoint}/api/leagues`, {
      method: "POST",
      headers: { origin: "http://localhost:5500", "content-type": "application/json" },
      body: JSON.stringify({ name: "Valid Name", joinPolicy: "owner" })
    });
    assert.equal(response.status, 400, "Unsupported membership policies must be rejected.");

    response = await fetch(`${endpoint}/api/leagues/${leagueId}/join`, {
      method: "POST",
      headers: { origin: "http://localhost:5500", "content-type": "application/json" },
      body: "{}"
    });
    assert.equal(response.status, 201);
    assert.deepEqual(leagueCalls.at(-1), ["join", leagueId, "player-1"]);

    response = await fetch(`${endpoint}/api/me/leagues`, { headers: { origin: "http://localhost:5500" } });
    assert.equal(response.status, 200);
    const sessionBeforeLeagueViews = fakeAuthSession;
    fakeAuthSession = null;
    response = await fetch(`${endpoint}/api/me/leagues`, { headers: { origin: "http://localhost:5500" } });
    assert.equal(response.status, 401, "My Leagues must require a server-validated session.");
    response = await fetch(`${endpoint}/api/me/managed-leagues`, { headers: { origin: "http://localhost:5500" } });
    assert.equal(response.status, 401, "The Admin Control Centre API must require a server-validated session.");

    fakeAuthSession = { user: { id: "ordinary-member" }, session: {} };
    response = await fetch(`${endpoint}/api/me/leagues`, { headers: { origin: "http://localhost:5500" } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).leagues[0].viewerMembership.role, "member");
    response = await fetch(`${endpoint}/api/me/managed-leagues?userId=league-owner`, { headers: { origin: "http://localhost:5500" } });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).leagues, [], "An ordinary member must not receive another user's managed leagues.");
    assert.deepEqual(leagueCalls.at(-1), ["listManaged", "ordinary-member"], "The API derives identity from the authenticated session, not the request query.");

    fakeAuthSession = { user: { id: "league-admin" }, session: {} };
    response = await fetch(`${endpoint}/api/me/managed-leagues`, { headers: { origin: "http://localhost:5500" } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).leagues[0].viewerMembership.role, "administrator");

    fakeAuthSession = { user: { id: "league-owner" }, session: {} };
    response = await fetch(`${endpoint}/api/me/managed-leagues`, { headers: { origin: "http://localhost:5500" } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).leagues[0].viewerMembership.role, "owner", "The owner role must remain visibly distinct from Administrator.");

    fakeAuthSession = { user: { id: "participating-admin" }, session: {} };
    response = await fetch(`${endpoint}/api/me/leagues`, { headers: { origin: "http://localhost:5500" } });
    const overlapMembership = (await response.json()).leagues[0];
    assert.equal(overlapMembership.viewerIsPlayer, true);
    assert.equal(overlapMembership.viewerMembership.role, "administrator");
    response = await fetch(`${endpoint}/api/me/managed-leagues`, { headers: { origin: "http://localhost:5500" } });
    assert.equal((await response.json()).leagues[0].viewerMembership.role, "administrator",
      "A participating administrator can appear in both user contexts.");
    fakeAuthSession = sessionBeforeLeagueViews;

    response = await fetch(`${endpoint}/api/leagues/${leagueId}/requests`, { headers: { origin: "http://localhost:5500" } });
    assert.equal(response.status, 403, "A member must not view private join requests.");
    response = await fetch(`${endpoint}/api/leagues/${leagueId}/requests/other-user`, {
      method: "POST",
      headers: { origin: "http://localhost:5500", "content-type": "application/json" },
      body: JSON.stringify({ action: "approve" })
    });
    assert.equal(response.status, 403, "A member must not approve another player's request.");
    response = await fetch(`${endpoint}/api/leagues/${leagueId}/members/other-user/role`, {
      method: "PATCH",
      headers: { origin: "http://localhost:5500", "content-type": "application/json" },
      body: JSON.stringify({ role: "administrator" })
    });
    assert.equal(response.status, 403, "A member must not promote themselves or another player.");

    fakeAuthSession = null;
    response = await fetch(`${endpoint}/api/leagues/${leagueId}/competition`, { headers: { origin: "http://localhost:5500" } });
    assert.equal(response.status, 200, "Public league competition structure can be viewed without signing in.");
    assert.deepEqual(competitionCalls.at(-1), ["getCompetition", leagueId, null]);
    response = await fetch(`${endpoint}/api/leagues/${leagueId}/seasons`, {
      method: "POST", headers: { origin: "http://localhost:5500", "content-type": "application/json" },
      body: JSON.stringify({ name: "Anonymous season" })
    });
    assert.equal(response.status, 401, "Season creation requires a signed-in league manager.");

    fakeAuthSession = {
      user: { id: "league-member", name: "League Member", email: "member@example.com", emailVerified: true, image: null },
      session: { token: "member-token", expiresAt: "2030-01-01T00:00:00.000Z" }
    };
    response = await fetch(`${endpoint}/api/leagues/${leagueId}/seasons`, {
      method: "POST", headers: { origin: "http://localhost:5500", "content-type": "application/json" },
      body: JSON.stringify({ name: "Member Season" })
    });
    assert.equal(response.status, 403, "A regular league member cannot create a season.");

    fakeAuthSession = {
      user: { id: "player-1", name: "Test Player", email: "player@example.com", emailVerified: true, image: null },
      session: { token: "must-not-leak", expiresAt: "2030-01-01T00:00:00.000Z" }
    };
    response = await fetch(`${endpoint}/api/leagues/${leagueId}/seasons`, {
      method: "POST", headers: { origin: "http://localhost:5500", "content-type": "application/json" },
      body: JSON.stringify({ name: "Invalid Date Season", startsOn: "2026-02-30" })
    });
    assert.equal(response.status, 400, "Invalid calendar dates must be rejected before reaching the store.");
    response = await fetch(`${endpoint}/api/leagues/${leagueId}/seasons`, {
      method: "POST", headers: { origin: "http://localhost:5500", "content-type": "application/json" },
      body: JSON.stringify({ name: "2026 Season", startsOn: "2026-01-01", endsOn: "2025-12-31" })
    });
    assert.equal(response.status, 400, "Season date ranges must be ordered.");
    response = await fetch(`${endpoint}/api/leagues/${leagueId}/seasons`, {
      method: "POST", headers: { origin: "http://localhost:5500", "content-type": "application/json" },
      body: JSON.stringify({ name: "  2026 Season  ", startsOn: "2026-01-01", endsOn: "2026-12-31" })
    });
    assert.equal(response.status, 201);
    assert.deepEqual(competitionCalls.at(-1), ["createSeason", leagueId, "player-1", {
      name: "2026 Season", startsOn: "2026-01-01", endsOn: "2026-12-31"
    }]);
    response = await fetch(`${endpoint}/api/seasons/123e4567-e89b-42d3-a456-426614174000`, {
      method: "PATCH", headers: { origin: "http://localhost:5500", "content-type": "application/json" },
      body: JSON.stringify({ status: "archived" })
    });
    assert.equal(response.status, 400, "Season statuses outside the supported lifecycle must fail validation.");
    response = await fetch(`${endpoint}/api/seasons/123e4567-e89b-42d3-a456-426614174000/divisions`, {
      method: "POST", headers: { origin: "http://localhost:5500", "content-type": "application/json" },
      body: JSON.stringify({ name: "Premier" })
    });
    assert.equal(response.status, 201);
    response = await fetch(`${endpoint}/api/seasons/123e4567-e89b-42d3-a456-426614174000/teams`, {
      method: "POST", headers: { origin: "http://localhost:5500", "content-type": "application/json" },
      body: JSON.stringify({ name: "Team A", divisionId: "not-a-uuid" })
    });
    assert.equal(response.status, 400, "Invalid division associations must fail validation.");
    response = await fetch(`${endpoint}/api/teams/${leagueId}/captain`, {
      method: "PUT", headers: { origin: "http://localhost:5500", "content-type": "application/json" }, body: "{}"
    });
    assert.equal(response.status, 400, "Captain assignments require a registered player ID.");

    fakeAuthSession = null;
    const callsBeforeAnonymousProfile = profileStoreCalls;
    response = await fetch(`${endpoint}/api/me/profile`, { headers: { origin: "http://localhost:5500" } });
    assert.equal(response.status, 401);
    response = await fetch(`${endpoint}/api/me/profile`, {
      method: "PUT",
      headers: { origin: "http://localhost:5500", "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Unauthorised" })
    });
    assert.equal(response.status, 401);
    assert.equal(profileStoreCalls, callsBeforeAnonymousProfile, "Unauthenticated users must not access the profile store.");

    fakeAuthSession = {
      user: { id: "player-1", name: "Test Player", email: "player@example.com", emailVerified: true, image: null },
      session: { token: "must-not-leak", expiresAt: "2030-01-01T00:00:00.000Z" }
    };
    response = await fetch(`${endpoint}/api/me/profile`, { headers: { origin: "http://localhost:5500" } });
    assert.equal(response.status, 200);
    let profileBody = await response.json();
    assert.equal(profileBody.profile.userId, "player-1");
    assert.equal(profileBody.profile.displayName, "Test Player");

    response = await fetch(`${endpoint}/api/me/profile`, {
      method: "PUT",
      headers: { origin: "http://localhost:5500", "content-type": "application/json" },
      body: JSON.stringify({ userId: "somebody-else", displayName: "  Alex Player  ", location: " Leeds ", biography: " Loves pool. " })
    });
    assert.equal(response.status, 200);
    profileBody = await response.json();
    assert.equal(profileBody.profile.userId, "player-1", "The profile owner must come from the authenticated session.");
    assert.equal(profileBody.profile.displayName, "Alex Player");
    assert.equal(profileBody.profile.location, "Leeds");
    assert.equal(profileBody.profile.biography, "Loves pool.");

    response = await fetch(`${endpoint}/api/me/profile`, {
      method: "PUT",
      headers: { origin: "http://localhost:5500", "content-type": "application/json" },
      body: JSON.stringify({ displayName: "   " })
    });
    assert.equal(response.status, 400);
    response = await fetch(`${endpoint}/api/me/profile`, {
      method: "PUT",
      headers: { origin: "http://localhost:5500", "content-type": "application/json" },
      body: JSON.stringify({ displayName: "x".repeat(81) })
    });
    assert.equal(response.status, 400);
    response = await fetch(`${endpoint}/api/me/profile`, {
      method: "PUT",
      headers: { origin: "http://localhost:5500", "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Valid Name", location: "x".repeat(121) })
    });
    assert.equal(response.status, 400);
    response = await fetch(`${endpoint}/api/me/profile`, {
      method: "PUT",
      headers: { origin: "http://localhost:5500", "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Valid Name", biography: "x".repeat(501) })
    });
    assert.equal(response.status, 400);
    for (let attempt = 0; attempt < 22; attempt++) {
      response = await fetch(`${endpoint}/api/me/profile`, { headers: { origin: "http://localhost:5500" } });
      assert.equal(response.status, 200);
    }
    response = await fetch(`${endpoint}/api/me/profile`, { headers: { origin: "http://localhost:5500" } });
    assert.equal(response.status, 429, "Profile endpoints should apply the configured per-connection rate limit.");
    fakeAuthSession = null;

    response = await fetch(`${endpoint}/api/contact`, {
      method: "OPTIONS",
      headers: { origin: "http://localhost:5500", "access-control-request-method": "POST" }
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:5500");

    const enquiry = {
      name: "Alex Player",
      email: "alex@example.com",
      subject: "League or competition",
      message: "Please send me the league details."
    };
    response = await send(enquiry, undefined, "198.51.100.1");
    assert.equal(response.status, 202);
    assert.deepEqual(sentEmails[0], enquiry);

    providerResponses.push(false);
    response = await send(enquiry, undefined, "198.51.100.2");
    assert.equal(response.status, 503);
    let errorBody = await response.text();
    assert.match(errorBody, /temporarily unavailable/i);
    assert.doesNotMatch(errorBody, /private provider response/);

    response = await send({ ...enquiry, email: "not-an-email" }, undefined, "198.51.100.4");
    assert.equal(response.status, 400);
    response = await send({ ...enquiry, subject: "Other" }, undefined, "198.51.100.5");
    assert.equal(response.status, 400);
    response = await send({ ...enquiry, message: " " }, undefined, "198.51.100.6");
    assert.equal(response.status, 400);
    response = await send({ website: "filled by bot" }, undefined, "198.51.100.7");
    assert.equal(response.status, 202);
    assert.equal(sentEmails.length, 2);

    for (let attempt = 0; attempt < 5; attempt++) {
      response = await send(enquiry, undefined, "198.51.100.99");
      assert.equal(response.status, 202);
    }
    response = await send(enquiry, undefined, "198.51.100.99");
    assert.equal(response.status, 429);
    response = await send(enquiry, "https://untrusted.example");
    assert.equal(response.status, 403);

    response = await send({ ...enquiry, message: "x".repeat(13_000) });
    assert.equal(response.status, 413);
  } finally {
    await shutDown();
  }
});
