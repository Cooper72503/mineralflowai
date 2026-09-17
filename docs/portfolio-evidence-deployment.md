# Portfolio evidence review deployment

This adds a real retained-evidence rollup, not a completed acquisition valuation.
It does not change the existing decline, title, royalty economics or worker engines.

## Install

1. Apply `supabase/migrations/034_portfolio_evidence_records.sql` before deploying
   the frontend. Prior title migrations remain required by existing functionality.
2. Deploy the frontend and wait for Ready. No worker change is included here.
3. Sign in and open `/trrc-due-diligence/portfolio`. Submit the reviewed API list
   through the existing bulk intake. Every submitted row, including failed intake,
   is passed to the portfolio review; it does not filter to completed runs.
4. Enter the asking price and the seller's stated well count. These are explicitly
   provided inputs, not verified source facts. Click **Save portfolio evidence review**.
5. Bookmark the resulting `?record=<UUID>` URL; reload and verify the same snapshot
   loads. Download its full JSON including the original input, inventory entries,
   source hashes, citations, lease streams, gross monthly totals and blockers.
   Saving again creates a new snapshot. Saved records are not automatically refreshed.
6. With another signed-in account, verify the saved record returns 404 and no data.
   An unauthenticated request must return 401. These production checks are still required.

## Acceptance against the real offered package

- Resolve API corrections against RRC evidence before submitting them. This new
  review does not silently repair malformed API strings or infer missing wells.
- Include all offered entries and compare the distinct valid APIs to the stated
  count. The known 49-versus-52 discrepancy must appear until reconciled.
- Lease identity is Texas + district + successful oil/gas query type + lease ID.
  Each month/phase counts once across all linked APIs and duplicate runs.
- Conflicting reported volumes are withheld. An API assigned to different streams
  across runs blocks totals until its completion/lease scope is reconciled.
- Missing phases and missing months remain unavailable, never zero. A failed
  latest production retrieval cannot resurrect stale production from an older attempt.
- Totals are gross regulatory streams, not acquired-interest production. Seller
  ownership of all production in a lease is not inferred from the submitted well list.
- Asking price must not populate maximum offer, remaining reserves or exit value.
  Explicit conditional scenarios are now available separately; verified acquisition
  values remain `reviewed_acquisition_scope_missing`. See portfolio-scenario-deployment.md.
- Missing or inaccessible requested runs and failed evidence pagination must fail
  the request rather than quietly produce a report for only the accessible subset.

## Endpoints

`POST /api/trrc/due-diligence/portfolio-record`, authenticated body:

```json
{
  "members": [{"input": "<original API entry>", "runId": "<full run UUID or null>"}],
  "askingPriceUsd": 2500000,
  "claimedWellCount": 52
}
```

`null` runId preserves an entry that could not start. The supplied API must match
its run. Supported size is 1–100 entries. The existing individual-PDF ZIP remains
separate and retains its existing 20-report cap.

`GET /api/trrc/due-diligence/portfolio-record/<record UUID>` reopens the saved record
under its owner. Both endpoints use no-store responses.

## Verification

24 new automated tests cover 49-entry deduplication, district/oil-gas separation,
conflicts, absent data, incomplete inventory, identity mismatch, failed latest
retrieval, pagination, account filtering, persistence failure and snapshot routes.
Fixtures are synthetic; they do not count as a live acquisition acceptance case.

The isolated PostgreSQL RLS test uses PGlite 0.3.14:
`node supabase/tests/portfolio-records.mjs /absolute/path/to/pglite/dist/index.js`
It exercises owner reads/inserts, cross-account rejection, anonymous rejection
and lack of update/delete privileges. It does not prove production auth/session behavior.

## Next engine handoffs

Conditional package cash-flow and exit handoffs are now implemented using the
existing operating engines. Connect actual title/interest evidence to sale scope
and lease participation, plus evidenced waterflood/restart forecasts and documented
costs/liabilities. Conditional inputs must not be mistaken for reviewed ownership.

Complete real acquisition GOLD records validated remains **0/10**.
