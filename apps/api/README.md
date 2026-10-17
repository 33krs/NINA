# API verification

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
