# Standalone GOLD report

The command runs the existing deterministic public-record worker, retains its evidence locally, and produces the GOLD reference's eighteen sections as a PDF and matching JSON. It does not require Supabase or an LLM. It accepts the supported Texas API formats (8/10/12/14 digits and standard separators); base-API retrieval does not independently verify a completion suffix.

## Setup

Use Node 22 or newer. From the repository root:

```sh
npm ci --prefix frontend
npm ci --prefix worker
cd worker
npx playwright install --with-deps chromium
cd ..
```

Chromium is required for browser-based public-record sources. Its absence is recorded as a source failure; it must not be mistaken for an empty records search. Public source connectivity is still required for live retrieval. County connector coverage varies by county.

## Live execution

```sh
npm run gold:report --prefix frontend -- --api 42-165-02733 --out ../output/gold
```

`npm --prefix frontend` executes the command in `frontend`, so output and replay paths are relative to that directory. This example writes into the repository's `output/gold` directory. For each API, the command writes:

- `API-gold.pdf`: report generated from the validated JSON record.
- `API-gold.json`: 84 evidence fields, retained source payloads and hashes, derived coverage, explicit decision prerequisites and lease screening results.
- `API-retrieval.json`: run metadata and raw parsed source attempts.
- `API-checkpoint.json`: live worker state, updated after each write.

Invalid input, storage errors, incomplete worker execution or report validation failures exit nonzero. Expected source failures remain visible in a completed report. Run distinct simultaneous invocations in separate output directories.

## Reproducible benchmark

No network or database is required for captured replay:

```sh
npm run gold:report --prefix frontend -- --api 4216502733 --out ../output/replay --replay ../benchmarks/captures/gaines-oil.json
npm run gold:benchmark --prefix frontend
npm test --prefix frontend
npm test --prefix worker
```

The benchmark exports all ten retained API cases to `audit-work/gold-benchmark`, with a machine-readable `summary.json`. A case passes when its full report validates and renders. Counts of observed, calculated and missing fields are reported separately. The fixture-derived report timestamp follows the latest captured retrieval; it does not imply a current live search.

## Current acceptance boundary

Verified: ten captured API cases render validated reports; ten worker-to-GOLD replay cases pass; the live Gaines API produces a report without cloud database credentials. The existing Arps engine receives calendar-consistent lease volumes, with phase-specific missing-data reasons. No subject-well allocation is invented.

Still incomplete: linking reviewed title jobs and evaluated positions, position-specific ownership/NRI and acquisition economics, a supported Novi import/live adapter and reconciliation, full geology engine output handoff, web/export parity, and broader live acceptance across Texas. These are implementation gaps, not merely missing credentials. The report currently withholds these fields rather than asserting ownership, value or readiness.

The `mineralflow-gold` 1.0.0 presentation contract is distinct from the reference sample's advertised 2.0.0 ruleset. The MF-G prerequisite checks are explicit local rules; they do not purport to recreate unpublished sample predicates. See `PIPELINE-STATUS.md` for current results and exact remaining failures.
