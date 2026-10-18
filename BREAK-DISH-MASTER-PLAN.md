# BREAK DISH Master Development Plan

**Roadmap owner:** BREAK DISH project owner
**Last reconciled:** 18 October 2026
**Scope:** Product and technical roadmap for the existing website, API and PostgreSQL application.

This is the project roadmap, not a claim that every listed capability is live. It was reconciled against the local repository, README, API routes, frontend pages, migrations 001–011 and available tests. Production notes are identified as **owner-reported** and dated; production and Render were not accessed for this update.

## Status meanings

- **Live / production verified** — production operation was explicitly confirmed by the owner or an authorized prior verification. The source/date of that evidence is stated; this update did not recheck production.
- **Implemented / awaiting production verification** — code, schema and/or tests exist locally, but the complete live journey has not been confirmed in production.
- **In development** — local implementation or testing is underway and is not necessarily deployed.
- **Planned** — agreed work that has not been implemented.
- **Future consideration** — an idea that needs a product, legal, cost or technical decision before becoming committed work.
- **Blocked / requires decision** — work cannot be safely specified or finished until the listed decision or prerequisite is settled.

## Current project snapshot

| Area | Status and evidence |
|---|---|
| Source control | **Verified locally / GitHub:** `main` and `origin/main` match `b5f906ee27ead8f1bd0cdaebdb91a820355ab2c7`, which contains the reviewed Match Centre security changes. Render deployment was not performed. |
| Website and API domains | **Live / production verified (owner-reported):** website `https://break-dish.com`, API `https://api.break-dish.com`. All 14 local HTML pages contain the shared API URL setting; local development still selects `http://localhost:3001`. Current Render dashboard configuration was not inspected. |
| PostgreSQL / schema | **Live / production verified (owner-reported, 17 Oct 2026):** Better Auth and BREAK DISH application migrations through 011 are applied. No production database was accessed for this plan. Local migration files 001–011 are present. |
| Super Admin assignments | **Live / production verified (owner-reported, 17 Oct 2026):** migration 011, Founder Super Admin and Recovery Super Admin assignments and audit records were verified. Maximum two active Super Admin accounts. |
| Match Engine | **Implemented locally / awaiting production verification:** SQL-backed matches, frame scoring, participant-specific score permissions, confirmation/dispute lifecycle, live list, polling and historic-results browsing exist. On 18 Oct the owner reported that the public Live Matches page loaded and showed the empty state; no score or production data changed. The local finalization permission fix now passes the full PostgreSQL-backed API suite. No actual in-progress match or complete production lifecycle has been verified. |
| Worktree | Before this roadmap update, tracked files were clean and `main` matched `origin/main`. This update changes only this plan; existing untracked diagnostic scripts, hero image, backups and portable tools remain excluded and untouched. |

## Current Priorities

1. **Verify deployment of the approved Match Centre security changes.** Commit `b5f906ee27ead8f1bd0cdaebdb91a820355ab2c7` is on `main` and `origin/main`; the complete local PostgreSQL-backed suite passed 42/42 with no skips. Render was not deployed. Separately approve and manually deploy the API and Static Site when ready; this commit changes both API code and `match.js`.
2. **Verify the deployed API and Static Site versions and API health** only after separate deployment approval. Do not run migrations or change production configuration as part of this check.
3. **Run controlled production Match Centre tests against existing approved records** after the approved changes are deployed and each data-changing action is explicitly authorized. The read-only Live Matches check on 18 Oct showed the expected empty state. An actual in-progress match and the complete production lifecycle remain unverified. Do not create synthetic competition data or run migrations as part of validation.
4. **Resolve any demonstrated defects and repeat affected checks.** Public viewing stays separate from score-editing authority; admin/referee/platform role status alone must not grant match-scoring permission.
5. **Build official standings from confirmed competitive results** only after result finalization and competition formats are specified. Practice and Money Match records must not leak into standings.
6. **Then complete the core league journey** around seasons, team/individual entries, fixtures, results and standings before investing in advanced tournament, social or mobile-app features.

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
**Recommended next task:** separately approve manual Render deployment of the already-pushed Match Centre security changes to the API and Static Site; verify deployed versions, then resume controlled production checks using an existing in-progress test match. Separately schedule an access-controlled recovery drill.
**Rules to preserve:** no HTTP route creates or changes Super Admin assignments; authority uses immutable user IDs; role history is append-only; platform roles never imply match participation.

