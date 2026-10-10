# Clinical Module Base — Step 4

## Objective
Implement the first NestJS clinical vertical slice: PatientsModule and FamilyModule with CRUD endpoints backed by Prisma.

## Scope
- Add Prisma service integration to the API.
- Add patient and family DTOs, services, controllers, and modules.
- Register both modules in AppModule.
- Preserve existing health endpoint.
- Add focused unit tests for service behavior where the existing test runner supports it.

## Constraints
- Keep artifacts and source code in English.
- Do not alter unrelated domain models.
- Use Prisma as the persistence boundary.

## Delivery Strategy
- Forecast: approximately 473 authored changed lines for the Step 4 implementation, excluding lockfile and task-document lines.
- Strategy: `exception-ok` for this change only; the user explicitly authorized ignoring the 400-line limit.
- Chain strategy: not applicable for this one-time size exception. This does not authorize pushing or opening a PR.

## Checklist
- [x] T4.1 Prisma integration and module wiring
- [x] T4.2 Patient CRUD
- [x] T4.3 Family CRUD
- [x] T4.4 Focused service tests and verification attempts recorded

## Acceptance Criteria
- API exposes CRUD routes for patients and families.
- DTO validation is explicit and invalid input is rejected.
- Prisma client is injectable and disconnected resources are not leaked.
- Existing health endpoint remains available.

## Checks
- `npm run build`
- `npm run lint`
- `npm run test --workspace=@nina/api -- --runInBand`

## Progress
- Route: delegated direct (multi-file NestJS feature implementation).
- Status: T4.1–T4.4 implemented; build, lint, and API tests pass on `fix/eslint9-and-git-workflow`.
- Added Prisma lifecycle management, global DTO validation, patient/family CRUD endpoints, and mocked service tests.
- Focused test-first evidence: tests initially failed because the services were absent; after implementation, all 6 focused tests passed.
- Verification: `npm run build` passed; `npm run lint` passed; `npm run test --workspace=@nina/api -- --runInBand` passed (2 suites, 6 tests); `git diff --check` passed.
- Commit: pending native review requirements; implementation will be recorded on `fix/eslint9-and-git-workflow`.
- No unrelated Prisma models were changed; the existing `GET /` health route remains registered.

## Next Step
Complete native review and commit the verified Step 4 and lint workflow changes.
