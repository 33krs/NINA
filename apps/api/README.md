# API verification

## Local account password hashing foundation (not exposed)

The auth module provides a reusable password hash/verify foundation and an
unexposed account-schema foundation; it does not create account-management or
authentication routes. Accounts are NINA-managed with administrator-only
creation. The initial release is limited to fictitious patients. Roles are
explicitly assigned as `ADMIN`, `INSTRUCTOR`, or `STUDENT`; no administrator
clinical access, instructor-wide case access, or clinical identity linkage is
implied. Password inputs must contain 15–128 Unicode code points and no more
than 1,024 UTF-8 bytes. Inputs are used exactly as supplied: whitespace is not
trimmed and Unicode is not normalized.
Ill-formed UTF-16 surrogate sequences are rejected; valid paired Unicode is
preserved as supplied.

Hashes use a versioned canonical format with a random 16-byte salt and Node's
asynchronous scrypt implementation fixed at N=131,072, r=8, p=1, a 64-byte key,
and an explicit 192 MiB memory limit. The parser rejects unknown versions,
parameters, noncanonical base64url, oversized values, and malformed fields
before running scrypt. At most two derivations run concurrently, with up to 16
queued; additional work is rejected with a generic capacity error. Plaintext
passwords and stored hashes must not be logged.

