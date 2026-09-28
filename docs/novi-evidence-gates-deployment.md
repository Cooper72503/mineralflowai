# Decision Record evidence gates — September 28, 2026

Base: `f22797bc91c058c25c5ffd395194c08a9ed4facb`. No migration or new dependencies.
Preserves the 13-section Decision Record, editable assumptions, EconomicsProvider,
existing Arps/cash-flow engines and authenticated report routes.

## Deploy

1. Apply this commit after f22797b. Install the existing lockfiles for frontend and
   worker in a full checkout (or use `npm run setup:build --prefix worker`).
2. Run `npm test --prefix frontend`, `npm test --prefix worker`,
   `npm run build --prefix frontend`, and `npm run build --prefix worker`.
3. Ship the complete worker `dist/`, including rebuilt `report-engine.mjs` and
   `title-engine.mjs`, with the existing runtime/OCR dependencies. Deploy frontend.
4. Check both deployed SHAs and worker restart count. Do not rebuild from a
   worker-only checkout or ship only the TypeScript files.

Local results: frontend 977 tests, worker 182 tests; frontend production build and
worker engine bundles passed. Live production acceptance was not run here.

## Required live acceptance

Use the existing environment-held credentials; never paste keys into chat.
From frontend, run:

```sh
npx tsx scripts/demo-acceptance.ts <packageId> <userId> <private-output-dir> <leaseNumber=apiCount>
```

Repeat Buttercup, Kraken/Washington 5, Shockley and Scharbauer using their actual
saved package IDs. The prior reported counts are not the counts for this revision.
The script now has additional decision-safety assertions.

- Signed-in flow: submit 1 API and the 12 Buttercup APIs, close the tab, reopen the
  package, edit assumptions and generate the combined Decision Record. Exercise
  50 valid inputs and rejection of 51 through the authenticated intake route.
- While documents are pending, retrieval must hand off as `ingesting`, not a
  terminal review pause. Neither the package worker nor report loader may seal
  that intermediate state. Restart recovery must preserve documents and tracts.
- A failed compliance request or unknown/truncated open count must be unavailable,
  never a clean compliance statement. GIS-only plugging stays explicitly limited;
  no W-3 certificate verification is claimed.
- An unresolved/excluded API, failed source, stale production, unread relevant
  recordings, Section 25 coverage gap or unresolved title finding must prevent
  whole-package BUY. Scenario calculations may remain visible.
- A deliberately too-expensive scenario may still show lease-level PASS under its
  stated assumptions. A package with material evidence gaps remains REVIEW.
- Repeating a title job that fails must not expose its older analysis as the
  successfully completed result of the new retrieval.
- Verify the cross-account rejection and compare displayed/PDF values after edits.

## Exact remaining limits

This patch prevents misleading completion; it does not supply missing evidence.
Buttercup still needs documentary establishment/research of the remaining unit
tract, relevant recordings read, and party identity findings resolved. An entered
NRI is a scenario input, not a verified seller interest. Appraisal roll holders are
not a legal title determination. Selecting/reconciling the conveyable seller
interest remains a required transaction acceptance step.

No claim is made that the 1–50 live boundary tests, OCR of the remaining Buttercup
instruments, a reviewed seller position, or 10 complete acquisitions passed here.
The reported 13-page production PDF was not attached in this environment and was
not visually inspected in this cycle.
