# BREAK DISH Master Development Plan

**Roadmap owner:** BREAK DISH project owner
**Last reconciled:** 17 October 2026
**Scope:** Product and technical roadmap for the existing website, API and PostgreSQL application.

This is the project roadmap, not a claim that every listed capability is live. It was reconciled against the local repository, README, API routes, frontend pages, migrations 001–011 and available tests. Production notes identified as **owner-reported** were supplied by the project owner on 17 October 2026; production and Render were not accessed for this update.

## Status meanings

- **Live / production verified** — production operation was explicitly confirmed by the owner or an authorized prior verification. The source/date of that evidence is stated; this update did not recheck production.
- **Implemented / awaiting production verification** — code, schema and/or tests exist locally, but the complete live journey has not been confirmed in production.
- **In development** — currently being actively implemented. No feature work is active as part of this documentation update.
- **Planned** — agreed work that has not been implemented.
- **Future consideration** — an idea that needs a product, legal, cost or technical decision before becoming committed work.
- **Blocked / requires decision** — work cannot be safely specified or finished until the listed decision or prerequisite is settled.

## Current project snapshot

| Area | Status and evidence |
|---|---|
| Source control | **Verified locally:** local `main` was at `60c79e0` and `git status` showed no ahead/behind difference from `origin/main`. No GitHub operation was performed for this documentation task. |
| Website and API domains | **Live / production verified (owner-reported):** website `https://break-dish.com`, API `https://api.break-dish.com`. All 14 local HTML pages contain the shared API URL setting; local development still selects `http://localhost:3001`. Current Render dashboard configuration was not inspected. |
| PostgreSQL / schema | **Live / production verified (owner-reported, 17 Oct 2026):** Better Auth and BREAK DISH application migrations through 011 are applied. No production database was accessed for this plan. Local migration files 001–011 are present. |
| Super Admin assignments | **Live / production verified (owner-reported, 17 Oct 2026):** migration 011, Founder Super Admin and Recovery Super Admin assignments and audit records were verified. Maximum two active Super Admin accounts. |
| Match Engine | **Implemented / awaiting production verification:** SQL-backed matches, frame scoring, participant-specific score permissions, confirmation/dispute lifecycle, live list, polling and historic-results browsing exist locally. A complete current production match lifecycle has not been verified in this update. |
| Worktree | Tracked files were clean at review. Existing untracked `api/diagnose-db-readonly.mjs`, `api/inspect-db-target.mjs`, `api/verify-db-readonly.mjs`, `assets/hero-pool.jpg`, `backups/` and `tools/` were preserved and excluded from this documentation work. |

## Current Priorities

1. **Validate the complete Match Centre lifecycle against the existing production test league** when the owner authorizes the specific production checks. Confirm participant-specific scoreboard permissions, live scoring, result confirmation and completion. Do not create synthetic competition data or run migrations as part of this validation.
2. **Resolve any defects found and repeat the lifecycle checks.** Public viewing stays separate from score-editing authority; admin status alone must not grant match-scoring permission.
3. **Build official standings from confirmed competitive results** only after result finalization and competition formats are specified. Practice and Money Match records must not leak into standings.
4. **Then complete the core league journey** around seasons, team/individual entries, fixtures, results and standings before investing in advanced tournament, social or mobile-app features.

These are roadmap priorities only. They do not authorize production access, production data changes, deployment, migrations or Git pushes.

---

## A. Infrastructure, accounts and security

