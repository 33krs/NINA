# Appointment Reservation — Step 5

Four local functional slices are committed and independently verified on the appointment feature chain. Root lint/build, 80 API tests, and two actual Redis/PostgreSQL acceptance cases passed. Native review remains pending unavailable selection capture; no push, PR, merge, or approval is claimed.

## Objective and scope
Reserve an exact professional/time slot safely before PostgreSQL persistence, following RAYEN_AUTONOMOUS_PLAN.md:279–281.
- Register AppointmentsModule and `POST /appointments` with patientId, professionalId, startTime, endTime, and required current enum status.
- Acquire an atomic Redis ownership-token lease before a Prisma transaction.
- Return 409 for lock contention or confirmed exact-slot uniqueness collisions.
- Keep deterministic HTTP coverage separate from actual local-service acceptance.
- Reconcile Step 4 and ESLint records with existing local commit `dbb59da`.

## Constraints and authorization
- English artifacts; one bounded writer; preserve unrelated `.atl/` and `.codegraph/` state.
- No remote Git or remote credential operations, commits, or native review/lifecycle commands in this handoff. Parent owns commit/review.
- No schema changes, partial-overlap, cancellation-reuse, availability, default-status, or professional-identity policies.
- Historical implementation scope: appointments module subtree, API AppModule/package manifest, root lockfile, and the three named task documents. Current preparation edits only `reserve-appointment.dto.spec.ts`, `appointment-lock.service.spec.ts`, `appointments.http.spec.ts` in that subtree and this document; production is unchanged.
- Prior candidate review remains pending unavailable collection; no approval or push is claimed.

## Delivery strategy
- Original forecast: approximately 350 authored lines, excluding lockfile.
- Historical revised forecast: approximately 900 candidate lines including tests and task records; historical count recorded below. Production module is 223 lines; original safety/HTTP/live coverage was 548 lines. Do not remove safety or compress tests to meet the heuristic.
- Strategy: auto-chain; chain strategy: local-only feature-branch-chain, explicitly confirmed by the user. No remote publication or merge is authorized; Step 4's exception does not apply here.
- User direction: respect the approximately 400-line budget as far as possible; no Step 5 size exception is granted.
- One read-only slicing pass proposes four behavior/test/documentation units: validated request contract (278–348 authored lines), ownership-safe Redis provider (215–267), complete reservation endpoint (401–409), and live acceptance with isolated cleanup (294–314). Estimates include scaffolding and documentation churn, exclude generated lockfile, and are not measured rewritten diffs or intermediate verification.
- Chain branches: feature/appointments (tracker at dbb59da), feature/appointments-01-contract, feature/appointments-02-locking, feature/appointments-03-reservation, feature/appointments-04-acceptance. Each child depends on its immediate predecessor. Preserve request-path safety assertions; measure each real commit diff before delivery.
- Active branch: `feature/appointments-04-acceptance`; tracker remains at `dbb59da`, without merging into default/original branches. Original implementation branch: `fix/eslint9-and-git-workflow`.
- Step 5 functional commits: ccad10b, ddbd97f, 7e22883, cdd2d68. Historical writer handoffs did not stage/commit; parent created these after exact-tree verification.
- S1 exact-tree verification: c0416e236000d512d17511258a8f7dbfc45b4b43 exported independently; API lint/build passed, 35 tests passed (3 suites); parent repeated tests successfully. Shared installed dependencies, not clean-install proof. Commit pending; future endpoint/provider files excluded from this evidence.
- S2 exact-tree verification: 07771c1ca3f018f6ef45410785b3b8eea1fbdd3e independently exported; API lint/build and 46 tests (4 suites) passed, parent repeated tests. Only DTO/provider suites present; installed Redis 6.3.0 matches manifest/lock, no clean-install/live proof. Commit pending.
- S3 exact-tree verification: 2e7447cb644d057bb28427e84fea548301ccb03a exported independently; API lint/build and 68 tests (5 suites) passed, parent repeated tests with authorized local sockets. Endpoint HTTP suite present, live suite absent; no clean-install/live-service proof. Commit pending.
- S4 exact-tree verification: 005d373197dea754a1471126e3be44693964792a exported independently; root lint (3 uncached tasks), API/Next root build, 80 API tests and 14 opt-in tests (12 regressions + 2 actual localhost acceptance) passed. Parent repeated 80 tests. Real 201/409, one stored row and fixture cleanup verified; shared deps, not clean-install proof. Commit pending.

