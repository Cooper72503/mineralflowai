# Reviewed mineral position → GOLD handoff

## Scope

The existing mineral ownership engine already checks confirmed tract/well links,
unique apparent holdings, exact fractions, document inventory/hashes, citations,
review dates and acreage-based participation. It computes mineral NRI as mineral
fraction × tract participation × lease royalty. This change reuses that engine.

Previously automatic GOLD generation supplied position=null even when a reviewer
could establish a position. There is now an explicit saved selection per API within
a title research scope. Single-run reports and the package worker load that selection
and revalidate it against the currently published title analysis before calculation.
No owner is chosen from operator identity or from the most recent holding.

This supports acreage-based MINERAL ROYALTY interests only. It does not establish
operated WI/NRI, NPRIs, overriding royalties, non-acreage allocation or the full
package sale scope. Portfolio operated-asset approval remains withheld. Title
exceptions and missing forecasts/economic assumptions remain independent blockers.

## Deploy

Requires the durable package checkpoint (692b870) and migrations through 036.

1. Apply migration **037_reviewed_mineral_positions.sql**.
2. Rebuild and deploy the worker's entire dist, including updated report-engine.mjs.
   No worker source changes, but the bundled engine has changed.
3. Deploy frontend, wait for Ready.

Migration creates immutable review history and a selected review-ID map on the title
job. Saving a selection updates the job revision, so the existing package publication
fence rejects an assembly that raced a review change. New title analysis versions
invalidate older selections until explicitly reviewed again. Publication/read loaders
never interpret query failures as proof of absent ownership.

## Review workflow

On the title job page, the Evaluated mineral position section accepts a reviewed
position JSON under the existing ReviewedPositionSchema. It identifies API, analysis,
tract, canonical party and holding, plus source-referenced exact gross acres, unit
acres, lease royalty and participation. Source entries retain document IDs/hashes,
page numbers, retrieval timestamps, data and data hashes. Refer to
frontend/lib/trrc/decision-layer/ownership.ts for the existing contract.

The server records the signed-in reviewer and current review timestamp. It checks
the evidence using the existing engine before saving. A successful save returns the
exact computed NRI and explicit scope limitations. The RPC also guards owner, API,
reviewer and current analysis. Consumers revalidate stored content, including inputs
submitted directly to the database RPC.

This import is an advanced reviewer workflow, not automatic extraction of all needed
acreage/royalty terms from arbitrary instruments. That broader extraction and operated
sale-scope workflow remain outstanding. Do not describe this release as automatic
completion of title from API alone.

Generate a fresh individual GOLD report or submit a new package review using the
same unique title scope to include the selection. Existing saved package snapshots
remain unchanged. Explicit position supplements in the individual POST report API
retain their existing behavior and are validated by the same engine.

## Acceptance

- With a published, supported mineral holding, import its reviewed position and
  verify exact NRI and citations in a fresh report and automatic package draft.
- Select a second position and verify the previous review remains in history.
- Publish a new title analysis. Verify the old selection is withheld with a specific
  re-review reason until reviewed against that version.
- Cross-account selection/read, mismatched API, unsupported holding, collective
  ownership, uncited events, mismatched document/data hashes and acreage conflict
  must not produce an ownership value.
- Verify title review alone does not populate missing forecast/value fields or clear
  the independent title findings.

Local checks: frontend 855/855; database review-history/access/version tests; rebuilt
worker and real compiled-worker package integration passed. Production auth and real
reviewed-title acceptance have not been exercised from this environment.

GOLD reports validated: **0/10 complete acquisition decisions**.