| Capability | Status | Current position, dependencies and acceptance evidence |
|---|---|---|
| GitHub, static website, API and custom domains | **Live / production verified (owner-reported)** | Existing repository and Render services are in use. Website/API domain values above are owner-reported; exact current Render plans, auto-deploy settings, environment values and deployment SHAs must be checked in the dashboard before a release. Keep the static site and API separate unless the owner approves an architecture change. |
| PostgreSQL and migration baseline | **Live / production verified (owner-reported)** | Production is reported at Better Auth schema plus application migrations 001–011. Do not re-run them blindly. Every future migration needs a target check, backup plan, data-retention/rollback review, disposable local migration test and explicit production-migration approval. |
| Better Auth registration, login, session and logout | **Implemented / awaiting production verification** | Better Auth routes, PostgreSQL schema, email/password UI, session detection and logout are present. Cookie tests cover secure attributes and Remember Me persistence; confirm the production browser journey against known deployed frontend/API versions. Dependencies: domain, trusted origins, CORS, email sender and secure cookies. |
| Email verification / password recovery | **Live / production verified (owner-reported for verification email)** | The owner reported successful production verification email delivery. Password recovery, expired/used links, provider failures and current sender configuration need separate checks before relying on them. Never put secrets in frontend or roadmap. |
| Player account/profile editing | **Implemented / awaiting production verification** | Authenticated users can view/edit supported profile fields (display name, location, biography) through `/api/me/profile`. Authorization uses the session. Public profiles and a public player identifier are not implemented. |
| Resend contact email | **Implemented / awaiting production verification** | `/api/contact` validates, rate-limits and emails only; it does not save message content. The direct `mailto:` address is a fallback. Consistent live contact-form delivery has not been established in this review. |
| League and team permission foundations | **Implemented / awaiting production verification** | Server routes and database constraints enforce league roles, active ownership, captain privileges and season registrations. Test the deployed API before describing live journeys as verified. |
| Backup Super Admin architecture | **Live / production verified (owner-reported, 17 Oct 2026)** | Migration 011 preserves the Founder Super Admin assignment and permits at most one Recovery Super Admin assignment, with immutable account IDs, transactional audit and database guards. The owner reports both assignments and audit records verified. This task did not query production. |
| Platform Admin and role audit | **Implemented / awaiting production verification** | Migrations 010/011 and API routes support Platform Admin list/history and Super Admin-only grant/revoke. Platform Admin is not Super Admin and must not gain historic import or match-score privileges. |
| Backup and recovery operations | **Blocked / requires decision** | A readable custom-format backup before migration 010 was previously owner-confirmed; that does not prove a current recurring backup or tested restore. Decide frequency, retention, secure storage, restore-drill frequency, incident contacts and replacement authorization. Restore only in a disposable environment during verification. |

**Dependencies:** domain/Render configuration; server-side secrets; PostgreSQL backup/restore practice; Better Auth trusted-origin and cookie configuration.
**Recommended next task:** finish the authorized production Match Centre test sequence below; separately schedule an access-controlled recovery drill.
**Rules to preserve:** no HTTP route creates or changes Super Admin assignments; authority uses immutable user IDs; role history is append-only; platform roles never imply match participation.

## B. Match Centre and live match scoring

| Capability | Status | Current position and next evidence |
|---|---|---|
| Explicit match categories | **Implemented / awaiting production verification** | Migration 007 requires Team League, Singles League, Doubles League, Tournament/Flyer, Money Match or Practice Match. Official/practice separation is derived from category. |
| Scheduled fixtures and match detail | **Implemented / awaiting production verification** | Match creation, scheduling, editing/cancellation of eligible unstarted fixtures, detail pages and public reads exist. Team/Singles/Doubles constraints and approved doubles-entry snapshots are supported. |
| Live Matches hub and timer | **Implemented / awaiting production verification** | `/api/matches/live` filters `in_progress`; the page polls periodically and uses `started_at` as its elapsed-time source. Verify live response, scores, names, current-frame players and disappearance after a state transition in production. |
| Previous and completed matches | **Implemented / awaiting production verification** | Match Centre supports completed, read-only result review; Historic Results separately browses league → season → final results. Confirm deployed navigation and read-only controls. |
| Scoring permission | **Implemented / awaiting production verification** | Score changes are restricted to registered players belonging to a side in that specific match. Super Admin, Platform Admin, League Owner/Admin or Captain status alone grants no scoring rights. Keep an authenticated-viewer regression test and production permission matrix. |
| Frame players, score, Dish and Counter Dish | **Implemented / awaiting production verification** | Frame-result/event routes, eligibility rules and audit records exist. Verify counts, player selection, corrections and persistence in a real match. |
| Result confirmation, disputes and finalization | **Implemented / awaiting production verification** | Confirmation/retraction, dispute, resolution and finalization API behavior exists. The front end has confirmation/dispute actions, but organiser dispute resolution is not a complete interface. Confirm both sides’ result and audit history. |
| Live updates | **Implemented / awaiting production verification** | Browser polling is used; push/WebSocket updates are not implemented and are not required for initial validation. |
| Mobile scoring ergonomics | **Planned** | Verify a venue-sized scoreboard works without routine scoring controls scrolling off-screen; check touch targets, current-frame clarity and duplicate submissions. Source inspection alone does not prove layout. |
| Breaker nomination/alternation, undo, winner popup and highlights | **Planned** | Define rule configuration, audit semantics and completion UX first. Corrections must remain auditable and must not delete history. |
| Full production match lifecycle | **Planned** | Test scheduled → start → frame/player selection → scoring/events → two-side confirmation → completion → Previous Matches read-only review. Test an eligible participant, nonparticipant, anonymous viewer and admin-only identity. No synthetic data. |

