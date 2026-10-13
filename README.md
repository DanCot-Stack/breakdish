# BREAK DISH

Responsive BREAK DISH static website with an Express API. The contact form sends enquiries by email only. Better Auth stores account identities and sessions in PostgreSQL; authenticated players can manage the profile fields already defined by the application schema.

## Project layout

- `index.html`, `styles.css`, `script.js` — branded responsive website and contact form.
- `login.html`, `signup.html`, `account.html` — Better Auth registration and login forms, plus a session-checked player profile page.
- `join-league.html`, `create-league.html`, `competition.html` — public league directory, league creation and membership tools, plus season, division, team and roster management.
- `privacy.html`, `terms.html` — website legal-information pages.
- `api/server.js` — Express 5 contact API, Better Auth routes, authenticated profile, league and competition endpoints, security headers and origin checks.
- `api/auth-factory.js`, `api/auth.js` — Better Auth configuration and PostgreSQL pool.
- `api/profile-store.js`, `api/league-store.js`, `api/competition-store.js` — parameterised PostgreSQL access for player profiles, league membership and transactional season/team workflows.
- `api/migrations/` — application schema for player profiles, league ownership and membership, seasons, divisions, teams, rosters and registration history.
- `api/*.test.js` — unit tests and an opt-in local PostgreSQL integration test.

## Current functionality

- Existing contact form: sends email through Resend; it does not save messages to a database or files.
- Authentication: Better Auth email/password registration, login, logout and persistent sessions. `GET /api/me`, `GET /api/me/profile` and `PUT /api/me/profile` validate the session on the server. Email verification and password recovery require configured email delivery.
- Player profiles: the signed-in user can edit display name, location and biography. The API always takes profile ownership from the authenticated session; public profile pages and player identifiers are not implemented.
- PostgreSQL schema: Better Auth-managed identity/session tables plus `player_profiles`, `leagues` and `league_memberships`.
- Leagues: signed-in players can create a public league, and a database trigger assigns the creator as its active owner. The directory shows public open/active leagues and their details. A league can allow immediate joining or require organiser approval. Owners and administrators can review requests; only owners can assign or remove administrator access. Server-side checks enforce league-scoped owner, administrator and member permissions.
- Ownership safety: database triggers prevent an active league from losing its last active owner or becoming active without one. Join and request operations use transactions, serialize per league and rely on the unique league/user constraint to avoid duplicates.
- Seasons, divisions and teams: league owners and administrators can create draft seasons with optional dates, add divisions during draft, and create active/inactive teams with an optional home venue. Season status moves forward from draft to active to completed; completed seasons are read-only and remain available as history. Teams are scoped by database constraints to a season and its league, and divisions are scoped to one season.
- Team registrations: a player can be actively registered to one team per league season and may transfer. Owners/administrators can transfer players atomically; active team captains can sign unattached eligible members and remove non-captains on their team. A receiving team can accept at most three post-start signing events per season. Preseason signings are free; returns and transfers each use a new slot. Durable registration and event history is retained after removal or transfer.

Signing rules apply only to team-event rosters. Singles and money-match entry are outside this registration workflow; those competition types are not implemented yet.

The static account page checks the session for user experience; profile and competition data remain protected by the API regardless of frontend behavior. Fixtures, results, standings, scoring and tournament features are not implemented. There is no public player profile directory, ownership transfer, league suspension or season deletion interface.

## Prerequisites and local environment

- Node.js **22.12 through 24.x** and pnpm 11.25 (or a compatible pnpm release). The API package constrains Render to this supported Node range; local checks here ran on Node 24.19.
- A local PostgreSQL 13+ database. Do not point local migrations at a production database.
- Resend account/API key and a verified sending domain for real contact and account emails. Automated tests mock email delivery.

From PowerShell in the project folder:

```powershell
Set-Location api
pnpm install --frozen-lockfile
Copy-Item .env.example .env
```

Create local development and test databases using your local PostgreSQL installation, then configure `api/.env`. Use separate names for the two databases and never point local migrations at a hosted or production database. Generate a unique Better Auth secret with `pnpm auth:secret` and place the result in `.env`. Fill in the Resend values only if you want to test real email delivery. `.env` is ignored by Git; `.env.example` contains placeholders only.

For a local PostgreSQL installation with `psql` on PATH, the database setup can look like this (replace the local password before running):

