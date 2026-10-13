import "dotenv/config";
import { pathToFileURL } from "node:url";
import express from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import { createLeagueStore, LeagueStoreError } from "./league-store.js";
import { createCompetitionStore } from "./competition-store.js";
import { createEmailSender } from "./mailer.js";
import { createProfileStore } from "./profile-store.js";
import { validateSubmission } from "./validation.js";

const configuredPort = Number(process.env.PORT);
const port = Number.isInteger(configuredPort) && configuredPort >= 0 ? configuredPort : 3001;
const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS || "http://localhost:5500,http://127.0.0.1:5500")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
);

let server;
let emailSender;
let authModulePromise;
let profileStorePromise;
let leagueStorePromise;
let competitionStorePromise;

async function getConfiguredAuth() {
  authModulePromise ??= import("./auth.js");
  return (await authModulePromise).auth;
}

async function getConfiguredProfileStore() {
  profileStorePromise ??= import("./auth.js").then(({ database }) => createProfileStore(database));
  return profileStorePromise;
}

async function getConfiguredLeagueStore() {
  leagueStorePromise ??= import("./auth.js").then(({ database }) => createLeagueStore(database));
  return leagueStorePromise;
}

async function getConfiguredCompetitionStore() {
  competitionStorePromise ??= import("./auth.js").then(({ database }) => createCompetitionStore(database));
  return competitionStorePromise;
}

function createConfiguredEmailSender() {
  const hasContactSettings = ["RESEND_API_KEY", "CONTACT_TO_EMAIL", "CONTACT_FROM_EMAIL"]
    .some((key) => typeof process.env[key] === "string" && process.env[key].trim());
  if (!hasContactSettings && process.env.NODE_ENV !== "production") return null;
  return createEmailSender();
}