**Dependencies:** owner-reported production migrations through 011; existing test league and match; eligible player accounts; permission to make any test score changes; deployed frontend/API versions.
**Acceptance:** live endpoint includes only in-progress matches; score/timer/participants are correct; only that match’s players can mutate; changes persist and audit; confirmations complete the result; completed matches are read-only and move from Live to Previous.
**Decision:** settle official rule variations (break order, correction/undo policy and dispute deadline) before automating them.

## C. Leagues, competition formats and fixture generation

| Capability | Status | Current position and next evidence |
|---|---|---|
| Public league directory, creation and joining | **Implemented / awaiting production verification** | Public directory/details, signed-in creation, creator ownership, open joining or approval requests and owner/admin membership management have API/UI support. Verify production journey, duplicate requests and owner protection. |
| Seasons, optional divisions and teams | **Implemented / awaiting production verification** | Migrations 003+ and routes support draft/active/completed transitions, optional divisions, teams, venue and status. Completed seasons are retained/read-only; no season deletion interface. |
| Team roster, captain, transfers and signing history | **Implemented / awaiting production verification** | Accepted rule: one active team per player within a league season at a time, but transfers are allowed and atomic; history is permanent. Each receiving team allows at most three post-start signing events per season. Return signings and incoming transfers consume an event; removal does not restore a slot; preseason registrations do not count; do not backdate. Singles/Money Match eligibility remains independent. |
| Manual fixtures and round robin | **Implemented / awaiting production verification** | Manual fixtures and Doubles League approved-entry snapshots exist. Preview/save supports one/two-leg rounds for active teams and approved Singles/Doubles entries, explicit byes, date/venue edits, removals and collision checks. Migration 009 keeps nullable immutable `round_number` and leaves historical fixtures null. |
| Team, Singles, Doubles and individual round-robin league models | **Partially implemented** | Categories and relevant fixture paths exist, but complete per-format configuration, entry rules, seasons, eligibility and statistics are not demonstrated end-to-end for every format. Specify each rule set before extending schema. |
| League tables/standings | **Planned** | No official standings calculation/page is present. Depends on frozen scoring rules and finalized results. Compute from canonical fixtures/results; do not maintain duplicate manually edited totals. Exclude practice and Money Matches. |
| Team League player-selection methods | **Planned** | Only for multi-team matches with multiple players per team: pick per match/frame, blind team sheet, away-team pick, randomized draw. Draw requires attendance, enough eligible players, no repeat in the draw, transparent assignment and confirmation/lock. Excludes Singles, Doubles, individual round robin and Money Matches. |
| Tournament/Flyer | **Partially implemented** | Category, basic event routes and competition-entry records exist. Public registration, seeding, draws, brackets, score reporting, progression, capacity and withdrawals are incomplete. |
| Money Matches | **Partially implemented** | Category, private visibility and manual terms/acknowledgements exist. No payment or custody. Exclude from league tables and team signing rules. |
| Competition fees and approvals | **Blocked / requires decision** | No payment processing exists. Decide collection/custody, refunds, disputes, legal/tax responsibility, platform fee and consent before implementation. |

**Dependencies:** finalized match lifecycle; format rules; accounts/memberships; season/roster eligibility.
**Tests:** concurrent joins/transfers, three-event limit, round-robin pair counts/byes/DST, collisions, immutable round numbers, completed-season retention and standings cases covering disputed/cancelled/practice/money matches.
**Recommended next task after Match Centre verification:** specify and implement standings from finalized Team League results.

### Existing player signing rules (must remain stable)

- One active team registration per player per league/season at a time; transfers are allowed.
- A transfer ends the old registration and begins the new one atomically.
- Durable history includes player, league, season, team, dates, classification, authorizer, event time and supplied reason; it survives removal and transfer.
- A team accepts at most three qualifying post-start signings in a season. New, returning and transferred-in players consume events. Failed attempts do not; pre-season signings do not; removal does not restore an event.
- Do not manipulate/backdate dates. The rule applies only to team-event rosters.