## B. Match Centre and live match scoring

| Capability | Status | Current position and next evidence |
|---|---|---|
| Explicit match categories | **Implemented / awaiting production verification** | Migration 007 requires Team League, Singles League, Doubles League, Tournament/Flyer, Money Match or Practice Match. Official/practice separation is derived from category. |
| Scoreboard identity and category labels | **Partially implemented** | `match.js` and `live-matches.js` label the six stored categories. Match responses provide league, division, team/player, tournament and league-round fields. The scoreboard already shows sides, score, played/remaining frame counts, date/venue, elapsed timer, frame players and Dish/Counter Dish. The Live Matches list also shows event/category, sides, score, division/venue, current frame and timer. On the detailed scoreboard, league/division/round context is not consistently surfaced; tournament stage/round is not modelled; Practice is not yet marked prominently “PRACTICE / NON-COMPETITIVE”; Friendly Challenge is not a supported category; and a dedicated livestream/venue display is not implemented. |
| Scheduled fixtures and match detail | **Implemented / awaiting production verification** | Match creation, scheduling, editing/cancellation of eligible unstarted fixtures, detail pages and public reads exist. Team/Singles/Doubles constraints and approved doubles-entry snapshots are supported. |
| Live Matches hub and timer | **Implemented / awaiting production verification** | `/api/matches/live` filters `in_progress`; the page polls periodically and uses `started_at` as its elapsed-time source. Verify live response, scores, names, current-frame players and disappearance after a state transition in production. |
| Previous and completed matches | **Implemented / awaiting production verification** | Match Centre supports completed, read-only result review; Historic Results separately browses league → season → final results. Confirm deployed navigation and read-only controls. |
| Scoring permission | **Implemented / awaiting production verification** | Score changes are restricted to registered players belonging to a side in that specific match. Super Admin, Platform Admin, League Owner/Admin or Captain status alone grants no scoring rights. Keep an authenticated-viewer regression test and production permission matrix. |
| Frame players, score, Dish and Counter Dish | **Implemented / awaiting production verification** | Frame-result/event routes, eligible player selection, Dish and Counter Dish recording and audit records exist. Verify counts, player selection, corrections and persistence in a real match. The current scoreboard counts frames; a separate set counter is not implemented or defined. |
| Result confirmation, disputes and finalization | **Implemented and locally tested / awaiting production verification** | Confirmation is recorded for a match side; `confirmed_by` records the acting player or authorised side representative. Retraction is side-based, restricted in the API and database to an authorised representative of that side, and append-only audited; the detail API supplies the viewer's retractable sides and the UI hides unavailable actions. The model permits an eligible side representative to retract even if a different person originally confirmed. Disputes may be raised by a match participant and resolved through the authorized API, but organiser dispute resolution is not a complete interface. Finalization is restricted locally to an eligible match participant or explicitly authorised organiser scoped to the match's competition; both confirmations, complete frames and resolved-dispute checks remain enforced. An appointed Money Match Admin can view and finalize only the private match assigned to them. Concurrent finalization is serialized by a match row lock; simultaneous requests are regression-tested to yield one transition and one audit event. |
| Live updates | **Implemented / awaiting production verification** | Browser polling is used; push/WebSocket updates are not implemented and are not required for initial validation. |
| Mobile scoring ergonomics | **Planned** | Verify a venue-sized scoreboard works without routine scoring controls scrolling off-screen; check touch targets, current-frame clarity and duplicate submissions. Source inspection alone does not prove layout. |
| Breaker nomination/alternation, undo, winner popup and highlights | **Planned** | Define rule configuration, audit semantics and completion UX first. Corrections must remain auditable and must not delete history. |
| Full production match lifecycle | **Partially verified / awaiting production verification** | Owner-reported read-only check on 18 Oct: the public Live Matches page loaded and displayed “No matches are currently in progress”; no production data changed. Still test an actual existing in-progress match, authorized and unrelated viewers, frame/player selection, Dish/Counter Dish, timer, confirmation/retraction, dispute/resolution, permission-checked finalization, audit history and Previous Matches read-only review. Use existing approved test records only; no synthetic data. |

