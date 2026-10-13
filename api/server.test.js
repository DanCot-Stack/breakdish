import test from "node:test";
import assert from "node:assert/strict";

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
      return [{ id: leagueId, userId }];
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

    const authPayload = JSON.stringify({ email: "player@example.com", password: "correct-horse-battery-staple" });
    response = await fetch(`${endpoint}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { origin: "http://localhost:5500", "content-type": "application/json" },
      body: authPayload
    });
    assert.equal(response.status, 200);
    assert.equal(receivedAuthBody, authPayload, "The size guard should preserve the body Better Auth receives.");

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