```powershell
psql -U postgres -c "CREATE ROLE breakdish LOGIN PASSWORD 'choose-a-local-password';"
psql -U postgres -c "CREATE DATABASE breakdish_dev OWNER breakdish;"
psql -U postgres -c "CREATE DATABASE breakdish_test OWNER breakdish;"
```

Then set `DATABASE_URL=postgres://breakdish:your-local-password@127.0.0.1:5432/breakdish_dev` in `api/.env`. These commands are for new local databases only; don’t point them at a managed or production database. The project migration creates the `player_profiles` table along with the planned league schema, but league features are not connected to the website yet.

Local values to configure:

- `DATABASE_URL` — local-only PostgreSQL connection string.
- `BETTER_AUTH_SECRET` — random server secret of at least 32 characters.
- `BETTER_AUTH_URL` — local API origin, `http://localhost:3001`.
- `ALLOWED_ORIGINS` — exact frontend origins; the sample allows localhost ports 5500.
- `TEST_DATABASE_URL` — set only when running integration tests, and point it to a disposable local database whose name ends in `_test`.
- `RESEND_API_KEY`, `CONTACT_FROM_EMAIL`, `CONTACT_TO_EMAIL` — provider email settings. Verification and password recovery are only enabled when the API key and verified sender address are configured. Production authentication refuses to start without these email settings.
- `PORT` and `NODE_ENV` — sample values are for local development.

Apply schema in this order from `api/`:

```powershell
pnpm auth:migrate
pnpm db:up
```

Better Auth's supported PostgreSQL migration command creates its own identity, account, session, verification and persistent rate-limit tables. The `node-pg-migrate` application migrations create profile, league and membership tables, followed by the league joining workflow, seasons/divisions/teams/rosters and auditable registrations. Migration 004 imports the existing roster snapshot as legacy history. Older versions did not retain prior transfers, signing authors or reasons, so those details are clearly marked unavailable rather than fabricated. If migration preflight finds overlapping active registrations, a team already beyond the signing allowance, or an unfinished season with registrations but no start date, it stops for review. Migration 006 requires a season start date before new registrations; start dates freeze after the first registration. Application rollback is limited to the latest migration and may be blocked to preserve data. Better Auth tables contain login credentials and sessions, so there is no automatic auth rollback command; take a backup before any manual schema removal.

For local frontend calls, the website automatically uses `http://localhost:3001` when opened from `localhost` or `127.0.0.1`. For a different local hostname, set the empty `breakdish-api-url` meta value in the HTML pages that include `script.js` to the API origin. That value is public configuration, never a secret.

Start the API:

```powershell
pnpm start
```

In another PowerShell terminal at the project root, serve the static site:

```powershell
py -m http.server 5500
```

