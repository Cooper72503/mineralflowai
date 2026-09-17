# Atomic due-diligence intake

## Problem fixed

The application inserted a pending run before its entities and title scope. A
worker could claim it during those later writes; entity persistence failures were
logged as nonfatal. Bulk intake also started up to 50 concurrent creates, and one
thrown error rejected the entire response after some runs had already been queued.

## Deployment order

1. Apply migration **035_atomic_due_diligence_intake.sql** after migration 034.
2. Deploy the frontend and wait for Ready. No worker change in this checkpoint.
3. Use a signed-in account to submit a valid API. Confirm the pending/running row
   has its entities and explicit title scope already persisted. A disclosed title
   setup failure may leave the scope null; its warning must be retained on the run.
4. Submit a mixed batch. Verify each accepted entry has its own ordered result,
   valid entries reach the worker, and a failed entry does not hide other run IDs.
5. Confirm the worker completes retrieval and the existing GOLD report route
   returns an evidence-backed result. This is a required production check, not
   something the isolated tests establish.
6. Verify a second account cannot access or attach the first account's title scope.

The new function derives ownership from auth.uid(), uses existing RLS and the
migration 033 title-link trigger, and commits the run and entities together. There
is no fallback to partial inserts if the RPC is unavailable. Apply migration first.
Title jobs are queued before the DD transaction; if that transaction fails, an
already-created title job can remain and be reused. This is not a transaction
spanning both job families. A lost network response can still require checking run
history before retry; full submission idempotency remains outstanding.

Bulk intake now has three concurrent creators and isolates thrown failures. The
HTTP request still owns intake, and the batch grouping is not durably scheduled;
request deadlines and refresh recovery remain work for the package orchestrator.
This change does not claim to implement autonomous package orchestration.

## Verification

- Frontend suite: 845/845 passing.
- Isolated PostgreSQL: actual migrations 019/021/022/033/035 with minimal title
  fixtures; rollback after failed entity insert, scope mismatch rejection, caller
  identity, cross-account visibility and anonymous rejection passed.
- Run database test: `node supabase/tests/atomic-dd-intake.mjs /path/to/pglite/dist/index.js`.
- No authenticated production run was executed from this environment.

GOLD reports validated: **0/10 complete acquisition reports**. Remaining milestone:
one submission through the deployed application, complete worker execution, linked
reviewed title/interest evidence where available, and a persisted final GOLD record.
