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
remain future work. Partial delivery and blocking expired lots were selected;
the exact expiration cutoff is a later eligibility decision. This unit adds no
endpoint, operator identity, expiry filter, stock mutation, or RabbitMQ flow.

Verification for this unit covers deterministic helper tests, Prisma
validation/generation, an offline schema SQL comparison, and structural review
of the custom check/triggers. No live migration or database check was run;
trigger/foreign-key behavior and concurrent dispensing still need authorized
runtime proof before service integration.
