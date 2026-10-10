# Odontogram History Delivery

This change adds backend-managed version history to patient odontograms. The work is split into two dependent pull requests so persistence and HTTP behavior can be reviewed independently.

## Review order

```text
feature/appointments
└── feature/odontogram-history (draft tracker; do not merge)
    └── feature/odontogram-history-01-persistence
        └── feature/odontogram-history-02-api
```

1. **Persistence** — adds an integer version to each current odontogram, append-only snapshots, a version-zero baseline for existing rows, and transactional write/read-history behavior.
2. **HTTP API** — exposes `GET` and `PUT /patients/:patientId/odontogram` plus `GET /patients/:patientId/odontogram/history`, with UUID, payload, and bounded pagination validation.

Review each child against its immediate parent. Keep the tracker draft until both child changes are reviewed and integrated; do not merge it as a substitute for either implementation PR.

## Behavior and boundaries

- Every accepted replacement appends a full-state snapshot, including identical submissions.
- Current-state mutation and snapshot insertion share one transaction; per-patient locking serializes version allocation.
- Existing current states become version zero. Previously overwritten states cannot be reconstructed.
- History is append-only application history, not a privileged-user-proof audit ledger. Authentication and actor identity are outside this change.
- Automated tests use database doubles. Applying the migration and proving PostgreSQL concurrency and rollback remain deployment/verification work.

## Verification

API service and HTTP tests, the non-live API suite, lint, build, and Prisma format/generate/validate passed during implementation. No database migration was applied.