## Tasks
- [x] S1 Contract committed as ccad10b: 274 authored lines; exact-tree API lint/build and 35 tests passed. Native review handoff unavailable (required external selection capture absent); no approval claimed.
- [x] S2 Locking committed as ddbd97f: 273 authored / 359 raw lines; exact-tree API lint/build and 46 tests passed. Native review selection handoff unavailable; no approval claimed.
- [x] S3 Reservation committed as 7e22883: 388 authored/raw lines; exact-tree API lint/build and 68 tests passed, preserving all request-path safety assertions. Native review handoff unavailable; no approval claimed.
- [x] S4 Acceptance committed as cdd2d68: 267 authored/raw lines; root lint/build, 80 tests and 14 opt-in cases passed (12 cleanup regressions, 2 actual-service tests). Native review handoff unavailable; no approval claimed.
- [x] T5.1 Implement exact-slot reservation and Redis ownership-safe locking with deterministic tests.
- [x] T5.2 Functional verification, reconciliation and local chain commits complete, including parent spot checks and actual-service concurrency. Native review remains separately pending and does not have an approval receipt.

## Implementation and limits
| Topic | Behavior / limitation |
| --- | --- |
| Request | Patient UUID, nonblank professional string (max 128), required PENDING/CONFIRMED/CANCELLED; unknown fields rejected by existing global ValidationPipe. No professional entity is invented. |
| Datetimes | Strict ISO calendar date, explicit Z or numeric offset, seconds and at most three fractional digits; unknown `-00:00` offset rejected. Normalize to Date and UTC ISO keys; end must be strictly after start. Millisecond precision matches current PostgreSQL columns. |
| Lease | Unique random UUID per attempt; `SET key owner NX PX 10000` before `$transaction`. Keys encode professionalId and normalized start/end, not patient/status. Ten-second TTL is a bounded contention lease, not an exclusivity guarantee after expiry. |
| Redis failures | Return generic 503 without starting the transaction. Offline queue disabled, 1.5-second connection/socket/command bounds, no automatic reconnect loop; lazy reconnect attempted by a later request. Unexpected acquisition replies also fail closed. |
| Persistence | Patient existence checked inside the Prisma transaction before create; missing patient returns 404. Existing unique professionalId/startTime/endTime constraint is final safety after lease expiry, eviction, or Redis restart. |
| Collision mapping | Only typed Prisma P2002 with the exact three-field target and compatible Appointment model metadata becomes 409; unrelated/unknown errors become generic 500, without internal messages. |
| Release | Owner-checked atomic Lua compare/delete supports repository Redis 7. Release errors are sanitized warnings and cannot replace durable success or the original domain failure; TTL bounds leftovers. |
| Lifecycle | One shared lazy connection attempt; `onModuleDestroy` destroys an open client, verified on app.close. Existing bootstrap does not enable Nest signal shutdown hooks; graceful hosts must call app.close or enable hooks. No out-of-scope bootstrap edit. |
| Domain limits | Exact intervals only; partial overlaps remain allowed. CANCELLED rows still occupy the unique slot. No authentication, professional lookup, schedule rules, or lease renewal is added. |
| Patient integrity | Appointment has no patient relation/FK. Existence validation cannot prevent an orphan if a patient is concurrently deleted or later removed; fixing that requires a separately authorized schema/policy change. |

