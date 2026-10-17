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

The future dispensing service must enforce that each allocation's item belongs
to the event's prescription and that the item and batch reference the same
medication. These cross-record rules, concurrent per-item delivery limits,
stock decreases and prescription status transitions are not enforced by these
foreign keys or the pure balance helper. Redis locks and Prisma transactions
remain future work. Partial delivery and blocking expired lots were selected.
The ledger itself adds no
endpoint, operator identity, expiry filter, stock mutation, or RabbitMQ flow.

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

The helper does not interpret legacy `Batch.expirationDate` timestamps, filter
medications or stock, or persist dispensing. A future persistence adapter must
preserve the indicated calendar label explicitly; converting a UTC-midnight
label into Santiago time can incorrectly turn it into the previous date.
Service integration and transactional eligibility checks remain pending.

### Isolated PostgreSQL 15 ledger proof

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