Earlier requirements forbidding any within-season team change were superseded by the accepted transfer clarification. A later conflict must be recorded for decision rather than silently changing enforcement.

## D. Practice Mode

| Capability | Status | Current position |
|---|---|---|
| Practice category, privacy and separated data | **Implemented / awaiting production verification** | Practice type, private visibility and separate stats exist. Database views separate practice from competitive aggregates; verify privacy and aggregation through local PostgreSQL integration tests. |
| Singles-like practice scoring | **Implemented / awaiting production verification** | The Match Engine can record participants, frames, results and Dish/Counter Dish events. Production operation still needs verification. |
| Practice history, head-to-head and one-visit clearance | **Planned** | Dedicated history/head-to-head and one-visit clearance tracking are not present. Define a visit/clearance under the chosen UK 8-ball rules before collecting it. |

**Acceptance:** practice is private to permitted participants and has separate win percentage/events; no practice result enters official tables, rankings, Top 10 or competitive career statistics.
**Dependency:** definition of one-visit clearance and rule variation.
**Tracking:** Completed foundation: categorized, private practice scoring and separate aggregates. Remaining: one-visit clearance plus dedicated practice history/head-to-head. Production testing: verify privacy and separated totals before publishing practice stats. Next task: validate existing practice scoring, then specify the clearance rule.

## E. Player profiles, teams and statistics

| Capability | Status | Current position |
|---|---|---|
| Private member profile | **Implemented / awaiting production verification** | Account page and authenticated endpoints support existing fields only: display name, location and biography; API enforces self-edit. |
| Public player/team pages | **Planned** | Homepage reports that directories are not published. Decide privacy, consent, discoverability, moderation and whether IDs are global or league-scoped before release. |
| Histories and statistics | **Partially implemented** | Match/frame records and separated practice/competitive views exist; public histories, head-to-head and complete career aggregates are incomplete. |
| Rankings, achievements and awards | **Future consideration** | Require stable rules, enough verified results and correction/dispute policy. Keep practice separate. |

**Tests:** profile ownership/validation; public/private boundaries; practice/competitive aggregates; disputed/corrected results.
**Decision:** public profile fields, opt-in and player-identifier scope.
**Tracking:** Completed foundation: private editable member profile. Remaining: public profile/team directory and complete player statistics. Production testing: confirm field persistence and self-only editing. Dependencies: consent, discoverability and stable final results. Next task: decide public-field policy before adding public profile endpoints.

## F. QR access

**Status: Planned.** Candidate QR destinations: league, match, table, tournament and opted-in player pages; reusable venue/table codes should resolve to managed destinations rather than embed private data.

**Security:** a QR code is navigation only; it never grants login, participation, score changes or administrator rights.
**Dependencies:** stable public URLs and visibility rules. **Tests:** scan on iOS/Android; stale code handling; no embedded secrets; anonymous access cannot mutate or view private data.
**Next task:** defer until public directory/profile visibility rules are settled.
**Tracking:** Completed: no QR feature is claimed. Remaining: QR creation, destination management and venue/table reuse. Production testing: none until implementation; test mobile scans and anonymous authorization then. Dependencies: public URL and visibility policy. Next task: revisit after directories and visibility decisions.

## G. Administration and historic records

| Capability | Status | Current position |
|---|---|---|
| Super Admin/recovery assignments | **Live / production verified (owner-reported, 17 Oct 2026)** | Two maximum active assignments: founder plus one recovery. Owner reports migration 011 and assignment/audit verification. Future replacement needs a controlled, auditable procedure; authority must not use mutable email/name. |
| Platform Admin, league roles and captains | **Implemented / awaiting production verification** | Role management and audit endpoints exist. These roles stay separate; none automatically grants match-scoring access. |
| Historic Results archive | **Implemented / awaiting production verification** | Public league → completed season → final match browser has API/page. Verify privacy and source data. |
| Historic file import | **Planned — Super Admin only** | No upload/import exists. Only Super Admin may authorize it; Platform Admin, league roles and captains must fail. Define format, provenance, validation, preview, approval, duplicate resolution and audit. |
| Automated season archive | **Planned** | Completed seasons are retained/read-only; automated archival is not confirmed. Never erase canonical results. |
| Rules and governing-body updates | **Future consideration** | Choose authoritative sources, update owner, citations/version date and variation handling. |