**Dependencies:** owner-reported production migrations through 011; existing test league and match; eligible player accounts; permission to make any test score changes; deployed frontend/API versions. The repository does not contain the test league or account identifiers, and this update did not inspect production.
**Acceptance:** live endpoint includes only in-progress matches; score/timer/participants are correct; only that match’s players can mutate; changes persist and audit; confirmations complete the result; completed matches are read-only and move from Live to Previous.
**Decision:** settle official rule variations (break order, correction/undo policy and dispute deadline) before automating them.

**Scoreboard identity requirements (planned; no redesign in this stage):** every display must name the competition and matchup from authoritative records, consistently across detailed desktop/mobile pages, the Live Matches list, future livestream graphics and venue displays. Team League identity includes league, division and fixture/round details; Singles League includes league and player names; Doubles League includes league and both partnerships; Tournament/Flyer includes event, stage and round; Money Match carries a clear Money Match label; Practice carries a prominent **PRACTICE / NON-COMPETITIVE** label; Friendly Challenge must be visibly separate from official categories if that product type is approved. Preserve the existing score and elapsed-time foundation, Dish/Counter Dish events, frame totals and venue usability. Add set counters only after the relevant format rules define them. Acceptance requires correct labels for every category, no inferred/fabricated context, readable responsive pages and separate livestream/venue layouts using the same canonical data.

**Spectator-only scoreboard and selection confidentiality (implemented locally; pending release verification):** signed-out visitors and signed-in viewers without the relevant match capability receive a read-only scoreboard. It presents authoritative match category/competition context, teams or players, current score and status, active timer, current-frame participants, completed-frame winners/events, and other public match information. A scheduled fixture is explicitly labelled **Scheduled** and must not look live. Spectator output contains no player selectors, score/Dish/Counter Dish forms, Start, confirmation/retraction, dispute, finalization or other mutation controls; explain read-only access in text rather than showing disabled editor controls. Upcoming frames may be listed, but their player selections and selection-linked events must be omitted from public and non-operating-viewer API responses and interfaces until that frame becomes current or a future explicit publication policy authorizes visibility. During an active match, eligible match operators may view and manage unfinished-frame selections through authenticated, viewer-scoped detail, mutation and audit responses where existing match rules allow; organiser status alone does not qualify. The current implementation has no separate spectator publish/reveal state, so the safe public default is to keep selections hidden until the frame is current; completed-frame participants and results remain visible for history. API-computed capabilities govern every control. Match-specific participants retain only their permitted scoring operations; a competition organiser's finalization or confirmation permission does not confer scoring rights. Platform/referee roles alone grant no score-editing capability. Keep current/previous/upcoming frame context and publicly approved statistics legible on phones, tablets, desktop and venue displays. During the later scoreboard redesign, give the two competing sides visually distinct, accessible colors for their respective controls and labels; do not rely on color alone. This requirement does not authorize the championship redesign now.

**Owner's handwritten spectator scoreboard layout reference (planned future UI enhancement; separate from the spectator security protections above):** present authoritative competition and match details at the top, followed immediately by a prominent match timer, then clear team names and overall score. Show current-frame participants, previous-frame players/winners/results, and upcoming frames only when player information is permitted and officially published. Keep the presentation spectator-focused and free of editing controls, with visually distinct accessible team-side colors. If technically reliable, show each completed frame's elapsed duration from authoritative frame-start and frame-end timestamps; first verify that timestamps exist and have suitable semantics before promising this display. Preserve responsive layouts for phone, tablet, desktop, livestream and venue displays. This is a later presentation enhancement, not a change to the already implemented local read-only security behavior.

**Configurable shootouts (planned; rules and permissions must be specified before implementation):** after all scheduled frames finish level in a competition configured to require a winner, present a confirmation prompt and **Continue to Shootout** action. Use a dedicated, permission-checked interface to record participating players and each pot/miss attempt, with complete audit history. Preserve the original frame score; represent the outcome explicitly, for example **Team A 5–5 Team B — Team A Won by Shootout**. Award only the normal match-win league points, with no shootout bonus. Configure attempts per team and sudden death where relevant. Define rule variants, attempt order, completion and correction policy before implementation; do not assume one universal governing-body procedure. Shootout events must remain distinct from frame scoring and must not alter the match's original frame score.