Preview at [http://localhost:5500](http://localhost:5500). The API health check is [http://localhost:3001/healthz](http://localhost:3001/healthz). Local authentication requests use cookie credentials and allow only the configured website origins.

## Tests

From `api/`:

```powershell
pnpm test
```

This runs contact/email tests, authentication configuration tests, mocked API route and validation tests, and the PostgreSQL integration test when configured. The real PostgreSQL integration test covers registration, login, persistent sessions, logout, profile persistence, league creation and ownership, seasons and state transitions, divisions, team/season association, roster eligibility, concurrent duplicate roster changes, captain assignment and permissions, league joining and owner protection. It also covers preseason signings, the three-event limit, return signings, transfers, failed-transfer rollback, concurrent operations and audit history. Prepare the disposable test database and its schema with all current migrations. The following PowerShell commands set both variables only for the current terminal:

```powershell
$env:DATABASE_URL = "postgres://breakdish:your-local-password@127.0.0.1:5432/breakdish_test"
pnpm auth:migrate
pnpm db:up
$env:TEST_DATABASE_URL = $env:DATABASE_URL
pnpm test:integration
pnpm test
```

`pnpm test` also discovers the integration test. If `TEST_DATABASE_URL` is unset, that integration test is reported as skipped; the remaining route tests use injected mocks and do not prove database behavior. Never use a Render or other production connection string for tests. Migrations are additive and reversible for the application-owned schema; Better Auth owns its auth tables.

## Email and Resend

For real contact, verification and reset emails, create a Resend API key, verify a sender domain, then configure `RESEND_API_KEY` and `CONTACT_FROM_EMAIL`. Contact messages go only to the fixed `CONTACT_TO_EMAIL`; account emails are addressed to the account holder. Provider errors are logged generically and are not returned to visitors. Resend free-tier/testing restrictions still apply; verify the sender and send a test to an inbox you control before launch. See [Resend's sending guide](https://resend.com/docs/send-with-nodejs) and [verified-domain guide](https://resend.com/docs/dashboard/domains/introduction).

Without Resend configuration in local development, email verification and password recovery are not available; production auth initialization is blocked until email delivery is configured. Do not claim either flow is end-to-end until a real provider test succeeds.

## Render deployment notes — no deployment performed

The existing Render Static Site can remain in place. The API must run as a separate Node Web Service and use a persistent PostgreSQL database. No Render service manifest is included, and the current Render dashboard settings have not been inspected or changed.

### API Web Service settings

Create a Web Service from the reviewed repository branch with:

- Runtime: Node
- Root directory: `api`
- Build command: `pnpm install --frozen-lockfile`
- Start command: `pnpm start`
- Health check path: `/healthz`
- Node version: the `api/package.json` engine range (`>=22.12.0 <25.0.0`)

The existing Static Site uses the repository root as its publish directory and has no build step; keep those settings unchanged. Render runs Web Service build and start commands relative to the configured root directory. [Render Web Services documentation](https://render.com/docs/web-services) describes these settings.

Configure these API environment variables in Render. Never put their values in frontend files:

- `DATABASE_URL` — the **internal** URL of the persistent Render Postgres database in the same region as the API service.
- `BETTER_AUTH_SECRET` — a unique random secret of at least 32 characters.
- `BETTER_AUTH_URL` — the API's public HTTPS origin.
- `ALLOWED_ORIGINS` — the exact frontend HTTPS origin, currently `https://breakdish.onrender.com`, without a path or trailing slash.
- `RESEND_API_KEY`, `CONTACT_FROM_EMAIL`, `CONTACT_TO_EMAIL` — Resend credentials and verified sender / destination addresses.
- `NODE_ENV=production`.

Render supplies `PORT`; do not set it to a fixed production port. Render's internal Postgres URL is for services in the same region. [Render Postgres connection documentation](https://render.com/docs/postgresql-creating-connecting).

### Database and frontend release order

1. Provision a persistent production database and the API service only after approving their plans and costs. Do not use local PostgreSQL in production.
2. Set the API environment above. Check the exact database target and arrange a backup before applying schema changes.
3. Apply Better Auth's schema with `pnpm auth:migrate`, then application migrations 001–006 with `pnpm db:up`, from the API root and only against the verified production database, after explicit approval to migrate production. Do not put these commands in the build or start command; review migration output and take an approved backup first.
4. Deploy the API and verify `/healthz`, database-backed authentication, contact delivery, and browser cookie/session behavior.
5. Put the same API origin in the `breakdish-api-url` meta setting in all nine pages: `index.html`, `login.html`, `signup.html`, `account.html`, `join-league.html`, `create-league.html`, `competition.html`, `privacy.html`, and `terms.html`. Leave it blank in the local source until the real API URL is known; `script.js` selects `http://localhost:3001` on localhost and reports an unconfigured production URL instead of silently calling the static site.
6. Deploy the frontend to the existing Static Site only after the API URL and required services are ready.

Better Auth uses credentialed CORS and secure production cookies. Keep `ALLOWED_ORIGINS` exact; do not use `*` or disable origin checks. Separate Render hostnames can encounter browser third-party-cookie restrictions. Verify signup, login, refresh and logout in supported browsers before launch; if cookies are blocked, use a shared custom-domain parent or same-origin proxy. The API health route currently confirms the HTTP service responds; it is not a database readiness check.

Production database migrations have not been run. Migration 004 imports legacy roster state and deliberately stops on inconsistent registrations or signing limits; migration 006 requires an official season start date before registrations and prevents changing it after registrations begin. A fresh database should have no legacy rows, but confirm the target is empty and review the migration output before relying on that assumption. Better Auth tables contain credentials and sessions; do not attempt an automatic auth-schema rollback.

## Illustrative content

Fixtures, results, table entries, player/team cards and news remain illustrative placeholders, not real league data. The existing BREAK DISH logo, branding and contact functionality are retained.