**Tests:** concurrent two-slot limit; founder/recovery constraints; append-only history; role revocation; non-Super-Admin import denial; no role-based score bypass.
**Decisions:** recovery/replacement runbook, dual control, retention, import formats and exception policy.
**Tracking:** Completed foundation: role schema/API and read-only historic-results browser; production Super Admin state is owner-reported. Remaining: import, automated archiving and runbooks. Production testing: verify deployed role separation before granting roles or importing. Dependencies: import format/provenance and recovery policy. Next task: document recovery procedures, then define an import specification; do not build upload yet.

## H. Notifications, email and communications

| Capability | Status | Current position |
|---|---|---|
| Contact and account email | **Partially implemented** | Resend integration exists; owner reported production verification email succeeded. Contact delivery, password recovery, expiry and provider failure paths need separate checks. |
| Operational addresses | **Partially implemented** | `accounts@break-dish.com` is intended. `info@` and `results@break-dish.com` are future addresses, not assumed configured. |
| Weekly results emails | **Planned** | Send only relevant results to eligible league/tournament recipients; require consent, preferences, unsubscribe and suppression. |
| Notifications/preferences | **Planned** | No notification center is established. Implement after reliable lifecycle events. |
| Registration agreements | **Planned** | Separate site terms, league rules and competition-specific consent; capture version/purpose when appropriate and avoid redundant checkboxes. |

**Dependencies:** verified results, consent/retention policy, verified domains and cost check. **Tests:** eligibility, unsubscribe, idempotency, provider failure and no private match data leakage.
**Tracking:** Completed foundation: transactional Resend mail paths and owner-reported verification-email success. Remaining: verify contact/reset flows and build opt-in notifications. Production testing: test mail only to controlled inboxes after approval. Dependencies: consent/unsubscribe and sender configuration. Next task: verify contact and recovery email delivery without exposing recipient data.

## I. Media, recording and social

**Status: Future consideration.** Ideas: phone-camera recording, scoreboard overlays, continuous recording while scoring, uploads/storage, internal social, YouTube/TikTok/Facebook/Instagram integration, generated weekly/monthly highlights and Player/Team of the Week/Month.

Before implementation decide value, storage/egress budget, moderation, participant consent, privacy, copyright, safeguarding, retention/takedown and platform API terms. Generated highlights must use verified results and must not invent scores/statistics. Recording cannot weaken match permissions.
**Tracking:** Completed: no media/social feature is claimed. Remaining: recording, storage, integrations and generated content. Production testing: none until policy, retention and budget are approved. Dependencies: consent, moderation, cost and data-protection decisions. Next task: defer; gather user demand before selecting one small pilot.

## J. Monetisation and business model

**Status: Blocked / requires decision before payments; models are Future consideration.** Possible free/premium subscriptions, platform/entry fees, prize pools, organiser revenue, sponsorship, advertising and paid features.

Hold a dedicated business/legal review before payment processing. Decide fund custody, refunds, chargebacks, prizes, taxes, consumer terms, jurisdiction and provider costs. No payment processing or custody exists. Money Match acknowledgements only record manual agreement.
**Tracking:** Completed: no payments or paid league registration are implemented. Remaining: business model and legal review. Production testing: none until a payment design is approved. Dependencies: fund flow, refunds, accounting, terms and provider quote. Next task: schedule the discussion; do not integrate a provider yet.

## K. FlutterFlow mobile app

**Status: Planned after website functionality and APIs stabilize.** At the beginning of this stage, remind the owner to create the FlutterFlow account using the designated project-owner email; confirm the address privately at that stage.

Reuse the authenticated API and canonical data; plan app-specific navigation, offline/error behavior, permissions, Android/iOS device testing, store review, publication accounts and costs. Do not assume FlutterFlow or store publishing is free. **Acceptance:** shared account/league/match data, server-side authorization, real-device scoreboard testing and no duplicated competition system.
**Tracking:** Completed: website/API is the intended shared foundation; no FlutterFlow app is implemented. Remaining: app design/build and store release. Production testing: device/API conformance begins after implementation. Dependencies: stable APIs, app-store accounts, FlutterFlow plan and budget. Next task at app-stage start: remind the owner to create the account with the privately confirmed project-owner email, then scope one mobile journey.

## L. Final polish and launch readiness

**Status: Planned after core functionality is reliable.** Preserve the premium dark, burgundy, gold and cream identity. Schedule visual polish after core league and match flows.