**Competitor research (planned):** review publicly visible CueScore, LeagueRepublic and Challonge capabilities for live match display, competition administration, results/history, tournament progression, product limitations and pricing. Record useful patterns and UK 8-ball-specific opportunities without copying brand, text, assets or code. Findings need independent verification and a dated source log before they inform product or pricing decisions.

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
| Draw and shootout configuration | **Planned** | At League, Flyer and Tournament creation, organisers choose whether drawn matches are permitted. If draws are disallowed, they may configure a shootout as the tie-break: attempts/length per team and sudden-death behavior must be configurable, not fixed to Best of 5. Validate that every competition requiring a winner has a complete tie-break procedure. Define and approve the applicable shootout rules before implementation; do not assume one universal governing-body procedure. |

**Global website search (planned):** provide a mobile-friendly search control beside the burger navigation on main pages. Search public players, teams, leagues, tournaments, fixtures, matches, venues, community posts and official rules. Include predictive suggestions and grouped result categories. Enforce each resource's visibility and authorization on the server; private matches, member-only information and unpublished content must not leak through suggestions, counts or result metadata. No global search endpoint or UI is claimed as implemented.

**Elite championship design direction (planned; not implemented):** use a flat, professional event presentation with subtle borders, limited shadows, Inter, Outfit or Plus Jakarta Sans typography, crisp tabular scoreboard numbers and consistent responsive dashboards. Proposed championship colors: background `#0F1115` to `#161922`; championship blue `#1E3A8A` / `#2563EB`; prestige gold `#D97706` / `#F59E0B`; UK pool crimson `#991B1B`; UK pool mustard `#CA8A04`. Preserve the existing BREAK DISH logo and core brand; these colors are a championship direction, not a replacement for the site palette. Apply the previously approved centered oversized page headings and centered Live Matches introduction/explanation/empty state where appropriate, plus authoritative category and competition identity on scoreboards. Keep the exact layout and colors subject to later visual review; do not redesign in this stage. Detailed event format and championship-specific references/acceptance criteria still need the owner's brief.

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

### Rules Hub and officiating (planned; owner catalogue recorded, source verification pending)

| Capability | Status | Current position and dependency |
|---|---|---|
| Authoritative Rules Hub with 28-game catalogue | **Planned / candidate catalogue supplied** | The full owner-supplied catalogue is preserved below. Governing-body mappings are candidates only, not independently verified authorities. Verify each publisher, applicable rules, edition, effective date, source and publication rights before displaying rule content. |
| Searchable rules, incident lookup and rule assistant | **Planned** | Search game/ruleset names, rule headings and ordinary-language descriptions; provide a searchable section selector that jumps directly to a rule. Show full verified text only where rights permit, with official source links and version details. An optional “Describe What Happened” assistant must answer from cited evidence and give exact rule references. Distinguish official, historical and local rules. |
| Rule updates and version history | **Planned** | Monitor governing-body changes, but require human source verification before publication. Preserve historical versions and effective dates; do not silently replace the rule in force for a past match. |
| Referee status, assignment permissions and Referee Centre | **Planned** | Support self-declared and verified referee status; organiser-approved, match-scoped assignments; shot clocks, match clocks, timeouts and warnings; referee match controls and incident reports; quick access to relevant official rules; and auditable referee actions. A referee role or assignment alone must not grant general score editing, finalization or administrator permissions. No Referee Centre or referee schema/API is currently implemented. |

**Owner-supplied 28-game catalogue — candidate mappings, not verified authority**

“Popular” is the owner's category label and is not a statistically verified popularity ranking. The names and candidate bodies below must be verified against authoritative sources before rules are published.

**Category 1 — Popular Games**

1. 8-Ball (Standard / WPA Rules) — WPA, CSI, BCAPL
2. 9-Ball — WPA, Matchroom Pool, CSI
3. 10-Ball — WPA, CSI
4. Snooker (Standard 15-Red) — WPBSA, IBSF
5. Straight Pool (14.1 Continuous) — WPA, BCA
6. Three-Cushion Billiards (Carom) — UMB, USBA

**Category 2 — Regional, Niche and Traditional Games**

