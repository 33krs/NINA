## Objective
Rename NINA's default branch from `feature/appointments` to `main` without losing integration history or interrupting CI.

## Problem and rationale
The current default name looks like a feature branch. CI push filters and README refer to that name; the local branch was stale and must not be used as the rename source.

## Scope and constraints
- Prepare on latest verified remote default, not stale local branch.
- First transition slice: support pushes to both old and new names; preserve unfiltered pull_request trigger; update API README. Keep job/check names stable.
- Preserve historical branch references in docs and task records.
- Then integrate transition, verify protections/open PR bases, rename remote default using only account 33krs, update local tracking refs explicitly.
- Preserve unrelated dirty .gitignore and task files; no force pushes or deletes.

## Tasks
- [x] DBR-1: Verify post-PR94 remote default commit and inspect live protections/open PR bases (branch protection inspected; rulesets not checked).
- [ ] DBR-2: Prepare CI/README transition on current default lineage and verify. Implementation and focused local checks complete; parent work-unit commit and review remain pending.
- [ ] DBR-3: Integrate transition under human-controlled PR/merge policy.
- [ ] DBR-4: Rename hosted default to main; verify CI, protections, open PRs, and remote HEAD.
- [ ] DBR-5: Reconcile local main/upstream and explicitly handle stale old tracking branches.

## Acceptance and checks
- Existing feature/appointments pushes and all PRs continue to trigger API CI during transition.
- After rename, main pushes trigger API CI.
- Hosted default is main and historical commits are preserved.
- Local dirty/untracked user state remains unchanged.
- Record unavailable checks honestly; do not claim protection/live PR state from local Git refs.

## Delivery strategy
Ask-on-risk; one focused transition PR before hosted rename. No direct-main edits. Push/PR/merge are distinct human-controlled decisions.

## Progress and evidence
- DBR-1 verified by the parent through authenticated read-only GitHub API evidence: PR94 is merged; hosted default remains `feature/appointments`; current tip is `a4d93aef226444c09b78cc6bd667cacd6cd5329e`; the open-PR list is empty, so no open PR base requires migration at this observation.
- The branch-protection endpoint returned HTTP 404 with “Branch not protected.” Repository rulesets were not checked; do not infer that no ruleset applies. Recheck applicable controls before the hosted rename.
- DBR-2 started on `chore/rename-default-branch` at verified tip `a4d93aef226444c09b78cc6bd667cacd6cd5329e`, not on the stale local default branch.
- Allowed DBR-2 edits: `.github/workflows/api-ci.yml`, `apps/api/README.md`, and this tracker only. Add `main` alongside `feature/appointments` in the push filter; preserve all pull-request triggering, job/check names, and historical references.
- Unrelated modified `.gitignore` and pre-existing untracked task files must remain untouched.
- The prior Engram mirror (#1466, topic `odd/default-branch-rename/tasks`) contained only a summary, not the full tracker, and had pending contested observations. Preserve that recovery state; a full mirror and exact readback are required before further source work.

## Routing and work-unit boundary
- DBR-1: inline parent read-only API inspection; no source mutation.
- DBR-2: delegated direct to one writer because preparation and changes span CI configuration and README. Forecast: fewer than 100 authored changed lines including tracker updates; implementation changes are one push-filter addition and one README sentence.
- DBR-3 through DBR-5: pending; hosted rename, remote mutation, local tracking cleanup, and historical document changes are outside this writer's authorization.
- Work-unit commit, native assessment/review, and any remote delivery belong to the parent. No commit has been made for DBR-2; its checkbox remains open.

## Verification
- Focused Python textual regression check: observed RED before the source change (exit 1: expected `main` missing); observed GREEN after the source change (exit 0). Against base `a4d93aef226444c09b78cc6bd667cacd6cd5329e`, exact workflow comparison proves only `main` was added to `push.branches`, with unfiltered PR triggering and all job/check bytes unchanged; the README describes both names and all PRs.
- `git diff --check`: passed after source edits; rerun after final tracker synchronization.
- Full API tests/build and hosted CI are not run for this trigger/documentation-only transition; local textual proof cannot prove hosted execution after rename.
- Mirror status: the full tracker was saved to #1466 and exact content readback succeeded before source edits. Final updated tracker save/readback must also match. Original pending contested-observation relations were preserved; the new relation to the prior session summary was classified as related, not superseding historical context.

## Next step
Parent: verify the focused transition diff, complete applicable review and the DBR-2 work-unit commit, and record its identity before checking off DBR-2. Integration, ruleset inspection, hosted rename, and local tracking reconciliation remain pending.
