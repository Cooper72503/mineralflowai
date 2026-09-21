# County public preview retrieval

## What was verified live

On September 21, 2026, the Midland public portal exposed document 39265019
(instrument 2019-34704) without sign-in: a three-page public preview, next-page
controls, and signed PNG URLs in the rendered SVG. Page 1 and page 2 were observed.
This disproves the blanket claim that all document images require a purchase.
It does not prove all county instruments are freely accessible or legible.
This document is a MASK lead, not Buttercup evidence.

## Worker change

Publicsearch index rows retain the document ID link exposed by their checkbox.
Exact normalized lease-name/legal-index matches enter bounded preview retrieval
(eight candidates per job invocation, twenty pages per document, 30 MB images).
Other operator/party hits remain unverified index leads, not auto-downloaded.

The browser follows only the public viewer's next-page control and exposed image
URLs. All pages must succeed before one image-based PDF is stored in title_documents.
The PDF preserves image marks and page order. It is labeled county_public_preview,
not a certified original. No login, checkout, or hidden full-resolution endpoint.
Signed image URLs are neither persisted nor logged. Same-origin/document checks
reject foreign image URLs; image requests disallow redirects.

Stored documents enter the existing pending OCR/extraction workflow. Index rows
remain instrument_content_verified=false. No tract or holding is auto-confirmed.
Review items identify retrieval failures and the required extraction/tract review.
Repeated lease searches can discover previews on resumed jobs; existing saved
preview URLs are skipped. No migration or frontend change.

## Deploy and prove

Apply this patch after the county-empty-search fix (0ada048), or apply the supplied
cumulative checkpoint to cb9bcde's tree. No force push or history reset.
Run npm ci --prefix worker (new runtime dependency pdf-lib), then the established
full-repository worker build, and ship the complete dist plus updated runtime
package files/dependencies. Preserve existing secrets and browser installation.

Before starting a new job, invoke getCountyDocument with
https://midland.tx.publicsearch.us/doc/39265019 on the deployed worker and verify a
three-page PDF; closeBrowser when done. Then use the normal title job workflow.
A finished existing job requires the supported retrieval retry/requeue path, not
merely Re-run analysis, which does not run county retrieval.

Verify saved title_documents has a complete PDF, source_url, hash, and pending
extraction; use the existing ingestion action and inspect OCR against all pages.
Verify county index rows do not become content-verified merely through download.
Repeat retrieval and confirm no duplicate stored document. Verify an inaccessible
viewer yields a failure/review item rather than an empty/verified result.

## Validation limits

Worker tests and build pass. Tests exercise full-page PDF assembly, later-page
failure, URL restrictions, index link preservation, candidate filtering, persistence
and repeated-run deduplication using fixture browser/database dependencies.
The new worker retrieval function has NOT been run against the live portal here:
local Chromium download failed (502/timeouts). The live inspection above used a
separate browser. Production storage, OCR quality and title interpretation remain
to be verified. This is retrieval implementation, not complete automated title.

Remaining: stronger document-derived tract matching; pagination/completeness for
county indexes; referenced-instrument discovery; authenticated access where needed;
automatic post-retrieval ingestion/orchestration; real-document interpretation and
ownership acceptance. These must not be marked complete by this checkpoint.