7. International 8-Ball (International Rules) — IEPF, EPA, Ultimate Pool
8. Blackball — WPA, Blackball International, World Blackball Federation
9. One Pocket — CSI / BCA
10. Bank Pool — CSI / BCA
11. Straight Rail (Carom) — UMB, CEB
12. Balkline & Cadet (Carom) — UMB, CEB
13. Artistic Billiards (Carom) — UMB, CEB
14. Cushion Carom — UMB
15. Four-Ball (Sanguine / Carom) — UMB / ACBC
16. Six-Red Snooker — IBSF, WPBSA
17. Snooker Plus — Historical / WPBSA
18. English Billiards — WPBSA, IBSF, World Billiards Ltd
19. Russian Pyramid — IPC
20. Kaisa (Finnish Billiards) — Suomen Biljardiliitto
21. Chinese Pool (Chinese 8-Ball) — CBSA, WPA
22. Killer Pool / Elimination — Traditional / Pub Rules
23. Rotation Pool — BCA / CSI
24. Baseball Pocket Billiards — BCA / CSI
25. Cowboy Pool — BCA / CSI
26. Bottled Pool / Kelly Pool — Traditional / Regional club rules
27. Chicago (Pocket Billiards) — Traditional / Regional club rules
28. Trifecta / Multi-Game Pool — Organiser-defined formats

**Acceptance gates:** independently verify all 28 entries and candidate sources; resolve conflicting rules and local variations with dated citations; confirm publication rights; test search, section jumping and incident lookup against representative cases; validate assistant citations; verify update review, version history, assignment scope and revocation; prove referee status does not bypass match-specific scoring permissions. Build only after source, rights and permission decisions are settled. No rule ingestion or Rules Hub implementation is included in this roadmap reconciliation.

## E. Player profiles, teams and statistics

| Capability | Status | Current position |
|---|---|---|
| Private member profile | **Implemented / awaiting production verification** | Account page and authenticated endpoints support existing fields only: display name, location and biography; API enforces self-edit. |
| Public player/team pages | **Planned** | Homepage reports that directories are not published. Decide privacy, consent, discoverability, moderation and whether IDs are global or league-scoped before release. |
| Histories and statistics | **Partially implemented** | Match/frame records and separated practice/competitive views exist; public histories, head-to-head and complete career aggregates are incomplete. |
| Shootout statistics | **Planned** | A separate player-profile section should aggregate shootout attempts, pots, misses and pot percentage from audited shootout records. Keep these distinct from frame and competitive match statistics, and define correction/void handling before calculation. |
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

**Status: Blocked / requires owner, legal, accounting and cost decisions before payments; models are future consideration.** No subscription, payment processing, paid feature restriction, payout or prize-money custody is implemented. Money Match acknowledgements only record manual agreement.

### Owner-supplied commercial research proposals — not approved prices

| Proposal | Owner-supplied illustration | Status |
|---|---:|---|
| Community | Free | Proposed baseline; requires entitlement and cost review. |
| Player Pro Pass | £2.99/month or £26.91/year | Unapproved research proposal. |
| One-off tournament or league-season creation pass | £19.99 | Unapproved one-off proposal; exact scope and season rules need definition. |
| Organiser Pro | £24.99/month or £224.91/year | Unapproved research proposal. |
| Enterprise / Venue | Illustrative £699/year or custom pricing | Illustrative only; not a quote or approved price. |
| Annual subscription discount | Proposed 25% | Unapproved; confirm calculation, cancellation and refund treatment before any offer. |
| Registration commission | Proposed 1% for Organiser Pro to 3% for free-tier organisers | Unapproved; provider fees, tax, refunds, chargebacks and commission base must be modelled first. |
| Optional livestream overlay micro-pass | Price not supplied | Idea only; test demand, delivery/support cost and whether this belongs in a subscription. |
| Sponsorship, advertising and featured equipment partnerships | No price supplied | Future revenue ideas; require disclosure, suitability and editorial/conflict policies. |

Do not display these figures as live prices, commitments, quotes, forecasts, current charges or actual expenses. The proposed annual subscription figures equal 25% less than twelve months at the supplied monthly amounts, but that arithmetic does not approve the offer. Confirm feature entitlements and test willingness to pay before setting prices. Keep ordinary player access, fixtures, basic scoring and results free unless the owner explicitly decides otherwise. Assess whether premium analytics, advanced organiser tools, venue services and broadcasting deliver enough value to justify recurring charges without fragmenting the core competition experience.

