# Buttercup title discovery cycle

Apply after the evidence-gates checkpoint a49825a. The combined handoff includes
both patches in order, based on production f22797b. No migrations/dependency changes.

The existing worker calls the shared ingestion engine with a county-discovery
callback. After pending documents are read, that callback reloads the job's wells,
searches current candidate tracts with existing county connectors/deduplication,
and retrieves matching images. If new pending documents exist, the engine reads
again. Publication occurs only after that loop has no new pending documents.
Four discovery rounds bound one execution; exceeding them leaves a failed,
resumable job and preserves every stored document. Index results remain unverified.

Document discovery now reads non-rejected tract candidates, including descriptions
learned from documents. This does not promote a proposed tract to confirmed or
create an ownership branch. Existing corroboration and linkage guards still apply.
Midstream names and surface labels affect priority only; the worker must read the
instrument before its title effect can be established. Invalid preview bytes are
not logged as successful retrieval. Transient failures receive one retry.

Preview/OCR limits: 100 pages per document, 30 MB retrieval, 40 new candidates per
retrieval pass, 30 ingestion batches per discovery round. Longer documents or
unreadable pages produce explicit failures. These limits are not a claim of
exhaustive county coverage; per-search/provider result caps remain disclosed.

Local verification: frontend 981/981; worker 192/192; standalone frontend
TypeScript, frontend production build and both worker engine bundles passed.

## Deployment and live proof

1. Apply both ordered patches from the combined handoff to a clean checkout based
   on f22797b or newer. Preserve any later commits; never force-push.
2. Run frontend/worker tests and both builds. Deploy frontend and the complete
   worker dist (including title-engine.mjs, report-engine.mjs and runtime OCR files).
3. Resume/re-run the real Buttercup title job via the authenticated application.
   A completed job is intentionally protected from reset; use the supported new
   package run or existing authorized ingestion workflow as appropriate.
4. Verify logs alternate reading -> county discovery -> reading newly found images
   before analysis publication. Confirm the job stays active while this happens.
5. Inspect all 25 known recordings: each must have a stored/read document or an
   explicit retrieval/OCR/matching exception. Confirm additional tract queries
   come from document descriptions; do not infer Section 25 from the unit name.
6. Inspect proposed/confirmed tract status and similar-name parties. Never resolve
   names merely to remove a warning. Then regenerate the single package report
   through the signed-in app and compare title evidence with persisted records.
7. Re-run scripts/demo-acceptance.ts for the same saved package. Passing tests with
   fixtures does not prove live title coverage or the seller's conveyable NRI.

No production Supabase session, droplet deployment or authenticated live acceptance
was available in this work environment. No assertion that the outstanding Buttercup
recordings or Section 25 have already been found, read or verified is made.