## Routing and test-first evidence
- T5.1: delegated direct bounded writer; multi-file logic and write preparation. This handoff is the writer; no second writer was launched.
- T5.2: writer foreground checks and separate opt-in live acceptance; parent independent checks remain pending.
- RED: `npm run test --workspace=@nina/api -- --runInBand appointments.http.spec.ts -t 'reserves through'` exited 1 before implementation: expected HTTP 201, actual 404 for the absent endpoint.
- First sandbox attempt failed on loopback `listen EPERM`; approved rerun produced the meaningful RED above, not an environmental RED claim.
- GREEN: `npm run test --workspace=@nina/api -- --runInBand appointments.http.spec.ts` exited 0: initially 19, then 23 tests. After formatting/refactoring the full API command passed.
- skill_resolution: paths-injected; loaded the exact supplied TypeScript, work-unit-commits, and cognitive-doc-design skills before task-specific work.
- CodeGraph status/explore preceded broad code mapping; no index initialization or administrative command was needed.

## Prepared local slice boundaries
Chain: tracker `dbb59da` → S1 contract → S2 locking → S3 endpoint → S4 acceptance. The following are exact per-slice file allowlists for the parent, not evidence of staging or commits. This document may receive progress-only updates in S2–S4; those future additions/deletions must be counted in each real slice.
- S1: `apps/api/src/modules/appointments/reserve-appointment.dto.ts`, `apps/api/src/modules/appointments/reserve-appointment.dto.spec.ts`, `odd/tasks/clinical-module-base.md`, `odd/tasks/eslint9-workflow.md`, `odd/tasks/appointment-reservation.md`.
- S2: `apps/api/src/modules/appointments/appointment-lock.service.ts`, `apps/api/src/modules/appointments/appointment-lock.service.spec.ts`, `apps/api/package.json`, `package-lock.json`, `odd/tasks/appointment-reservation.md`.
- S3: `apps/api/src/modules/appointments/appointments.controller.ts`, `apps/api/src/modules/appointments/appointments.service.ts`, `apps/api/src/modules/appointments/appointments.module.ts`, `apps/api/src/modules/appointments/appointments.http.spec.ts`, `apps/api/src/app.module.ts`, `odd/tasks/appointment-reservation.md`.
- S4: `apps/api/src/modules/appointments/appointments.live.spec.ts`, `odd/tasks/appointment-reservation.md`.

| Slice | Prepared authored additions + deletions | Exact intermediate-tree verification |
| --- | --- | --- |
| S1 | 36 DTO + 71 DTO tests + 12 prior-record reconciliation + 154 task document = 273 | Pending; focused DTO suite and existing patient/family suites, lint/build, diff check. |
| S2 | 72 provider + 197 provider tests + 1 manifest = 270; generated lockfile excluded | Pending; accumulated S1/S2 suites, dependency/lock consistency, lint/build, diff check. |
| S3 | 115 controller/service/module + 267 HTTP tests + 3 AppModule = 385 | Pending; accumulated suites including all HTTP assertions, lint/build, diff check. |
| S4 | 264 live/cleanup tests | Pending; full default checks, then separately authorized local-service acceptance. |

Counts include current documentation in S1 and manifest in S2; later tracker churn is not yet authored. These are prepared file-boundary counts against `dbb59da`, not verified commit diffs. Recompute additions plus deletions on each exact staged tree. Keep the cohesive endpoint even if tracker updates take it slightly over 400; no further slicing loops or test removal. Rollback each child only after its successors; retain prior-record reconciliation independently.

