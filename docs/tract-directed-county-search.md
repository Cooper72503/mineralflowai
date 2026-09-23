# Tract-directed county discovery

Base: deployed 8ea365c. Worker-only; no migration.

Confirmed title_canonical_tracts now supply section/block/township queries before
lease and operator discovery in each county. For Section 37, Block 39 T4S:

- SEC 37 BLK 39 T4S
- SECTION 37 BLOCK 39 T4S

The search identity is read from persisted confirmed tracts, independent of which
well carries survey data. The initial conservative parser supports a single
section and numeric/alphanumeric block with explicit T-number-N/S in block_number.
Unsupported/missing identities produce a review item; no township is inferred.
This remains discovery against the reviewed scope. A confirmed surface-survey
candidate alone does not prove the full producing unit or mineral ownership.

Predecessor queries now come only from index legal descriptions matching the
confirmed county, section, block AND township. Wrong/missing township, address-only
hits and descriptions with multiple distinct identifiers cannot seed searches.
Existing index rows can still seed relevant follow-ups on resume. Broad records
remain stored unverified, but their count is not proof of a title chain.

Public preview downloads can follow exact unit-name matches (existing behavior)
or these conservative tract matches. Neither path verifies a conveyance. Document
extraction and scope review remain required. Existing limits remain unchanged.

Publicsearch's 50-row page is explicitly marked coverage_incomplete. This is an
honest possible-cap signal, not implementation of all-page retrieval, and not a
fabricated total count. Paging beyond that page remains open work. A search pass
with broad hits but no matching tract records now creates its own review item.

## Validation
151 worker tests passed; TypeScript and report-engine bundle build passed.
Fixtures cover wrong T3S vs T4S, street address, mixed-tract ambiguity, missing
township, confirmed/unconfirmed scope, precise-query priority and the page cap.
These are local regressions, not live county or GOLD acceptance.

## Deployment and live acceptance
Build from the full repo using documented setup:build and build commands. Ship
complete worker/dist with matching runtime dependencies. No frontend deployment
or database migration required by this patch.
Resume the existing Buttercup title job using the supported authenticated flow.
Read back the two precise searches, relevant predecessor queries, preview storage,
and explicit capped/failed/empty outcomes. Verify any returned record against its
document and the actual unit/tract before ownership analysis. Do not delete the
old 320 leads or treat this patch as establishing title. GOLD validated is 0/10.
