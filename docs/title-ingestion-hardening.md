# Title ingestion integrity checkpoint

Apply after dc2bcab. Frontend deployment only; no migration or worker dependency
change. The shared report worker does not import the ingestion module.

## Changed behavior

- Database errors in ingestion, canonical-party persistence, review items and
  limitation persistence throw instead of becoming empty data or silent success.
- Instrument rows remain unverified until their parties, tract records, claims
  and ambiguity review items are written. A retry that encounters an incomplete
  earlier extraction stops for repair rather than skipping it as a duplicate.
- A document with no parsed instrument or legal description fails with a review
  item rather than being labeled done.
- A failed OCR's saved text is not reused on a later retry as successful text.
- A PDF text layer must contain meaningful text for every reported page or OCR
  runs. OCR refuses documents beyond 25 pages and flags a page with fewer than
  40 normalized characters. Blank pages can therefore require review; this is
  intentional, and no partial deed is silently accepted.
- The authenticated ingestion route conditionally claims the observed job state,
  refuses overlapping ingest requests, reports database failures as errors, and
  does not overwrite cancellation when recording completion/failure. Completion
  messaging distinguishes extraction failures and remaining documents.

## Acceptance on the six retrieved MASK documents

Use the authenticated ingestion route/UI after deploying. Verify each PDF's page
count and text against the saved county preview, especially all twelve affidavit
pages. Inspect parties, legal descriptions, reservations and fractions. Confirm
failed/ambiguous documents create review items and that unmatched tracts remain
proposed. A database or OCR error must not produce a successful empty result.
Do not treat successful extraction as confirmation of title or reviewed ownership.

## Still outstanding

This does not automate the scheduling of ingestion. A durable document claim,
lease/recovery mechanism and transactional instrument persistence are needed
before background ingestion is safe. This checkpoint prevents partial database
writes from being promoted to verified instruments, but does not roll them back
or automatically repair pre-existing partial/incorrect records. Crashed HTTP
requests can still require explicit recovery of an ingesting job. No real document
extraction or production database acceptance was executed in this environment.