## Slice preparation verification (full worktree only)
- Test-first exception: behavior already exists and production was not edited. New/extracted suites passed against unchanged production; no RED is invented. DTO tests supplement, never replace, HTTP global-pipe validation. Equal datetime boundaries are valid DTO syntax; the retained HTTP tests verify service interval ordering.
- DTO suite: 29 cases covering UUID, professional type/nonblank/128-character bound, required current enum, strict calendars, explicit offsets, and one-to-three fractional digits. Provider suite: 11 cases covering NX/PX, command bounds, contention, unexpected replies, SET failure, shared failed/retried connection, in-flight coalescing, owner/successor release, cleanup outcomes, and Nest app.close dispatch. Provider tests are 197 lines rather than the suggested 130–170 to retain explicit safety evidence and fully typed command doubles without compression.
- HTTP suite: only its provider lifecycle case and now-unused import moved. Byte comparison against the worker-entry file proves all remaining HTTP contents unchanged, including successor-owner, global-pipe input rejection, concurrency, collision mapping, and cleanup/output assertions. HTTP now has 22 cases; the moved lifecycle case initializes a real Nest application and calls app.close without opening a listener.
- `npm run lint`: exit 0, 3 tasks (API executed, 2 cached). `npm run build`: exit 0, 2 tasks (API executed, frontend cached).
- `npm run test --workspace=@nina/api -- --runInBand`: first sandbox run failed solely on loopback listen EPERM (22 HTTP failures); sanctioned localhost rerun exit 0, 6 suites / 80 passed / 2 opt-in live skipped. The focused new suites initially passed 39 cases; strengthened owner/coalescing coverage raises their combined count to 40.
- `git diff --check`: exit 0; final no-index checks cover the untracked allowed files as well. This run did not repeat actual Redis/PostgreSQL acceptance; the historical evidence below is separate.
- skill_resolution: paths-injected; loaded supplied TypeScript, work-unit-commits, chained-pr, and cognitive-doc-design files. Route: one bounded delegated writer; no second writer, Git mutation, install, remote credential access, or native review operation. Index hash is unchanged from worker entry.
- Parent must independently verify exact staged trees without later dirty files influencing tests. S1–S4 remain unchecked; historical full-candidate results below do not discharge intermediate checks.

## PRIOR implementation verification results

These results predate the cleanup correction; they are not correction rerun claims. PRIOR independent verification also observed 29 deterministic tests + 2 live tests and cached lint/build.
| Foreground command | Observed final result |
| --- | --- |
| `npm run lint` | Exit 0, 3 Turbo tasks. Initial exit 1: new Node globals were absent from existing ESLint globals; fixed with explicit process import and globalThis.fetch binding, without changing shared lint config. |
| `npm run build` | Exit 0, 2 Turbo tasks; frontend reused cached proof, API built. |
| `npm run test --workspace=@nina/api -- --runInBand` | Exit 0, 3 passed suites / 29 passed tests; separate live suite intentionally skipped (2 tests) in this default run. |
| `git diff --check` | Exit 0; final readback includes allowed new module files. |
| `./node_modules/.bin/prisma format` in apps/api | Exit 0. Schema SHA-256 before/after unchanged: `4ef7e1ae1569bb57a8389adf38ceb25a553d6f9c37c466165bf140442604d5fb`. |
| `DATABASE_URL=postgresql://localhost:5432/nina_db ./node_modules/.bin/prisma validate` in apps/api | Exit 0. Dummy local URL is only for schema validation; no migration or schema change. |
| `NINA_APPOINTMENTS_LIVE_TESTS=1 npm run test --workspace=@nina/api -- --runInBand appointments.live.spec.ts` | Exit 0, 2 actual-service tests, including rerun after normalization. |

The first Prisma invocation used an incorrect root CLI path and returned 127; rerun used the installed workspace CLI successfully. The initial PostgreSQL preflight from root could not resolve workspace Prisma; the corrected API-workspace preflight exited 0. Neither attempt changed data/schema.

