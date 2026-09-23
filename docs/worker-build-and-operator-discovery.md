# Worker build and operator discovery

Based on deployed 59083b2. Preserves the regression for survey data present only
on Buttercup API 4232946772, even when that well is not processed first.

## Search behavior

The raw operator name remains a logged source query. A second discovery query
collapses dotted initials and strips punctuation: CHEVRON U. S. A. INC. and
CHEVRON U.S.A. INC. both produce CHEVRON USA INC. It is planned independently
of the raw result, so an existing empty raw search does not suppress it on resume.
It shares the job's deduplication and 12-query budget. Operator variants do not
trigger automatic document downloads or grantor follow-ups, and do not establish
ownership or tract relevance. No live success is asserted for the new query.

## Reproducible build (Node 22)

From the full repository root:

```sh
npm run setup:build --prefix worker
npm test --prefix worker
npm run build --prefix worker
```

Setup explicitly runs npm ci --include=dev for frontend and worker using their
existing lockfiles. It does not deploy, start the worker, or require credentials.
Build checks the full checkout and locally installed TypeScript, pdf-lib,
esbuild and zod before compiling; it never installs dependencies implicitly.
The frontend source and dependencies are required to bundle the existing report
engine. pdf-lib is already a declared, locked worker runtime dependency.

Ship the complete worker/dist, including report-engine.mjs, together with matching
worker package.json/package-lock.json and install locked production dependencies
on the worker host. Do not run the full build from a worker-only checkout.
worker/deploy.sh remains a full-checkout provisioning script; it now invokes the
explicit setup step and resolves paths relative to itself.

## Verification and live acceptance

Local: 141 worker tests passed; TypeScript and report-engine bundle build passed.
Missing full-checkout and missing local dependency diagnostics were exercised in
isolated temporary directories. Setup script syntax was checked; a fresh network
npm ci and production deployment were not performed in this environment.

After deployment, resume the existing Buttercup job through the supported UI.
Read back title_search_log: expect one CHEVRON USA INC query, the survey-only
query despite uneven well data, and truthful result counts/status. Inspect any
records for actual tract relevance. Do not treat broader query matches as title.
GOLD validated remains 0/10 until a real report passes acceptance.