Checklist: responsive desktop/tablet/mobile; accessible keyboard/focus/contrast/touch targets; performance/SEO; security and privacy/terms review; backup/restore drill; monitoring; email deliverability; production browser tests; incident/support owner; release and rollback procedure. A page or code path alone does not satisfy a launch item.
**Tracking:** Completed: existing visual identity and responsive UI foundation. Remaining: final polish and launch checklist evidence. Production testing: browser, accessibility, performance, backup/recovery and security checks must be recorded. Dependencies: stable core workflows and current service configuration. Next task: defer major polish until match/league workflows pass their acceptance gates.

## Recommended delivery sequence and acceptance gates

1. **Production Match Centre verification** — only after explicit authorization for concrete test actions. Check live/scheduled/completed states, participant-only scoring, frame events, timer, confirmations, dispute/finalization and read-only history on the existing test league. Record deployed SHAs/results; no synthetic data or migrations.
2. **Stabilize results** — fix proven defects; maintain PostgreSQL integration and authorization tests. Gate: final result/audit is consistent and only participants can score.
3. **Standings** — define points/tiebreaks; calculate from canonical finalized team fixtures. Test incomplete/cancelled/disputed results and exclude practice/money.
4. **League formats and player selection** — define Team/Singles/Doubles/individual rules, entries, attendance, captain workflow and random selection. UI/API/database must agree.
5. **Profiles and statistics** — decide privacy and compute histories/head-to-head/rankings from canonical results; prove competitive/practice separation.
6. **Tournament operations** — define registration, seeds, draw formats, progression, withdrawals and disputes; test deterministic brackets and concurrent score updates.
7. **Historic import and administration** — specify file provenance and implement Super Admin-only preview/import with immutable audit; reject all other roles at API/database boundaries.
8. **Communications and advanced options** — notifications, video, QR and revenue only after privacy, service and cost decisions.
9. **FlutterFlow and final polish** — once APIs/data and core site are stable; include device, accessibility, backup and release checks.

### Cross-cutting test strategy

- Unit tests for validation, round generation, authorization and navigation contracts.
- PostgreSQL integration tests against a disposable local test database with Better Auth and current migrations. Report skipped tests as skipped, never passed.
- Empty-database migrations and representative upgrade paths; review any down migration that protects history.
- Concurrency tests for joins, transfers, signing limits, confirmations and role assignment.
- Permission matrix: anonymous, participant, nonparticipant, captain, league admin, Platform Admin and Super Admin.
- Invalid IDs/requests, duplicate requests, disputes/corrections, cancellations, completion, practice privacy, money privacy and append-only audit.
- Relevant syntax, static HTML/link/navigation, responsive/accessibility and `git diff --check` checks.
- Production checks only with approval and existing approved test records. Never run a migration or alter production data without explicit approval.

## Outstanding decisions

1. Official rule variants by category, break order, player selection, correction policy and dispute deadline.
2. Standings points/tiebreaks and incomplete, cancelled or deducted fixture treatment.
3. Public profile fields, opt-in/discoverability and ID scope.
4. Tournament entry, seeding, draws, withdrawal/refund and capacity rules.
5. Historic import format, provenance, review and duplicate reconciliation.
6. Backup retention, restore tests, incident ownership and Super Admin replacement process.
7. Email consent/preferences, weekly schedule and additional mailbox configuration.
8. Monetisation/legal model and payment provider before charging.
9. Video/social consent, moderation, retention and budget.
10. Exact current Render plan, auto-deploy and environment settings before release; not inspected here.

## Roadmap Maintenance Protocol

Whenever the project owner provides a new idea, requirement, correction or feature change, the next applicable Codex development instruction must also update `BREAK-DISH-MASTER-PLAN.md`.

1. Place the new idea in the most logical development section.
2. Preserve agreed requirements unless the owner changes them.
3. Record dependencies and important exclusions.
4. Avoid duplicate entries.
5. Clearly distinguish an idea from implemented functionality.
6. Update statuses after work is implemented, tested and deployed.
7. Record major decisions with dates.
8. Keep a short roadmap change history.
9. Never implement every idea immediately merely because it was added.
10. Do not push or deploy code changes without the required authorisation.

## Roadmap change history

- **17 Oct 2026** — Created the plan from the local repository, README, routes, migrations 001–011 and test definitions. Captured the owner-reported production migration 011/founder/recovery status, priorities, acceptance gates, decisions and expense tracker. No production access or feature/code changes were made.