## Cleanup reliability correction
- Scope: only this record and `apps/api/src/modules/appointments/appointments.live.spec.ts`; no production/schema edits, installs, remote operations, commits, or native review commands.
- Root cause: shared cleanup try/finally skipped later Redis owners/database actions on rejection; shutdown failures also skipped successor shutdown actions or replaced earlier errors.
- Shared cleanup now sequentially attempts both owner releases, each scoped database deletion/assertion, app.close, conditional Redis destroy, and Prisma disconnect independently. After every eligible attempt it throws AggregateError containing the original unknown values in order. UUID scopes, created/readiness guards, and shutdown order are retained.
- Regression: 12 deterministic tests outside opt-in exercise the same helper used by afterAll: every individual failure, simultaneous failures (including undefined rejection), guards, and success. No second writer was launched.
- Meaningful RED: focused default spec exited 1 with 10 failed / 2 passed / 2 live skipped using the extracted original shared try/finally; failures showed skipped successors and unaggregated errors, not service/environment failure.
- GREEN: focused default spec exited 0 with 12 passed / 2 live skipped before formatting; full default and live checks below passed after formatting.
- skill_resolution: paths-injected; read both supplied TypeScript and cognitive-doc-design skill files before edits.

| Correction foreground command | Observed result |
| --- | --- |
| `npm run lint` | Exit 0; API executed, frontend/UI reused Turbo cache (2/3 cached). |
| `npm run build` | Exit 0; API executed, frontend reused Turbo cache (1/2 cached). |
| `npm run test --workspace=@nina/api -- --runInBand` | Initial sandbox exit 1: 23 HTTP tests failed on localhost listen EPERM; approved localhost-only rerun exit 0, 4 suites / 41 deterministic tests passed, 2 opt-in live tests skipped. |
| `NINA_APPOINTMENTS_LIVE_TESTS=1 npm run test --workspace=@nina/api -- --runInBand appointments.live.spec.ts` | Approved localhost-only run exit 0, 14 tests passed: 12 deterministic cleanup regressions + 2 actual-service acceptance tests. |
| `git diff --check` | Exit 0; intended untracked spec/document also checked using no-index diff. |

- Historical limits: failure injections are deterministic doubles, not deliberate damage to actual Redis/PostgreSQL. Actual-service acceptance separately passed. Delivery/commit remained unchecked at correction time; the user has since selected the local feature-branch-chain above.

## Separate actual-service acceptance
- Approved localhost-only probes found both 6379 and 5432 reachable. Read-only PostgreSQL preflight confirmed the existing exact unique index; no schema was created or migrated.
- Opt-in `appointments.live.spec.ts` uses only localhost Compose development connections, UUID-isolated fixtures, and owner-scoped Redis keys. It does not consume ambient remote URLs.
- Concurrent real HTTP requests returned one 201 and one 409; actual PostgreSQL held exactly one row. A later duplicate returned 409 after Redis release, exercising the real Prisma uniqueness error.
- Actual Redis PTTL was positive and at most 10000 ms; forcing expiry of only the test key, acquiring a successor, and running old-owner Lua release preserved the successor.
- Fixture-only cleanup deleted the created appointment/patient and verified both absent. No existing rows, infrastructure, or schemas were modified.
- Deterministic HTTP tests use dependency doubles and do NOT prove actual Redis/PostgreSQL behavior; the two opt-in tests above provide separate local-service evidence.
- Not tested: production failover/restart, kill signals, or a real ten-second transaction overrun. Database exact uniqueness is the final safety boundary, not a claim that Redis remains exclusive after expiration.