### International pricing research

GBP is the proposed pricing baseline. The supplied rate assumption of £1 = $1.33 = €1.19 is illustrative research only, and some supplied USD/EUR suggestions do not follow it consistently. Do not publish those conversions or present them as accurate prices. If regional pricing is later required, recompute from verified exchange rates with a recorded source/date, currency-specific rounding policy, local tax treatment and an explicit regional pricing decision. Do not assume a mechanical conversion alone produces an appropriate market price.

### Payments, legal and financial compliance dependency

No payment integration or financial launch may proceed until this checklist is researched, independently reviewed where appropriate and accepted by the owner:

- Assess Stripe Connect suitability, supported countries, product fit and current fees; compare alternatives only if there is a concrete need. Stripe Connect must not be described as automatically providing regulated escrow.
- Define seller/organiser onboarding, identity verification, eligibility, account support and responsibility for disputes.
- Specify subscription billing, any trial period, renewal notices, cancellation, refunds, failed payments, chargebacks and support procedures.
- Verify webhook signatures, idempotency and duplicate/replayed-event handling; reconcile provider events, application records, commissions and payouts.
- Define secure payment-record minimisation, access controls, audit history, retention and reconciliation procedures. Do not store card details in BREAK DISH.
- Document organiser payouts and commission calculation, including the fee base, refunds, reversals, taxes, provider fees and accounting treatment.
- Obtain advice on VAT for UK/EU digital services and potential sales-tax obligations in other markets. Analyse UK Digital Services Tax separately; it is not ordinary subscription VAT.
- Review data protection, privacy notices, consumer rights, subscription disclosures and applicable cancellation/refund obligations before selling.
- Obtain independent legal advice on skill competitions, tournament entry fees, prizes, money matches and any jurisdiction-specific gambling or prize restrictions.
- Obtain independent legal and accounting review before financial launch. Prize-money custody or escrow requires explicit provider support and legal approval; do not hold or describe funds as escrow without both.

**Payment acceptance gates:** owner-approved prices and entitlements; documented provider and fee decision; legal/accounting review; privacy and consumer terms; verified test-mode billing and webhooks; reconciliation and refund/chargeback runbooks; operational support capacity; and explicit launch approval. No live payment or production financial test is authorized by adding this roadmap entry.

### Evidence-based go-to-market stages

| Stage | Proposed approach | Release gate |
|---|---|---|
| A. Free UK local-league beta | Controlled real-world use; collect player, captain and organiser feedback; measure reliability, support demand and match/result correction rates. | Core account-to-league-to-match lifecycle is stable, permission-tested and supportable. No paid service is required. |
| B. Optional commercial pilot | Consider a limited pilot only after stable core functionality and after proposed pricing, feature entitlements, support capacity and billing controls are explicitly approved. | Owner approval plus the payment/compliance checklist above and a tested cancellation/refund/reconciliation process. |
| C. Online competition registration and organiser payments | Add entry registration and payment services only after legal, financial, provider and operational checks; distinguish entry fees, platform commission, prizes and payouts. | Verified provider flow, seller onboarding, webhook/reconciliation controls, clear consumer terms and approved prize handling. |
| D. Wider UK, European and international expansion | Expand when relevant disciplines/rulesets, currencies, customer support and jurisdictional compliance are ready. | Evidence of demand and readiness for each market; verified regional prices/tax treatment, rules sources, provider coverage and support. |

Gemini's suggested months 1–3, 4–6, 7–10 and 11+ are retained only as illustrative research, not committed delivery dates. Use evidence-based acceptance gates rather than promising calendar deadlines.

