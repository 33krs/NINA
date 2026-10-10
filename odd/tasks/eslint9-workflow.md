# ESLint 9 and Git Workflow

## Objective
Make the root lint command run real ESLint 9 checks across workspaces and establish a usable branch/commit workflow.

## Scope
- Configure ESLint 9 flat config for the API, frontend, and shared packages.
- Ensure each workspace lint script works with its installed framework/tooling.
- Make root `npm run lint` execute those checks and fail when checks fail.
- Confirm Git branch creation and a conventional work-unit commit work in the authorized workspace.

## Constraints
- Preserve existing Step 4 uncommitted implementation.
- Do not commit unrelated generated or local state such as `.atl/` or `.codegraph/`.
- Do not add AI attribution to commit messages.

## Delivery Strategy
- Forecast: approximately 64 authored source/manifest lines for the lint and tooling work; the separate Step 4 feature is tracked in `clinical-module-base.md`.
- Strategy: `ask-on-risk` (default); this task is below the 400-line threshold, so no chain strategy is needed for its own commit.

## Checklist
- [x] T1 Add/repair ESLint 9 flat configuration and dependencies.
- [x] T2 Wire workspace and root lint commands.
- [x] T3 Run lint/build/tests and record outcomes.
- [ ] T4 Commit the scoped feature changes with a Conventional Commit (deferred to parent; worker must not commit).

## Acceptance Criteria
- `npm run lint` invokes ESLint and exits non-zero on lint violations.
- API lint script no longer fails because flat config is missing.
- Frontend lint uses a command supported by its installed Next.js version.
- Git branch exists and a conventional commit records only intended project changes.

## Progress
- Route: delegated direct for multi-file lint configuration; branch created inline first.
- Branch: `fix/eslint9-and-git-workflow`.
- Status: T1–T3 implemented and verified; this supporting lint fix will be included with the verified Step 4 work-unit commit under the user's one-time size exception.

## Implementation
- Added one ESLint 9 flat config entry point per API, frontend, and UI workspace, each reusing `@nina/config-eslint`.
- Made the shared preset's actual runtime imports explicit (`@eslint/js`, `eslint`, `eslint-config-prettier`, `@typescript-eslint/parser`, and `@typescript-eslint/eslint-plugin`) and retained the existing parser/plugin dependencies.
- Updated API lint to target its existing `src/**/*.ts` tree and frontend lint to run ESLint directly because this Next.js 15 version does not provide the legacy `next lint` command.
- Root `lint` remains `turbo lint`, which discovers and invokes each workspace's `lint` script; Turbo's `lint` task is present.
- Preserved pre-existing Step 4 edits in the API manifest and lockfile; only changed the API lint script in its manifest. No commit was created.
- Scoped readonly CommonJS globals to `apps/frontend/eslint.config.js` in its flat config, and replaced `React.ReactNode` with an explicit type-only `ReactNode` import.

## Verification status
- `npm run lint` passed (3 Turbo tasks); `npm run build` passed (2 Turbo tasks); `npm run test --workspace=@nina/api -- --runInBand` passed (2 suites, 6 tests); `git diff --check` passed.
- Root `npm test -- --runInBand` is not defined; API tests were run through the API workspace script.
- `npm install --package-lock-only --ignore-scripts --offline` could not update the lockfile because `typescript-eslint` was not cached; switched to the already-declared parser/plugin pair and updated the workspace lock metadata directly. No new tarballs were required.
- Runtime compatibility is confirmed by the passing root lint and build commands above.

## Next Step
Parent: finish native review requirements, commit intended files, and record the commit identity.
