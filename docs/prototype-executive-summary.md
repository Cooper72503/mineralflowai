# Prototype executive-summary checkpoint

Base: main bfb5fa77815903681324cac5d9c5086265ffa55e.

## Changes

The existing package Decision Record renderer now generates an executive memo:
asset scope, unchanged decision badge, conditional economics, three grouped material
findings, and next actions. Numeric values come from the existing decision record;
no economics formula, default assumption, retrieval worker or approval gate changes.
The NRI percentage, interest type, return entry basis and valuation origin are adjacent
to the figures. A typed decimal is not labeled verified ownership. Detailed reasons
and exclusions remain in Section 12. Multiple leases get separate executive pages.
No resolved lease produces an explicit unavailable result.

## Deployment

Apply this commit to current main after checking for newer overlapping changes.
Run frontend typecheck, tests and production build, then deploy the frontend.
No migration or worker deployment is required for this PDF-only change.
The default package GET report and POST report with edited assumptions already call
this renderer. The older `format=acquisition` report is intentionally unchanged.

## Live acceptance still required

Using a signed-in account, reopen Buttercup and generate a new Decision Record.
No courthouse rerun is required for the layout. Verify first-page amounts equal
Sections 9-11 and the current screen, selected NRI/interest type are printed, and
REVIEW remains REVIEW. Old downloaded PDFs do not update automatically.
Use a supported interest or label the scenario illustrative; this checkpoint does
not alter the user's 100% royalty input.

## Ownership: concrete gap in the inspected code

The prototype package path in `deal/build.ts` uses `loadLeaseOwnership()` and
`valueLeaseInterests()` against appraisal-roll records. It does not load
`loadReviewedPosition()`. The separate GOLD2 package pipeline and title report input
do consume reviewed positions; that separate handoff does not verify ownership in
this prototype Decision Record.

To connect evidence-backed ownership here:

1. Establish the evaluated party, interest type, tract and unit participation scope.
2. Read material missing referenced instruments; resolve unsupported transfers, party
   identities, reservations, fraction bases and tract associations against cited images.
   Publish a revised analysis without clearing unresolved findings merely to pass.
3. Use existing reviewed-position validation for a supported acreage-based mineral
   royalty holding: cited mineral fraction, tract/unit acres, participation and lease
   royalty; signed-in reviewer and current analysis version. Its calculation is mineral
   fraction × reviewed tract participation × lease royalty. Its current scope does not
   cover operated WI, NPRI, ORRI or non-acreage allocation.
4. Extend the prototype deal model to carry the selected position and provenance,
   load it in the exact account/job/API/analysis scope, reconcile shared-lease allocation
   without double counting, and feed the supported decimal into assumptions as reviewed
   evidence. User overrides must revert to assumed, not retain a verified label.
5. Test stale analysis, cross-account selection, wrong tract/API, multiple positions,
   mismatched citations and unsupported interest types. Keep title exceptions independent
   of the computable decimal. An appraisal roll is a cross-check, not proof of the
   seller's conveyable interest.

This checkpoint implements the summary only. It does not claim title is verified,
close the ownership handoff, or assert a live production acceptance pass.

## Local verification

- Frontend: 1,014 tests passed across 115 files (four new PDF regressions).
- Next.js production build passed, including type validation.
- Visually inspected the generated synthetic executive page; it fits one page.
- No live authenticated report generation or deployment performed here.
