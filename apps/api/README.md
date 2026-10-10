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