function createApp({
  getAuthInstance = getConfiguredAuth,
  getProfileStore = getConfiguredProfileStore,
  getLeagueStore = getConfiguredLeagueStore,
  getCompetitionStore = getConfiguredCompetitionStore
} = {}) {
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(helmet());

  app.use((req, res, next) => {
    const origin = req.get("origin");

    if (origin && !allowedOrigins.has(origin)) {
      return res.status(403).json({ error: "This website is not allowed to use the API." });
    }

    if (origin) {
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Access-Control-Allow-Credentials", "true");
      res.vary("Origin");
      res.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      res.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
    }

    if (req.method === "OPTIONS") return res.sendStatus(204);
    return next();
  });

  // Buffer auth request bodies with a strict cap, then restore their text for Better Call.
  // Better Auth's Node adapter supports an already-read req.body and rebuilds the stream.
  app.use("/api/auth", express.raw({ limit: "12kb", type: () => true }), (req, _res, next) => {
    if (Buffer.isBuffer(req.body)) req.body = req.body.toString("utf8");
    next();
  });

  app.all("/api/auth/*splat", async (req, res, next) => {
    try {
      const auth = await getAuthInstance();
      return toNodeHandler(auth)(req, res, next);
    } catch (error) {
      return next(error);
    }
  });

  app.use(express.json({ limit: "12kb", strict: true }));

  const contactLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({ error: "Too many enquiries from this connection. Please try again later." });
    }
  });
  const profileLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({ error: "Too many profile requests. Please wait before trying again." });
    }
  });
  const leagueCreateLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 5,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ error: "Too many league creation attempts. Please try again later." })
  });
  const leagueMutationLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ error: "Too many league requests. Please wait before trying again." })
  });
  const competitionMutationLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 60,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ error: "Too many season or team changes. Please wait before trying again." })
  });

  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  app.get("/api/me", async (req, res, next) => {
    try {
      const auth = await getAuthInstance();
      const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
      if (!session) return res.status(401).json({ error: "Please sign in to continue." });
      return res.json({
        user: {
          id: session.user.id,
          name: session.user.name,
          email: session.user.email,
          emailVerified: session.user.emailVerified,
          image: session.user.image
        },
        session: { expiresAt: session.session.expiresAt }
      });
    } catch (error) {
      return next(error);
    }
  });

  app.get("/api/me/profile", profileLimiter, async (req, res, next) => {
    try {
      const auth = await getAuthInstance();
      const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
      if (!session) return res.status(401).json({ error: "Please sign in to continue." });
      const profiles = await getProfileStore();
      const accountName = typeof session.user.name === "string" && session.user.name.trim()
        ? session.user.name.trim()
        : "Player";
      const profile = await profiles.getOrCreate(session.user.id, accountName);
      return res.json({ profile });
    } catch (error) {
      return next(error);
    }
  });

  app.put("/api/me/profile", profileLimiter, async (req, res, next) => {
    try {
      const auth = await getAuthInstance();
      const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
      if (!session) return res.status(401).json({ error: "Please sign in to continue." });

      const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
      const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
      const location = body.location === undefined || body.location === null ? "" : body.location;
      const biography = body.biography === undefined || body.biography === null ? "" : body.biography;
      if (!displayName || displayName.length > 80) {
        return res.status(400).json({ error: "Display name is required and must be 80 characters or fewer." });
      }
      if (typeof location !== "string" || location.trim().length > 120) {
        return res.status(400).json({ error: "Location must be 120 characters or fewer." });
      }
      if (typeof biography !== "string" || biography.trim().length > 500) {
        return res.status(400).json({ error: "Biography must be 500 characters or fewer." });
      }

      const profiles = await getProfileStore();
      const profile = await profiles.update(session.user.id, {
        displayName,
        location: location.trim() || null,
        biography: biography.trim() || null
      });
      return res.json({ profile });
    } catch (error) {
      return next(error);
    }
  });

  app.get("/api/leagues", async (req, res, next) => {
    try {
      const auth = await getAuthInstance();
      const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
      const leagues = await (await getLeagueStore()).listPublic(session?.user.id || null);
      return res.json({ leagues });
    } catch (error) {
      return next(error);
    }
  });

  app.get("/api/me/leagues", async (req, res, next) => {
    try {
      const auth = await getAuthInstance();
      const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
      if (!session) return res.status(401).json({ error: "Please sign in to continue." });
      const leagues = await (await getLeagueStore()).listMine(session.user.id);
      return res.json({ leagues });
    } catch (error) {
      return next(error);
    }
  });

  app.get("/api/leagues/:leagueId", async (req, res, next) => {
    try {
      if (!isUuid(req.params.leagueId)) return res.status(400).json({ error: "Enter a valid league ID." });
      const auth = await getAuthInstance();
      const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
      const league = await (await getLeagueStore()).getPublicById(req.params.leagueId, session?.user.id || null);
      if (!league) return res.status(404).json({ error: "This public league could not be found." });
      return res.json({ league });
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/leagues", leagueCreateLimiter, async (req, res, next) => {
    try {
      const auth = await getAuthInstance();
      const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
      if (!session) return res.status(401).json({ error: "Sign in to create a league." });
      const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const description = body.description === undefined || body.description === null ? "" : body.description;
      const location = body.location === undefined || body.location === null ? "" : body.location;
      const joinPolicy = body.joinPolicy === undefined ? "approval" : body.joinPolicy;
      if (!name || name.length > 120) {
        return res.status(400).json({ error: "League name is required and must be 120 characters or fewer." });
      }
      if (typeof description !== "string" || description.trim().length > 1000) {
        return res.status(400).json({ error: "Description must be 1,000 characters or fewer." });
      }
      if (typeof location !== "string" || location.trim().length > 160) {
        return res.status(400).json({ error: "Location must be 160 characters or fewer." });
      }
      if (!["open", "approval"].includes(joinPolicy)) {
        return res.status(400).json({ error: "Choose open joining or approval required." });
      }
      const result = await (await getLeagueStore()).create(session.user.id, {
        name,
        description: description.trim() || null,
        location: location.trim() || null,
        joinPolicy
      });
      return res.status(201).json(result);
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/leagues/:leagueId/join", leagueMutationLimiter, async (req, res, next) => {
    try {
      if (!isUuid(req.params.leagueId)) return res.status(400).json({ error: "Enter a valid league ID." });
      const auth = await getAuthInstance();
      const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
      if (!session) return res.status(401).json({ error: "Sign in to join or request to join this league." });
      const result = await (await getLeagueStore()).join(req.params.leagueId, session.user.id);
      return res.status(result.repeated ? 200 : 201).json(result);
    } catch (error) {
      return next(error);
    }
  });

  app.get("/api/leagues/:leagueId/requests", async (req, res, next) => {
    try {
      if (!isUuid(req.params.leagueId)) return res.status(400).json({ error: "Enter a valid league ID." });
      const auth = await getAuthInstance();
      const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
      if (!session) return res.status(401).json({ error: "Sign in to manage league requests." });
      const requests = await (await getLeagueStore()).listPending(req.params.leagueId, session.user.id);
      return res.json({ requests });
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/leagues/:leagueId/requests/:userId", leagueMutationLimiter, async (req, res, next) => {
    try {
      if (!isUuid(req.params.leagueId)) return res.status(400).json({ error: "Enter a valid league ID." });
      if (!isValidAccountId(req.params.userId)) return res.status(400).json({ error: "Enter a valid member ID." });
      const auth = await getAuthInstance();
      const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
      if (!session) return res.status(401).json({ error: "Sign in to manage league requests." });
      const action = req.body?.action;
      if (!["approve", "decline"].includes(action)) {
        return res.status(400).json({ error: "Choose approve or decline for this request." });
      }
      const membership = await (await getLeagueStore()).reviewRequest(
        req.params.leagueId, session.user.id, req.params.userId, action
      );
      return res.json({ membership });
    } catch (error) {
      return next(error);
    }
  });

  app.get("/api/leagues/:leagueId/members", async (req, res, next) => {
    try {
      if (!isUuid(req.params.leagueId)) return res.status(400).json({ error: "Enter a valid league ID." });
      const auth = await getAuthInstance();
      const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
      if (!session) return res.status(401).json({ error: "Sign in to manage league members." });
      const members = await (await getLeagueStore()).listMembers(req.params.leagueId, session.user.id);
      return res.json({ members });
    } catch (error) {
      return next(error);
    }
  });

  app.patch("/api/leagues/:leagueId/members/:userId/role", leagueMutationLimiter, async (req, res, next) => {
    try {
      if (!isUuid(req.params.leagueId)) return res.status(400).json({ error: "Enter a valid league ID." });
      if (!isValidAccountId(req.params.userId)) return res.status(400).json({ error: "Enter a valid member ID." });
      const auth = await getAuthInstance();
      const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
      if (!session) return res.status(401).json({ error: "Sign in to manage league members." });
      const role = req.body?.role;
      if (!["administrator", "member"].includes(role)) {
        return res.status(400).json({ error: "A member can be assigned administrator or member access. Ownership cannot be reassigned here." });
      }
      const membership = await (await getLeagueStore()).setMemberRole(
        req.params.leagueId, session.user.id, req.params.userId, role
      );
      return res.json({ membership });
    } catch (error) {
      return next(error);
    }
  });

  app.get("/api/leagues/:leagueId/competition", async (req, res, next) => {
    try {
      if (!isUuid(req.params.leagueId)) return res.status(400).json({ error: "Enter a valid league ID." });
      const auth = await getAuthInstance();
      const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
      const competition = await (await getCompetitionStore()).getCompetition(req.params.leagueId, session?.user.id || null);
      if (!competition) return res.status(404).json({ error: "This public league could not be found." });
      return res.json({ competition });
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/leagues/:leagueId/seasons", competitionMutationLimiter, async (req, res, next) => {
    try {
      if (!isUuid(req.params.leagueId)) return res.status(400).json({ error: "Enter a valid league ID." });
      const auth = await getAuthInstance();
      const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
      if (!session) return res.status(401).json({ error: "Sign in as a league owner or administrator to create a season." });
      const body = asRecord(req.body);
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const dateError = validateDateRange(body.startsOn, body.endsOn);
      if (!name || name.length > 120) return res.status(400).json({ error: "Season name is required and must be 120 characters or fewer." });
      if (dateError) return res.status(400).json({ error: dateError });
      const season = await (await getCompetitionStore()).createSeason(req.params.leagueId, session.user.id, {
        name, startsOn: body.startsOn || null, endsOn: body.endsOn || null
      });
      return res.status(201).json({ season });
    } catch (error) {
      return next(error);
    }
  });

  app.patch("/api/seasons/:seasonId", competitionMutationLimiter, async (req, res, next) => {
    try {
      if (!isUuid(req.params.seasonId)) return res.status(400).json({ error: "Enter a valid season ID." });
      const auth = await getAuthInstance();
      const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
      if (!session) return res.status(401).json({ error: "Sign in as a league owner or administrator to manage this season." });
      const body = asRecord(req.body);
      const details = {};
      if (Object.hasOwn(body, "name")) {
        if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 120) {
          return res.status(400).json({ error: "Season name is required and must be 120 characters or fewer." });
        }
        details.name = body.name.trim();
      }
      if (Object.hasOwn(body, "startsOn")) details.startsOn = body.startsOn || null;
      if (Object.hasOwn(body, "endsOn")) details.endsOn = body.endsOn || null;
      if (Object.hasOwn(body, "status")) {
        if (!["draft", "active", "completed"].includes(body.status)) return res.status(400).json({ error: "Choose draft, active or completed." });
        details.status = body.status;
      }
      if (!Object.keys(details).length) return res.status(400).json({ error: "Provide a season name, date or status to update." });
      const dateError = validateDateRange(details.startsOn, details.endsOn);
      if (dateError) return res.status(400).json({ error: dateError });
      const season = await (await getCompetitionStore()).updateSeason(req.params.seasonId, session.user.id, details);
      return res.json({ season });
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/seasons/:seasonId/divisions", competitionMutationLimiter, async (req, res, next) => {
    try {
      if (!isUuid(req.params.seasonId)) return res.status(400).json({ error: "Enter a valid season ID." });
      const auth = await getAuthInstance();
      const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
      if (!session) return res.status(401).json({ error: "Sign in as a league owner or administrator to create a division." });
      const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
      if (!name || name.length > 100) return res.status(400).json({ error: "Division name is required and must be 100 characters or fewer." });
      const division = await (await getCompetitionStore()).createDivision(req.params.seasonId, session.user.id, name);
      return res.status(201).json({ division });
    } catch (error) {
      return next(error);
    }
  });

  app.patch("/api/divisions/:divisionId", competitionMutationLimiter, async (req, res, next) => {
    try {
      if (!isUuid(req.params.divisionId)) return res.status(400).json({ error: "Enter a valid division ID." });
      const auth = await getAuthInstance();
      const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
      if (!session) return res.status(401).json({ error: "Sign in as a league owner or administrator to manage divisions." });
      const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
      if (!name || name.length > 100) return res.status(400).json({ error: "Division name is required and must be 100 characters or fewer." });
      const division = await (await getCompetitionStore()).updateDivision(req.params.divisionId, session.user.id, name);
      return res.json({ division });
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/seasons/:seasonId/teams", competitionMutationLimiter, async (req, res, next) => {
    try {
      if (!isUuid(req.params.seasonId)) return res.status(400).json({ error: "Enter a valid season ID." });
      const auth = await getAuthInstance();
      const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
      if (!session) return res.status(401).json({ error: "Sign in as a league owner or administrator to create a team." });
      const body = asRecord(req.body);
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const homeVenue = body.homeVenue === undefined || body.homeVenue === null ? "" : body.homeVenue;
      const divisionId = body.divisionId || null;
      if (!name || name.length > 120) return res.status(400).json({ error: "Team name is required and must be 120 characters or fewer." });
      if (typeof homeVenue !== "string" || homeVenue.trim().length > 160) return res.status(400).json({ error: "Home venue must be 160 characters or fewer." });
      if (divisionId !== null && !isUuid(divisionId)) return res.status(400).json({ error: "Choose a valid division." });
      const team = await (await getCompetitionStore()).createTeam(req.params.seasonId, session.user.id, {
        name, homeVenue: homeVenue.trim() || null, divisionId
      });
      return res.status(201).json({ team });
    } catch (error) {
      return next(error);
    }
  });

  app.patch("/api/teams/:teamId", competitionMutationLimiter, async (req, res, next) => {
    try {
      if (!isUuid(req.params.teamId)) return res.status(400).json({ error: "Enter a valid team ID." });
      const auth = await getAuthInstance();
      const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
      if (!session) return res.status(401).json({ error: "Sign in as a league owner or administrator to manage this team." });
      const body = asRecord(req.body);
      const details = {};
      if (Object.hasOwn(body, "name")) {
        if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 120) return res.status(400).json({ error: "Team name is required and must be 120 characters or fewer." });
        details.name = body.name.trim();
      }
      if (Object.hasOwn(body, "homeVenue")) {
        if (body.homeVenue !== null && typeof body.homeVenue !== "string") return res.status(400).json({ error: "Enter a valid home venue." });
        if (typeof body.homeVenue === "string" && body.homeVenue.trim().length > 160) return res.status(400).json({ error: "Home venue must be 160 characters or fewer." });
        details.homeVenue = typeof body.homeVenue === "string" ? body.homeVenue.trim() || null : null;
      }
      if (Object.hasOwn(body, "divisionId")) {
        if (body.divisionId !== null && !isUuid(body.divisionId)) return res.status(400).json({ error: "Choose a valid division." });
        details.divisionId = body.divisionId;
      }
      if (Object.hasOwn(body, "status")) {
        if (!["active", "inactive"].includes(body.status)) return res.status(400).json({ error: "Choose active or inactive team status." });
        details.status = body.status;
      }
      if (!Object.keys(details).length) return res.status(400).json({ error: "Provide a team name, venue, division or status to update." });
      const team = await (await getCompetitionStore()).updateTeam(req.params.teamId, session.user.id, details);
      return res.json({ team });
    } catch (error) {
      return next(error);
    }
  });

  app.get("/api/teams/:teamId/eligible-players", async (req, res, next) => {
    try {
      if (!isUuid(req.params.teamId)) return res.status(400).json({ error: "Enter a valid team ID." });
      const auth = await getAuthInstance();
      const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
      if (!session) return res.status(401).json({ error: "Sign in to manage this roster." });
      const players = await (await getCompetitionStore()).eligiblePlayers(req.params.teamId, session.user.id);
      return res.json({ players });
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/teams/:teamId/members", competitionMutationLimiter, async (req, res, next) => {
    try {
      if (!isUuid(req.params.teamId)) return res.status(400).json({ error: "Enter a valid team ID." });
      const userId = req.body?.userId;
      if (!isValidAccountId(userId)) return res.status(400).json({ error: "Choose a valid registered league member." });
      const reason = validateSigningReason(req.body?.reason);
      if (reason.error) return res.status(400).json({ error: reason.error });
      const auth = await getAuthInstance();
      const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
      if (!session) return res.status(401).json({ error: "Sign in to manage this roster." });
      const result = await (await getCompetitionStore()).addTeamMember(req.params.teamId, session.user.id, userId, reason.value);
      return res.status(result.repeated ? 200 : 201).json(result);
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/teams/:teamId/transfers", competitionMutationLimiter, async (req, res, next) => {
    try {
      if (!isUuid(req.params.teamId)) return res.status(400).json({ error: "Enter a valid team ID." });
      const userId = req.body?.userId;
      if (!isValidAccountId(userId)) return res.status(400).json({ error: "Choose a valid registered league member." });
      const reason = validateSigningReason(req.body?.reason);
      if (reason.error) return res.status(400).json({ error: reason.error });
      const auth = await getAuthInstance();
      const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
      if (!session) return res.status(401).json({ error: "Sign in as a league owner or administrator to transfer a player." });
      const result = await (await getCompetitionStore()).transferTeamMember(req.params.teamId, session.user.id, userId, reason.value);
      return res.status(201).json(result);
    } catch (error) {
      return next(error);
    }
  });

  app.get("/api/teams/:teamId/signing-history", async (req, res, next) => {
    try {
      if (!isUuid(req.params.teamId)) return res.status(400).json({ error: "Enter a valid team ID." });
      const auth = await getAuthInstance();
      const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
      if (!session) return res.status(401).json({ error: "Sign in as a league owner or administrator to view signing history." });
      const events = await (await getCompetitionStore()).getTeamSigningHistory(req.params.teamId, session.user.id);
      return res.json({ events });
    } catch (error) {
      return next(error);
    }
  });

  app.delete("/api/teams/:teamId/members/:userId", competitionMutationLimiter, async (req, res, next) => {
    try {
      if (!isUuid(req.params.teamId)) return res.status(400).json({ error: "Enter a valid team ID." });
      if (!isValidAccountId(req.params.userId)) return res.status(400).json({ error: "Enter a valid player ID." });
      const auth = await getAuthInstance();
      const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
      if (!session) return res.status(401).json({ error: "Sign in to manage this roster." });
      const membership = await (await getCompetitionStore()).removeTeamMember(req.params.teamId, session.user.id, req.params.userId);
      return res.json({ membership });
    } catch (error) {
      return next(error);
    }
  });

  app.put("/api/teams/:teamId/captain", competitionMutationLimiter, async (req, res, next) => {
    try {
      if (!isUuid(req.params.teamId)) return res.status(400).json({ error: "Enter a valid team ID." });
      const userId = req.body?.userId;
      if (!isValidAccountId(userId)) return res.status(400).json({ error: "Choose a player on this team roster." });
      const auth = await getAuthInstance();
      const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
      if (!session) return res.status(401).json({ error: "Sign in as a league owner or administrator to assign a captain." });
      const membership = await (await getCompetitionStore()).assignCaptain(req.params.teamId, session.user.id, userId);
      return res.json({ membership });
    } catch (error) {
      return next(error);
    }
  });

  app.delete("/api/teams/:teamId/captain", competitionMutationLimiter, async (req, res, next) => {
    try {
      if (!isUuid(req.params.teamId)) return res.status(400).json({ error: "Enter a valid team ID." });
      const auth = await getAuthInstance();
      const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
      if (!session) return res.status(401).json({ error: "Sign in as a league owner or administrator to remove a captain." });
      const membership = await (await getCompetitionStore()).removeCaptain(req.params.teamId, session.user.id);
      return res.json({ membership });
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/contact", contactLimiter, async (req, res, next) => {
    try {
      const body = req.body && typeof req.body === "object" ? req.body : {};

      if (typeof body.website === "string" && body.website.trim()) {
        return res.status(202).json({ ok: true });
      }

      const submission = validateSubmission(body);
      if (submission.error) return res.status(400).json({ error: submission.error });
      if (!emailSender) {
        return res.status(503).json({ error: "We couldn't send your enquiry right now. Please try again shortly." });
      }

      await emailSender.sendContactEmail(submission.value);
      return res.status(202).json({ ok: true });
    } catch (error) {
      return next(error);
    }
  });

  app.use((error, _req, res, _next) => {
    if (error instanceof LeagueStoreError) {
      return res.status(error.status).json({ error: error.message });
    }
    if (error.type === "entity.too.large") {
      return res.status(413).json({ error: "Your request is too large. Please shorten it and try again." });
    }
    if (error instanceof SyntaxError && "body" in error) {
      return res.status(400).json({ error: "The submitted data could not be read." });
    }

    console.error("BREAK DISH API request failed.");
    return res.status(503).json({ error: "The service is temporarily unavailable. Please try again shortly." });
  });

  return app;
}

let app = createApp();

async function start(options = {}) {
  emailSender = Object.hasOwn(options, "emailSender") ? options.emailSender : createConfiguredEmailSender();
  const { getAuthInstance, getProfileStore, getLeagueStore, getCompetitionStore } = options;
  app = createApp({ getAuthInstance, getProfileStore, getLeagueStore, getCompetitionStore });
  server = app.listen(port, "0.0.0.0", () => {
    console.log(`BREAK DISH API listening on port ${server.address().port}`);
  });
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  return server;
}

async function shutDown() {
  if (server) {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections?.();
    await closed;
    server = undefined;
  }
  if (authModulePromise) {
    const { closeAuthDatabase } = await authModulePromise.catch(() => ({}));
    await closeAuthDatabase?.();
    authModulePromise = undefined;
  }
  profileStorePromise = undefined;
  leagueStorePromise = undefined;
  competitionStorePromise = undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().catch((error) => {
    console.error("BREAK DISH API could not start:", error.message);
    process.exitCode = 1;
  });

  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.once(signal, () => shutDown().catch(() => {
      console.error("BREAK DISH API shutdown failed.");
      process.exitCode = 1;
    }));
  }
}

export { app, createApp, start, shutDown };

function isUuid(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isValidAccountId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validateSigningReason(value) {
  if (value === undefined || value === null || value === "") return { value: null };
  if (typeof value !== "string" || value.trim().length > 500) return { error: "The signing reason must be 500 characters or fewer." };
  return { value: value.trim() || null };
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function validateDateRange(startsOn, endsOn) {
  for (const [field, value] of [["Start date", startsOn], ["End date", endsOn]]) {
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${field} must be a valid calendar date.`;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) return `${field} must be a valid calendar date.`;
  }
  if (startsOn && endsOn && startsOn > endsOn) return "The end date must be on or after the start date.";
  return null;
}