This uses OWASP's documented scrypt alternative; OWASP prefers Argon2id for new
systems. See the [Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
and [Node.js `crypto.scrypt`](https://nodejs.org/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback).

Usernames are trimmed only at their outer whitespace and canonicalized to
lowercase ASCII; accepted names are 3–32 characters using letters, digits,
periods, underscores, or hyphens, and must start with a letter or digit. The
additive migration enforces the canonical form and nonnegative `authVersion`
with SQL checks that Prisma's schema DSL cannot represent. It has not been
applied to any database. No account rows, default credentials, or administrator
are seeded. `authVersion` is only groundwork for future revocation; no session
or authentication behavior is implemented here.

## Training-account PostgreSQL assertion SQL (import-only)

`scripts/training-accounts-postgres-sql.cjs` builds a bounded transaction that
asserts the training-account migration's constraints using a caller-provided
format-validated scrypt hash and UUID. It performs no database, filesystem, process,
or environment access. The generated SQL contains the hash for fixture inserts:
callers must not log the SQL or any input values. Its fixed checkpoint metadata
contains only stage names and expected SQLSTATEs. The synthetic tests inspect
the builder and existing migration text; they do not prove PostgreSQL runtime
behavior or connect to a database.

## Training-account PostgreSQL recovery foundation (import-only)

`scripts/verify-training-accounts-postgres.cjs` contains import-only recovery
helpers, not a command or database runner. It records only fixed stage/reason
codes, bounded process status, and allowlisted SQLSTATE/Node codes in a private
recovery manifest. Resource removal requires independent inspection of the
factory-created run identity, exact image ID, labels, and name; uncertain or
foreign resources retain the private evidence. Creation calls are tracked until
settled; cleanup waits for them before inspecting or removing resources. A pass
requires successful proof and confirmed cleanup. Cleanup executor calls receive
a fixed five-second bound and no proof-abort signal. Its tests use synthetic
executors only; they do not connect to PostgreSQL or invoke Docker.

The helper also accepts only the fixed `proof_sql` and `postgres_env` artifact
kinds, stored as `proof.sql` and `postgres.env` inside its factory-owned private
root. Content is bounded, written once to exclusive mode-0600 files, and never
copied into the metadata-only recovery manifest. The manifest records intent
before file creation and the created file's device/inode before content is
written; ambiguous writes, legacy unregistered files, replacements, links, or
foreign inventory retain recovery evidence. Version-one manifests reopen with
an empty artifact inventory and never adopt files by name. No cross-process
concurrency guarantee is made; this lifecycle does not read environment values
or create credentials, and its tests use synthetic content only.

`validatePreparedArtifacts(context)` is a read-only check for active prepared
fixtures. It revalidates the canonical private root and both complete registered
files, including mode, owner, link count, device, inode, and size, then returns
only the two fixed artifact paths. It refuses pending, finalizing, or already
completed recovery contexts and does not provide deletion authority.

## Training-account PostgreSQL fixture preparation (import-only)

Run `npm run build --workspace=@nina/api` before importing
`scripts/training-accounts-postgres-fixture.cjs`; it loads the compiled password
hasher, not TypeScript source. Preparation reads only the fixed account migration
and compiled helper. `readTrainingAccountMigration()` exposes the same bounded,
canonical-file-validated migration read without accepting a caller-supplied path.
The compiled helper executes from its validated source bytes with only its
`node:buffer` and `node:crypto` dependencies, rather than resolving through the
module cache. Preparation generates separate random synthetic account and database
credentials, and writes bounded SQL and PostgreSQL environment content through
the private recovery API. Its frozen result contains only generated names,
private artifact paths, and fixed assertion metadata. It does not start
PostgreSQL or Docker and never reads ambient environment configuration.

Scrypt work cannot be cancelled once started. Callers must await fixture
preparation to settle before beginning resource reconciliation or finalization;
this import-only helper does not establish cross-process concurrency safety.

## Training-account PostgreSQL command planning (import-only)

`scripts/training-accounts-postgres-plan.cjs` produces frozen argument arrays
for a fixed cached-image inspection, isolated network/container creation,
readiness check, and SQL assertion command. It accepts only a factory-owned
recovery context and the matching prepared fixture; it does not execute
commands or read environment variables. Before planning the bind mount, it
revalidates both complete private artifacts and their recorded file identities.
The container plan uses the fixed `postgres:15-alpine` reference only for image
inspection, then requires the recovery context's bound immutable image ID.
It requests an internal bridge, no host ports or persistent volumes, a
read-only root filesystem with bounded temporary filesystems, and a read-only
SQL bind mount. The entrypoint runs as root so it can initialize PostgreSQL's
temporary data directory; the assertion command also runs as root to read the
mode-0600 SQL mount and sets `PGPASSWORD` only inside the container process
environment. PostgreSQL host authentication is configured by the generated
fixture for SCRAM. These are planned arguments, not evidence that Docker,
image availability, mount permissions, initialization, or database assertions
have succeeded. The container flags follow the [Docker create CLI contract](https://docs.docker.com/reference/cli/docker/container/create/),
and the root-to-`postgres` initialization behavior comes from the
[official PostgreSQL image entrypoint](https://github.com/docker-library/postgres/blob/master/docker-entrypoint.sh).
Synthetic tests inspect the plan without invoking Docker.

`scripts/training-accounts-postgres-runtime.cjs` exports an import-only
`runTrainingAccountPostgresProof({ signal } = {})` entry point. It owns fixture
preparation, fixed `/usr/bin/docker` execution through the local daemon socket,
image and owned-resource observations, bounded readiness, authenticated TCP
server-version validation, exact SQL receipt parsing, and independent owned
resource cleanup. Child processes receive a small fixed environment; failed
stdout is never treated as proof, and recovery evidence is retained whenever
proof or cleanup is incomplete. Its VM tests use synthetic dependencies only:
they do not demonstrate Docker availability, a running PostgreSQL server, or
live database proof.

## Training-account PostgreSQL image observations (import-only)

`training-accounts-postgres-observations.cjs` validates bounded JSON returned
by the fixed `postgres:15-alpine` image inspection plan. It accepts only Linux
images for explicitly supported `amd64` and `arm64` architectures, a canonical
immutable image ID, the expected tag association, and PostgreSQL 15 startup
metadata (`PG_MAJOR`, `PG_VERSION`, `PGDATA`, entrypoint, command, and user).
The result contains only the immutable ID and safe version/architecture fields;
rejected observations use a fixed generic error. This confirms inspected tag
metadata association only. It does not establish publisher provenance or the
version of a running database server, and does not execute Docker.

Image `Config.User` may be omitted or explicitly empty; any other explicit value
is rejected. This image-metadata rule does not relax the separate container
isolation requirement that the actual container `Config.User` is exactly `0`.

The same module's `validateTrainingPostgresNetwork()` checks one bounded
network-inspection object against a factory-owned recovery context. It requires
the registered network ID/name, exact owner/run labels, an internal bridge,
and only the expected registered container membership for the requested
phase. The frozen result contains confirmation metadata, not resource-removal
authority. The recovery-state read API exposes persisted proof and cleanup
flags but not its transient finalizing flag; callers must serialize validation
against finalization rather than treating this validator as a finalization
lock. Synthetic tests do not prove a live daemon's inspection behavior.

`validateTrainingPostgresMounts(context, containerJson)` is the import-only
mount-specific check. It obtains the SQL source path from the private artifact
identity validator rather than accepting a caller path, then checks the exact
three tmpfs options and sole read-only SQL bind in planned and actual mount
inspection records. Its frozen response only confirms the mount contract; it
does not confirm the container identity or grant cleanup authority.

`validateTrainingPostgresIsolation()` composes that network check with the
read-only prepared-artifact identity/lifecycle check and one bounded container
inspection. It confirms the registered image, labels, runtime state, root-readonly
and non-privileged flags, internal-network attachment, unpublished ports, exact
tmpfs options, and the sole read-only SQL bind. It rejects actual named/anonymous
volume mounts and unrelated mounts while allowing the image's declared PGDATA
volume metadata. Its frozen result contains only fixed ownership and safety
metadata; it grants no cleanup authority and does not constitute live Docker
evidence. The caller must serialize inspection against recovery finalization.

The command planner also exposes fixed `inspect_network`,
`inspect_container`, and `server_version` operations. Resource inspection uses
one formatted JSON object for the ownership validators. The version probe uses
authenticated TCP to the owned container and bounds PostgreSQL statement and
lock time; it checks the server's numeric version rather than trusting image
metadata. `wait_ready` has both a bounded in-container retry loop and a bounded
client timeout. These are import-only plans and tests: they do not invoke Docker
or establish runtime isolation.

## Training-account PostgreSQL SQL receipts (import-only)

The assertion SQL emits one versioned, run-ID-bound text row only after each
successful top-level check or expected SQLSTATE rejection. Its final success
record follows both `ROLLBACK` and the post-rollback empty-table assertion.
`parseTrainingAccountSqlReceipt()` accepts only the exact 15-record order, fixed
checkpoint names/states, a zero numeric child exit status, and at most 8 KiB of
stdout. It returns frozen counts and fixed metadata without forwarding raw
output. The planned `psql` command uses quiet, tuples-only, unaligned output and
disables password prompting; it retains `ON_ERROR_STOP` and does not enable query
echoing. These import-only components structurally test the receipt protocol;
they do not establish PostgreSQL syntax, child-close, cleanup, or runtime proof.

Run the ordinary API checks with `npm --workspace @nina/api test` and
`npm --workspace @nina/api run lint`.

Pull requests and pushes to `feature/appointments` run the API checks and the
isolated PostgreSQL 15 regression suite in GitHub Actions. CI uses a temporary
hosted runner and pulls the test image there; the local suite below still
requires `postgres:15-alpine` to be present before running.

## Odontogram PostgreSQL 15 regression

Run `npm --workspace @nina/api run test:odontogram:postgres` to exercise the
real Prisma service and history migration against a temporary PostgreSQL 15
container. The runner uses only an already-cached `postgres:15-alpine` image;
it never pulls images or reads `.env` files or an ambient database URL.

The suite creates a uniquely labelled, per-run Docker bridge network with only
its PostgreSQL container attached, publishes an ephemeral host port only on
`127.0.0.1`, and keeps PostgreSQL data in container tmpfs. PostgreSQL trust
authentication is acceptable here only because unrelated containers are not
members of the dedicated network and the host binding is loopback; all records
are synthetic. The dedicated bridge permits outbound container traffic. The
network is not marked `--internal`: Docker did not expose the requested
loopback mapping from an internal network, and the host could not route to its
container IP. The runner verifies the exact container and network identities,
then removes only those owned resources in cleanup. It refuses to continue if
the image is absent, isolation checks fail, or cleanup cannot be asserted.

The migration test deploys predecessor migrations first, inserts one synthetic
legacy odontogram with a fixed timestamp, and then deploys the history
migration. The live Jest spec is gated by runner-created ownership evidence and
is not enabled by an arbitrary `DATABASE_URL`. The runner generates a separate
Prisma client from the copied temporary schema; its environment-file path stays
inside that temporary directory, where no `.env` file is created. Docker calls
have per-operation timeouts. If creation times out or a signal cancels the run,
cleanup reconciles only the unique per-run names with matching ownership labels
before deleting exact inspected IDs. Do not run the live spec directly against
another database.

The shared local subprocess runner trims successful decoded stdout by default.
An internal caller may set `preserveStdout: true` to receive that decoded string
unchanged, including whitespace and line endings; this does not promise raw-byte
preservation. The option must be a boolean and is captured once before spawning.
Nonzero exits, timeouts, cancellation, output bounds, and redacted error behavior
remain unchanged; failed-command stdout is never returned.

## Pharmacy partial-dispensing ledger

The additive dispensing migration records events (`PrescriptionDispensing`) for
a prescription and positive per-item/per-batch allocations
(`PrescriptionDispensingAllocation`). A prescription can have multiple events;
the unique event/item/batch tuple prevents duplicate lot rows within one event.
Indexes support prescription history and item/batch allocation lookups.

Database foreign keys require referenced records to exist and restrict their
deletion or identity changes while referenced. A SQL check requires allocation
quantity greater than zero. Row triggers reject ordinary `UPDATE` and `DELETE`
on both new tables. This is not administrator-proof protection: privileged
trigger bypass and `TRUNCATE` are not covered. The migration does not modify
existing records, prescription statuses, stock, or materialized counters, and
does not fabricate a legacy backfill.

`calculateDispensingBalance(prescribedQuantity, deliveredQuantities)` returns
`delivered` and `pending` for one item's **known, complete** allocation history.
It validates positive safe integers, rejects overdelivery without clamping,
and never mutates history. An empty complete history means zero delivered;
missing legacy history is not a complete history. In particular, an existing
`DISPENSED` prescription without ledger records has unknown delivery provenance,
not evidence of zero delivery or permission to dispense again.

Foreign keys and the pure balance helper do not enforce cross-record medication
matching, concurrent delivery limits, stock decreases or status transitions.
The internal service below owns those rules; Redis integration remains pending.
The ledger itself adds no endpoint, operator identity or RabbitMQ flow.

### Internal transactional dispensing

`PharmacyDispensingService.dispenseItem({ prescriptionId, itemId, quantity,
eventId })` delivers exactly one requested positive portion or rejects it.
The caller supplies a UUID event ID (matched as an exact, case-sensitive string)
and the medication is derived from the stored prescription item. Under the
operating contract that all deliveries are recorded in NINA, an empty `ISSUED`
ledger is complete zero history. Unknown imported history requires reconciliation;
there is no implicit import or backfill. New terminal-state deliveries reject.

A ReadCommitted Prisma transaction locks the prescription, validates complete
history across all its items, and locks medication batches in deterministic ID
order. Expiry is evaluated after acquiring batch locks. Conditional stock
decrements, event/allocations and prescription status commit together: partial
delivery stays `ISSUED`, and completion of every item becomes `DISPENSED`.
Prescription and batch row locks, not a Redis lease, own database serialization.

An exact successful event replay is allowed before terminal-state rejection and
returns recorded allocations without writes. Reusing an event ID for a different
prescription, item or quantity rejects; a concurrent global ID collision escapes
the transaction without blind retry. No historical balance snapshot is invented.
Mock tests verify orchestration and failure propagation, not PostgreSQL rollback
or concurrency. See the isolated database proof below. Redis runtime proof,
module registration and HTTP endpoints remain pending; neither service is yet
exposed by the application.

### Internal Redis admission facade (not registered)

`LockedPharmacyDispensingService` validates the request before Redis, then acquires
a prescription-scoped lease with a fresh owner UUID per attempt (not the event
UUID). The exact prescription ID is JSON-encoded without normalization. Busy
leases reject with 409; connection/command errors or unexpected replies reject
with a sanitized 503 before any transactional call. On acquisition, the facade
delegates once and preserves the exact transaction result or original error.

`PharmacyLockService` uses pharmacy-owned `PHARMACY_REDIS`, lazy coalesced connects,
bounded 1.5-second sockets/commands and `SET NX PX` with a ten-second lease. Its
explicit-URL factory reads no environment and never connects eagerly. Finally
release uses owner-checked Lua; an expired predecessor cannot delete a successor's
lease, and release failure logs only a fixed warning without masking the outcome.
Shutdown destroys only its opened client. Module/configuration/API registration
and actual Redis runtime proof remain pending. Dependency-double tests are not
live Redis evidence. PostgreSQL row locks, stock checks and event uniqueness remain
the correctness authority if a transaction outlives its Redis lease.

### Redis proof guard foundation (unwired)

`verify-pharmacy-redis-runtime.cjs` is import-only. It validates private0700/0600
owned canonical proof/config paths, exact authentication/persistence settings,
credential-bearing loopback URL and explicit Docker identity/network observations.
The contract requires one labelled Redis7 container, an unprivileged current UID,
readonly root/config, tmpfs data and no unrelated mounts or network members.
Privileged mode must be explicitly disabled.
Rejected values are never included in guard diagnostics.

It does not discover environment configuration, inspect Docker, import Redis or
load the compiled adapter. Fixture tests establish guard behavior, not live Redis
proof. A future owned orchestrator must obtain observations from the pinned local
socket before loading any client.

`verify-pharmacy-redis-lease.cjs` is an import-only assertion component. It accepts
explicit caller-owned client/service instances and a fixture key; it constructs
no client, loads no adapter and discovers no URL or environment configuration.
Assertions cover Redis7, NX/PX10000, owner-safe Lua, bounded natural expiry and
successor preservation. Its dependency-double tests do not establish live Redis
proof. Disposable orchestration and actual runtime execution remain unwired.

`verify-pharmacy-redis-scenarios.cjs` is the guarded scenario child, not an
orchestrator. Explicit run UUID/private proof arguments bind exact-ID observations
obtained internally through the pinned socket. Existing guards run before the
canonical compiled adapter is loaded or any client is created; only then does the
child delegate to the lease assertions with its owned instances. Finally destroys
all opened clients, including partial startup failures; CLI errors are generic.
The disposable runner invokes this child. VM startup tests are safety evidence,
not live Redis proof.

`pharmacy-redis-resource-identity.cjs` is an import-only context/observation
contract. It checks canonical private-root/run/image inputs, exact Redis resource
names/labels/image identity and target-specific absence errors. These predicates
neither inspect Docker nor grant removal authority. Its shared synthetic fixture
creates only an empty private directory and metadata, never authentication files.
Creation tracking and reconciliation use these contracts; actual runtime proof remains pending.

`pharmacy-redis-resources.cjs` supplies an opaque run/image/private-root tracker.
The future orchestrator wraps its bounded create operation with `captureCreation`
so uncertainty is registered before awaiting Docker output. Cleanup internally
inspects only exact known IDs or the fresh UUID-bound name through the pinned
socket, verifies Redis ownership/image identity and removes the container before
an empty owned network. Created/stopped fixtures are valid cleanup targets;
foreign members, ambiguous errors and unproved absence fail closed. Cleanup has
its own bounded deadline, independent of an aborted creation signal. Unit executor
doubles establish these state transitions, not disposable Docker cleanup proof.

### Disposable Redis verification

The import-only `pharmacy-redis-runner-fixture.cjs` prepares private authentication,
proof files and fixed creation arguments. It does not execute Docker, load clients
or grant connection authority; the orchestrator owns those guarded operations.

`npm run test:pharmacy:redis --workspace=@nina/api` builds the actual adapter and
runs `verify-pharmacy-redis.cjs --isolated`. Run it only with authorization for
fresh local disposable Redis resources and their own loopback connections.
The runner requires the pinned cached `redis:7-alpine` image; it never pulls.
Private0700 storage contains only two0600 files with fresh authentication/proof.
The owned UID/GID, readonly config/root, ephemeral data, dropped capabilities,
explicit loopback port and dedicated labelled network must pass existing guards
before readiness clients or the guarded scenario child can connect.

SIGINT/SIGTERM and deadlines settle bounded subprocesses before independent
ownership-checked cleanup. Overall PASS requires exact resource absence;
uncertain cleanup retains private recovery files and fails. No existing services,
ambient credentials, PostgreSQL, application configuration or endpoints are used.
The orchestrator's VM tests are not live proof: actual Redis7/ten-second expiry
and disposable cleanup still require a separately authorized real run.

### Calendar-date batch expiry

`isBatchExpired(expirationLabel, evaluationInstant)` is a pure policy helper.
Supply a real, canonical `YYYY-MM-DD` Gregorian label and a finite `Date` instant.
Four-digit proleptic Gregorian years include `0000`; malformed labels and
impossible dates are rejected rather than normalized.

A batch remains valid throughout its indicated date in `America/Santiago` and
expires only when the evaluation instant's local calendar date is later. The
helper uses explicit Gregorian/Latin-numbered ICU timezone data, not server
timezone, a fixed UTC offset, or a 24-hour duration. Clock changes may repeat
hours or skip midnight without changing this calendar-date rule.

The expiry predicate does not interpret stored timestamps or select stock.
`prepareEligibleBatches(batches, medicationId, evaluationInstant)` provides a pure
allocator-input projection for the confirmed calendar-date storage convention:
finite `Batch.expirationDate` values must encode a four-digit Gregorian date at
UTC midnight. Their UTC label is preserved, never shifted into Santiago's previous
date. Non-midnight, invalid and out-of-range timestamps are rejected, not repaired
or rewritten in the database.

The projection validates the evaluation instant even for empty input, medication
identities, and every relevant batch's ID, unique ID, safe nonnegative stock and
date encoding before filtering matching medication, positive stock and nonexpired
dates. Records belonging to other valid medication IDs are ignored without
examining their remaining fields. IDs are matched exactly, not trimmed or normalized.
Results preserve input order and clone dates; `allocateStock` handles chronological
ordering, ordinal-ID ties and insufficient-stock rejection. No stock is mutated.
The internal service composes this projection inside its locked transaction;
isolated runtime verification and application integration remain pending.

### Isolated PostgreSQL 15 ledger proof

For the real internal service baseline, run
`npm run test:pharmacy:dispensing:postgres --workspace=@nina/api`. It builds first
and selects a separate authenticated `pharmacy-dispensing` mode using the same
owned-resource lifecycle. A guarded child rechecks private proof/client paths,
datasource binding, exact resource labels/image/loopback mapping and sole network
membership before constructing real temporary Prisma clients. Direct and
transitive service imports bind only to that isolated generated client.

The baseline calls the actual compiled service for three requested portions,
checks partial/full status across two items and exact stock/history, and rejects
expired-only stock without mutation. It additionally proves exact replay after
terminal completion and rejects changed quantity/item/prescription keys, comparing
deterministic full-row snapshots of patients, medications, batches, prescriptions,
items, events and allocations after every call.

A fixture-only allocation trigger first checks that its transaction sees the
expected stock decrement, then raises `PHARMACY_PROOF_ROLLBACK_STOCK_VISIBLE`.
The actual service must propagate that marker and leave the complete snapshot
unchanged, with no failed event. Trigger/function cleanup runs in `finally`; their
absence and a successful retry using the same event ID prove recovery. The printed
baseline summary remains compatible with the shared runner and is emitted only
after these extra assertions pass.

The contention proof holds a real prescription or shared batch row lock while two
separate, single-connection clients call the actual service. It observes both
writer backend PID/start identities actively waiting in the expected `FOR UPDATE`
query, with blocker paths reaching the held backend (including soft queueing
through the peer). Only that observation releases the gate; polling is not timing
proof. Same-prescription requests cannot exceed pending quantity, and different
prescriptions cannot overdraw shared stock. Exact outcomes, recorded allocations,
stock, statuses and loser history are asserted. Observation has a three-second
deadline and monitor statements are bounded; fixture clients alone use a
15-second transaction timeout. Finally releases gates, settles launched work and
disconnects all clients. Concurrent identical requests also queue at the held
prescription row, then return identical recorded results with only one stock
decrement/event/allocation and terminal status. Different prescriptions sharing
one event UUID queue at the held batch after both absent replay lookups; stock is
sufficient for both requests. Exactly one native Prisma `P2002` rejection must
identify model `PrescriptionDispensing` and target `["id"]`. Only the winner's
delivery persists; the loser's stock decrement rolls back and its prescription,
items and history remain unchanged. Assertion/observer unit tests alone do not
prove database concurrency.
The suite does not expose an endpoint or use Redis.
Both existing modes remain available unchanged; never invoke the child directly
with an ambient datasource or bypass its runner-issued ownership checks.

Run `npm run test:pharmacy:postgres --workspace=@nina/api` with an already-cached
`postgres:15-alpine` image and local Docker. It reuses the owned-resource runner;
no arguments still selects the unchanged odontogram suite. Unknown arguments
fail before resource creation. No real or ambient database is used.

The pharmacy suite creates random database/user/password values, passes them in
an exclusive mode-0600 temporary env-file and uses SCRAM host authentication.
Passwords and the generated datasource are redacted from subprocess failures;
credentials never appear in argv or saved proof output. Temporary storage and
only exact inspected, labelled run-owned container/network IDs are cleaned up.
The dedicated bridge permits outbound traffic; the published host port is
loopback-only, data is tmpfs and image pulls remain disabled.

Predecessor migrations deploy first; synthetic ISSUED, DISPENSED and CANCELLED
prescriptions are snapshotted with quantities, stock and timestamps. After the
ledger migration, the snapshot must match and both ledger tables must be empty.
SQL scenarios check successful multiple events/default timestamps, four specific
FKs, zero/negative quantity checks, duplicate tuples, both tables' UPDATE/DELETE
triggers and referenced parents' DELETE/identity restrictions. Every rejection
checks its SQLSTATE/constraint (or exact trigger message) and unchanged history.
To prove the event-to-allocation FK separately from its masking append-only
trigger, only that trigger is disabled inside a rolled-back fixture transaction;
its restored guard is then checked again.

This proves migration constraints, not cross-medication/prescription matching,
expiry eligibility, service transactions, concurrency or administrator resistance.
The existing deterministic helper tests and offline Prisma checks remain useful;
run the isolated command before claiming live database proof.

## Training-account PostgreSQL proof command

Build the API before using this command so fixture preparation can load the
compiled password hasher. Help is inert; review the invocation before requesting
a separately authorized isolated run:

```sh
npm run build --workspace=@nina/api
npm run training-accounts:postgres --workspace=@nina/api -- --help
npm run training-accounts:postgres --workspace=@nina/api -- --run-isolated
```

Only the exact `--run-isolated` option starts the proof runtime. It uses the
cached PostgreSQL 15 image through the local Docker daemon, creates an isolated
synthetic-account fixture, and cleans up only resources its recovery checks
confirm as owned. Private proof credentials remain in private fixture artifacts;
command output is limited to fixed status and validated outcome booleans.
Incomplete proof or cleanup retains recovery evidence. The command does not
target an existing application database. Do not claim live proof unless the
separately authorized run completes with proof and owned cleanup both confirmed.
