# Buttercup report audit checkpoint — October 2, 2026

## Base and scope

Apply this patch on main `3d4e9c94e6520372bd43b7ca2bad88312c7d749e` or a descendant
with conflict review. The local parent `1336777` is a snapshot checkpoint, NOT
production history. Apply only the supplied patch; do not push the synthetic
worktree history. No migration, credential, customer document or generated
production artifact is included.

## Changes

- Keep REVIEW evidence gates; replace contradictory legacy “Not valued” wording
  with ownership-based valuation unavailability alongside conditional scenarios.
- API table reflects actual scenario availability. Package blockers no longer
  appear under a heading claiming all affected APIs were excluded.
- Display the assumed interest and valuation origin beside the economics;
  distinguish IRR at asking from illustrative exit IRR at the range-top entry.
- Disclose EIA's existing 1.000 MMBtu/Mcf equivalence as an assumption, never
  measured lease heat content. Users can enter realized $/Mcf prices. No engine
  formulas or defaults change. Operator/location cost labels remain benchmark
  scenarios, not claimed company actuals.
- Count unique instrument IDs rather than tract/interest events. Every branch
  event remains visible, with tract, interest, effect, and support status.
- Show earliest/apparent graph holders and unresolved branch states separately
  from the appraisal-roll cross-check. These are not certified ownership or NRI.
- A missing predecessor is cleared only by read content with matching county
  and recording identity. Wrong-county and index-only matches cannot clear it.
  Volume/page boundaries are preserved. An unknown reference county remains open.
- Extract real Texas county names instead of “Of Midland”; ambiguous multi-county
  context stays unresolved. Existing extracted rows are not silently rewritten.
- Embed existing licensed GOLD fonts in this PDF; add the package-route trace.
  Shorten repeated executive summaries and share one page for entry/exit when
  content fits. Other engines and report renderers are unchanged.

## Verification performed

- Frontend: 1006 tests passing; TypeScript clean.
- Worker: 202 tests passing; build produces report-engine.mjs and title-engine.mjs.
- Frontend build with an offline Google font response passes. Ordinary build is
  blocked by the environment's Google Fonts network restriction. Test-only font
  response and temporary build-worker settings are NOT in this patch.
- Package report route trace includes NimbusSans-Regular.otf, NimbusSans-Bold.otf
  and LICENSE.txt. Synthetic PDF rendered and pages inspected. No live acceptance
  was performed and the 0/10 metric is unchanged.

## Deployment and live acceptance

1. Apply the patch, run normal frontend tests/typecheck/build on the deployment
   machine with its ordinary network access. Run worker tests/build in the full
   repository. Ship the full worker dist because title parsing/findings live in
   title-engine.mjs. No database migration is needed.
2. Deploy frontend including the traced fonts. Open the existing Buttercup deal
   while signed in. Change oil price and working-interest costs; recalculate and
   export. Confirm the PDF matches the screen and all 13 oil rows remain present.
3. Republish/re-run analysis for the existing title scope through the app's
   supported analysis action. The new reference checks then apply to persisted
   evidence. Re-extraction is needed only to change previously parsed county
   fields; do not reset all OCR or mark any instrument verified by SQL.
4. For suspicious `2009-2`, compare the stored OCR excerpt and cited page image.
   This patch does not guess missing digits. Validate the Glasscock reference
   against its cited deed and affected tract before calling it contamination.
5. Run `frontend/scripts/demo-acceptance.ts` using the existing package and owner
   identifiers and the normal secured environment. It now checks unique title
   counts, branch context, gas-unit disclosure and contradictory status text.
   Run the established regression packages as well.
6. Verify no unresolved title or ownership findings become BUY merely because
   scenarios calculate. Confirm document counts against unique instrument IDs;
   totals may decrease from the earlier report because duplicate branch events
   no longer count as separate recordings.

## Still unresolved by this code checkpoint

Actual conveyable ownership/NRI, unread/missing instruments, ambiguous party
identities, actual operator expenses, measured heating value and current-month
production need source evidence. The code exposes these gaps and prevents false
clearance; it does not manufacture a completed title chain.