**Dated competitor pricing benchmark (owner-supplied screenshots, 18 Oct 2026; not independently verified):** LeagueRepublic was shown at Small £13.60/month (up to 25 teams), Medium £23.20/month (up to 100 teams), Large £46.40/month (up to 300 teams), and XL £68.30/month (more than 300 teams); advertised registration transaction fee 1% excluding Stripe fees; SMS bundles starting at £5.70 per 100 messages. Source for re-checking: [LeagueRepublic pricing](https://www.leaguerepublic.com/pricing.html). These are competitor figures only, not BREAK DISH prices, costs or charges. Reverify before business decisions. They are not actual project expenses and do not replace the expense tracker; record only verified BREAK DISH payments separately from estimates and future costs.

**Tracking:** Completed: no payments or paid league registration are implemented; the owner supplied unapproved pricing/revenue proposals and an illustrative rollout for research. Remaining: decide entitlements and free-core boundaries; validate demand, pricing and provider fees; complete legal/accounting/compliance gates; determine support capacity and market readiness. Production testing: none until a payment design is approved. Dependencies: stable core platform, fund flow, refunds, reconciliation, taxes, terms and provider assessment. Next task: continue the free UK beta and collect evidence; schedule business/legal review before designing payment integration.

**Financial-record boundary:** proposed subscription prices, commission and potential revenue are not expenses or verified payments. Keep them out of `BREAK-DISH-EXPENSES.md`; record actual payments, estimates and future costs there only under its existing evidence rules. No speculative charge or revenue has been added to the expense tracker.

## K. FlutterFlow mobile app

**Status: Planned after website functionality and APIs stabilize.** At the beginning of this stage, remind the owner to create the FlutterFlow account using the designated project-owner email; confirm the address privately at that stage.

Reuse the authenticated API and canonical data; plan app-specific navigation, offline/error behavior, permissions, Android/iOS device testing, store review, publication accounts and costs. Do not assume FlutterFlow or store publishing is free. **Acceptance:** shared account/league/match data, server-side authorization, real-device scoreboard testing and no duplicated competition system.
**Tracking:** Completed: website/API is the intended shared foundation; no FlutterFlow app is implemented. Remaining: app design/build and store release. Production testing: device/API conformance begins after implementation. Dependencies: stable APIs, app-store accounts, FlutterFlow plan and budget. Next task at app-stage start: remind the owner to create the account with the privately confirmed project-owner email, then scope one mobile journey.

## L. Final polish and launch readiness

**Status: Planned after core functionality is reliable.** Preserve the premium dark, burgundy, gold and cream identity. Schedule visual polish after core league and match flows.

**Approved layout requirements for the later visual pass:** centre oversized page hero headings horizontally where appropriate while keeping their current font sizes; centre their introductory descriptions and related buttons beneath them. On `live-matches.html`, centre “LIVE MATCHES” with its introduction, centre “ON THE TABLE. RIGHT NOW.”, and place the explanation directly below that heading. Centre the explanation and put “No matches are currently in progress” beneath it. Reduce unnecessary empty space while preserving readable desktop, tablet and mobile layouts. Apply the same principles to other pages where appropriate. Do not implement these changes during functional/security work.

**Owner-recorded future direction, not yet scoped or implemented:** Rules Hub and its owner-supplied 28-game catalogue, referee status/assignment workflow and Referee Centre, CueScore/LeagueRepublic/Challonge research, global website search, and elite championship design direction. Section D preserves the catalogue and candidate mappings, which still require independent authority/source and publication-rights verification. Section B records competitor research; Sections C and L record the championship and centered-layout direction. Do not claim these features exist or treat candidate sources as verified.

Checklist: responsive desktop/tablet/mobile; accessible keyboard/focus/contrast/touch targets; performance/SEO; security and privacy/terms review; backup/restore drill; monitoring; email deliverability; production browser tests; incident/support owner; release and rollback procedure. A page or code path alone does not satisfy a launch item.
**Tracking:** Completed: existing visual identity and responsive UI foundation. Remaining: final polish and launch checklist evidence. Production testing: browser, accessibility, performance, backup/recovery and security checks must be recorded. Dependencies: stable core workflows and current service configuration. Next task: defer major polish until match/league workflows pass their acceptance gates.

## Recommended delivery sequence and acceptance gates

1. **Local Match Centre security review — complete locally** — participant/organizer finalization, side-based retraction, role separation, error states and concurrent transitions passed the PostgreSQL-backed suite (42/42, no skips reported for that run).
2. **Deploy the approved release only after separate authorization** — commit `b5f906ee27ead8f1bd0cdaebdb91a820355ab2c7` is on `origin/main`; it contains API authorization changes and `match.js` UI behavior. Deploy the API and Static Site manually when approved; the push itself was not a deployment.
3. **Verify deployment readiness and deployed API/frontend versions** — only after separate approval; check API health and release identity without running migrations.
4. **Controlled production Match Centre lifecycle** — the immediate product-validation priority after the approved changes are deployed and only with explicit authorization for concrete actions. The read-only Live Matches empty-state check passed by owner report on 18 Oct; test an actual existing in-progress match, participant-only scoring, frame players, score and Dish/Counter Dish changes, timer, confirmations/retraction, dispute resolution, permission-checked finalization, audit history and Previous Matches read-only review. Record deployed SHAs/results; use only approved existing records; no synthetic data or migrations.
5. **Stabilize results** — fix proven defects; maintain PostgreSQL integration and authorization tests. Gate: final result/audit is consistent and only eligible participants can score.
6. **Standings** — define points/tiebreaks; calculate from canonical finalized team fixtures. Test incomplete/cancelled/disputed results and exclude practice/money.
7. **League formats and player selection** — define Team/Singles/Doubles/individual rules, entries, attendance, captain workflow and random selection. UI/API/database must agree.
8. **Rules Hub and Referee Centre specification** — verify the owner-supplied 28-game catalogue and source authorities, publication rights and rule precedence, then define search, incident lookup, versioning, referee status and scoped assignment permissions.
9. **Profiles and statistics** — decide privacy and compute histories/head-to-head/rankings from canonical results; prove competitive/practice separation.
10. **Tournament operations** — define registration, seeds, draw formats, progression, withdrawals and disputes; preserve the recorded elite championship visual direction and obtain its detailed event brief.
11. **Historic import and administration** — specify file provenance and implement Super Admin-only preview/import with immutable audit; reject all other roles at API/database boundaries.
12. **Communications, advanced options, FlutterFlow and final polish** — proceed only after core dependencies and acceptance gates; include privacy, cost, device, accessibility, backup and release checks.

### Cross-cutting test strategy

- Unit tests for validation, round generation, authorization and navigation contracts.
- PostgreSQL integration tests against a disposable local test database with Better Auth and current migrations. Report skipped tests as skipped, never passed.
- Empty-database migrations and representative upgrade paths; review any down migration that protects history.
- Concurrency tests for joins, transfers, signing limits, confirmations, finalization and role assignment.
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
8. Monetisation, approved entitlements/pricing, legal and accounting review, regional taxes and payment provider before charging.
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
- **18 Oct 2026** — Recorded the owner-reported read-only Live Matches check (page loaded, empty state, no data changes), local finalization authorization and side-level confirmation behavior, remaining production lifecycle checks, and later visual-polish requirements. Added the complete owner-supplied 28-game catalogue with an explicit candidate-source verification warning; Rules Hub search, incident lookup, citations, human-reviewed updates and version history; Referee Centre scope and audit requirements; global search; elite championship color/style direction; and a dated, owner-supplied LeagueRepublic competitor-price benchmark kept separate from BREAK DISH expenses and pricing. The local PostgreSQL-backed suite was reported as 42/42 passing on a disposable temporary database; no production access, migration or deployment was performed for the roadmap update.
- **18 Oct 2026** — Updated source-control and release status after Match Centre security commit `b5f906ee27ead8f1bd0cdaebdb91a820355ab2c7` was pushed to `origin/main`; Render remains undeployed. Added owner-supplied subscription, commission and venue-pricing ideas explicitly as unapproved research proposals; retained GBP as the baseline and marked the supplied FX rates as illustrative/inconsistent. Added payment-provider, tax, consumer, privacy, competition/prize, payout, webhook and independent legal/accounting gates, plus evidence-based UK beta-to-international rollout stages. Preserved free core access as the current direction, left the expense tracker unchanged and did not add speculative costs or revenue. No application code, production data, migrations, commit or deployment was changed/performed for this documentation update.
- **18 Oct 2026** — Added owner-approved configurable draw/shootout requirements to competition setup, Match Centre and player statistics, including configurable attempts/sudden death, unchanged frame scores, normal win points only, auditability and an explicit rules-definition gate. Recorded the handwritten spectator scoreboard presentation order and conditional per-frame duration as future UI work, distinct from the existing local spectator security protections. No shootout or visual feature was implemented.