## Dependencies and sources
- Added official `redis@6.3.0` (`^6.3.0`) and its five transitive packages using npm; manifest and lockfile are generated consistently. No hand-edited tarball hashes.
- Initial install exited 1 on sandbox EAI_AGAIN; approved network escalation exited 0. HTTP/live commands also required approved local socket access.
- Tradeoff: official typed client and lifecycle support add six packages; no handwritten Redis protocol. Single-instance lease is sufficient for contention reduction because existing PostgreSQL uniqueness owns durable exact-slot safety, not Redis consensus.
- Official primary sources consulted: [SET NX/PX](https://redis.io/docs/latest/commands/set/), [owner-checked release and lease limits](https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/), [node-redis connection lifecycle](https://redis.io/docs/latest/develop/clients/nodejs/connect/).

## Acceptance and outstanding work
- [x] Valid interval/status/timezone and normalized Date keys.
- [x] Atomic expiring acquisition before transaction, safe owner release, fail-closed failures.
- [x] Only confirmed exact-slot persistence collisions map to 409.
- [x] Deterministic concurrent HTTP and separate actual Redis/PostgreSQL acceptance.
- [x] Patient existence validation; unchanged schema and documented integrity limits.
- [x] Existing health route available; patient/family modules remain registered and their six tests pass.
- [x] Step 4 commit `dbb59da` reconciled; ESLint T4 marked committed; prior review pending unavailable collection, no push.
- [x] Parent exact intermediate-tree checks and S1–S4 functional commits; each slice is below 400 authored lines, with tests/docs kept alongside behavior.
- [ ] Native review: cumulative assessment is medium, due for slice_budget_reached. Canonical STATUS requires external.select_intended_untracked, absent from this runtime; no START, candidate consent, reviewer result, acknowledgement, or receipt. Unrelated local .atl/.codegraph files remain excluded per user choice; no JSON payload was invented.

## Changed paths and size
- New `apps/api/src/modules/appointments/{appointment-lock.service,appointment-lock.service.spec,appointments.controller,appointments.service,appointments.module,reserve-appointment.dto,reserve-appointment.dto.spec,appointments.http.spec,appointments.live.spec}.ts`.
- Updated `apps/api/src/app.module.ts`, `apps/api/package.json`, `package-lock.json`, `odd/tasks/appointment-reservation.md`, `odd/tasks/clinical-module-base.md`, `odd/tasks/eslint9-workflow.md`.
- Historical authored whole candidate count before slice preparation: 907 additions + deletions, excluding `package-lock.json`, generated files, `.atl/`, and `.codegraph/`; computed from tracked worktree diffs plus the original seven untracked appointment files and this entire task document. Source/tests/manifest: 775; documentation: 132 (then recorded as 120 lines here). No files were staged or committed. This exceeded the 400-line heuristic; the user subsequently selected the local chain, not a whole-candidate exception.
- Historical prepared boundaries totaled 1192 authored additions + deletions before verification records: S1 273, S2 270, S3 385, S4 264. Four functional commits actually total 1202 authored lines: S1 274, S2 273, S3 388, S4 267. Generated lockfile adds 86 lines, so raw commit churn is 1288. A separate passive closure-document commit records the last commit identity and final state; count its diff within the S4 delivery boundary.
- Rollback boundary: the new appointments subtree, AppModule import/registration, Redis manifest/lock additions, and this Step 5 document; prior task-record reconciliations describe existing history and need not be reverted.

## Final local chain boundaries
| Slice | Parent | Commit | Authored / raw lines | Cumulative test proof |
| --- | --- | --- | --- | --- |
| S1 Contract | dbb59da | ccad10b | 274 / 274 | API lint/build, 35 tests |
| S2 Redis locking | ccad10b | ddbd97f | 273 / 359 | API lint/build, 46 tests |
| S3 Reservation | ddbd97f | 7e22883 | 388 / 388 | API lint/build, 68 tests |
| S4 Acceptance | 7e22883 | cdd2d68 + closure docs | 295 / 295 including passive closure | Root lint/build, 80 tests, 14 opt-in cases |
Closure documentation changes do not mutate verified source. Independent exports share installed dependencies, so clean-install reproduction is not claimed. Functional snapshot checks are separate from native review, never substitute reviewer evidence.

## Next step
Resolve the unavailable native selection capture before claiming review closure. The next documented feature is Step 6 encounter recording, a separate implementation unit. Keep the local chain unmerged/unpublished unless the user explicitly authorizes delivery. Production failover, signal shutdown, real lease-overrun, and clean-install checks remain untested as documented above.
