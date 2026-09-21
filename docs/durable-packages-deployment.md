# Durable API packages and automatic evidence records

## What this ships

The existing portfolio page now submits 1–50 reviewed API entries to an atomic
package RPC. It persists membership, regulatory runs and title research scopes in
one transaction before returning. Invalid entries remain in the package with their
exact input and error. Valid API seeds are resolved by the existing retrieval
workers, not by 50 concurrent frontend network calls.

A caller-generated submission key makes retries after a lost response return the
same package; changed inputs cannot reuse that key. The browser retains the key in
session storage and writes the package ID to its URL. Refresh/reopen restores the
saved membership and statuses. Start a new package review explicitly to create a
new run of the same input list.

The worker polls durable packages independently of the browser. After regulatory
runs are terminal and linked title workers have completed or stopped for review,
it calls the existing portfolio/GOLD engines and saves the evidence snapshot plus
per-run GOLD drafts. The page opens the snapshot automatically and offers a saved
GOLD JSON download. No manual report-generation click or private assembly script
is required for this path.

`evidence_ready` means the available-evidence report is persisted. It does NOT mean
title is cleared, an acquisition is approved, or GOLD acquisition acceptance passed.
Drafts retain explicit missing ownership, forecasts, partner data and economic input
reasons. The portfolio scenario option remains conditional; no inputs are invented.

## Deploy in this order

1. Preserve the deployed intake/scenario commits (remote base c430dee). Apply
   **036_durable_packages.sql** after migrations 034 and 035.
2. Build the worker from a full repository checkout: install frontend dependencies
   including dev dependencies (`npm ci --prefix frontend --include=dev`), install
   worker dependencies, then `npm run build --prefix worker`.
3. Deploy the complete `worker/dist` directory, including **report-engine.mjs**.
   This bundle contains the existing frontend report engines and their runtime
   dependencies; it does not require the frontend source on the production worker.
   Building does require it. `worker/deploy.sh` now handles a full checkout.
4. Restart the worker and verify the deployed SHA and no unstable restarts.
5. Deploy the frontend and wait for Ready.

The worker runtime uses the existing service role. Clients can read only their own
packages and cannot modify membership/status or publish snapshots directly. Intake
and retry functions derive identity from auth.uid; publication is service-role-only.

## Required production acceptance

- Signed in: submit one real API, retain its package URL, close the tab, and verify
  the worker persists the record and GOLD drafts without the browser present.
- Reopen that URL; verify membership, title state, source citations, and saved JSON.
- Submit a reviewed 49-entry package, including an invalid entry in a separate test.
  Every submitted row must remain represented. Shared lease production counts once.
- Replay the same submission key; verify unchanged package/run/job counts. Changed
  inputs under that key must fail. Cross-account lookup must return 404; anonymous
  access 401.
- Interrupt package generation, expire its claim in a controlled test environment,
  restart and verify only one snapshot is published. A stale worker cannot publish.
- Change a member run/title revision during assembly; verify publication is refused
  and retried. No mixed-revision snapshot should be delivered.
- Title review, failed retrieval, cancelled runs and absent economics must remain
  visible; never treat a populated report structure as a supported buy verdict.

## Recovery and limits

Generation claims expire after 15 minutes. Errors retry with a 60-second delay up
to five attempts, then surface `failed` with an explicit retry button. Active title
workers are waited on; human-review states allow an honest partial-evidence report.
Snapshots are immutable and do not refresh as later title reviews are completed.
Use a new package review (reusing existing unique title scopes) for a later snapshot.
The default automatic GOLD draft has no supplied reviewed position or Novi inputs;
linking those supported inputs remains a separate implementation task.

Existing single-run and legacy bulk endpoints remain available. Automatic package
snapshotting applies to the package path (including a one-API package). This release
does not claim all legacy entry points have been migrated.

## Local verification

Frontend 849/849; worker 119/119; frontend production build and both TypeScript checks passed.

The PostgreSQL integration test uses actual migrations, the compiled worker and
bundled real report engines. It proves atomic/idempotent intake, rollback, owner
isolation, claim/version fences, waiting for retrieval, automatic publication,
invalid-entry retention and no duplicate publication. Its missing-evidence fixture
is synthetic; it is NOT an authenticated production run or acquisition GOLD pass.

Run after building the worker:
`node supabase/tests/durable-packages.mjs /path/to/pglite/dist/index.js`

GOLD reports validated: **0/10 complete acquisition reports**.
