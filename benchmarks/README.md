# Texas API regression benchmark

Ten distinct real RRC APIs are recorded in `texas-api-cases.json` with public discovery URLs, timestamps and returned GIS attributes. Labels describe the sampled GIS category, not a verified present operating status. `permit-only` is a fixture identifier: that API has historical lease associations and is not evidence that the asset never produced.

| Case | API |
|---|---|
| Gaines oil | 42-165-02733 |
| Fisher injection/disposal symbol | 42-151-31926 |
| Barnett gas | 42-439-34308 |
| Midland historical associations | 42-329-00028 |
| Karnes oil | 42-255-00009 |
| Webb gas | 42-479-00014 |
| Panhandle gas | 42-211-00014 |
| Plugged symbol | 42-151-00013 |
| Permitted-location symbol | 42-329-01040 |
| Dry-hole symbol | 42-165-00004 |

## Repeatable offline checks

From the repository root:

```sh
npm ci --prefix frontend
npm ci --prefix worker
npm test --prefix frontend
npm test --prefix worker
npm run build --prefix worker
cd frontend
npx tsc --noEmit
```

`MINERALFLOW_EXPORT_BENCHMARK=1 npm test --prefix frontend -- lib/trrc/__tests__/benchmark-replay.test.ts` regenerates the ten evidence JSON artifacts under `decision-records/`. These are provenance-1.0.0 outputs, not the GOLD 2.0 report. Their deterministic generation timestamp is one second after the latest source attempt in each case; source retrieval timestamps remain in the evidence entries.

## Live retrieval

Requires network access to public RRC services; no database writes or Novi/EIA credentials:

```sh
npm run build --prefix worker
node worker/scripts/benchmark-retrieval.mjs
node worker/scripts/benchmark-retrieval.mjs permit-only
```

The first command after build captures all four core source categories for all ten cases and writes `latest-retrieval.json` and `captures/`. Previous complete aggregate runs are preserved under `history/` on subsequent runs. A selected-case run writes `recheck-CASE.json` and `rechecks/`, preserving the full-run result. The committed `outage-retrieval.json` retains the observed ten-case run containing the permit-case timeout.

Do not overwrite an outage with a successful recheck when reporting availability. The captured replay's explicit source-coverage floor is tied to the committed fixture (nine successful GIS lookups); review fixture changes and expected source outcomes together rather than changing assertions merely to get green tests.

## What the tests establish

- Each captured case produces every one of the 84 evidence fields, with validated observations/calculations or disclosed gaps.
- At least some fields must be truly observed; a schema full of unavailable values cannot satisfy the source-coverage floor.
- Worker sequence replay persists evidence and correctly shaped lease-level months through an in-memory database double. Uncaptured adapters explicitly fail.
- The separate recheck verifies current gas association 131160 for the permit-symbol case.
- PDF rendering compatibility uses real captured core payloads and deterministic unavailable responses for uncaptured engines. It does not certify live downstream engines, layout quality or GOLD parity.

The full live run returned production for five cases. A separate failed-case recovery returned a sixth. All ten decision evidence artifacts still have insufficient acquisition data because the evaluated position, linked title, NRI, Novi reconciliation and acquisition rules are missing. See `../PIPELINE-STATUS.md` for current counts and exact failures.

## Standalone GOLD path

`npm run gold:benchmark --prefix frontend` exports all ten captured cases through the eighteen-section renderer, with JSON field-status counts and per-case failure reasons in `audit-work/gold-benchmark/summary.json`. `standalone-live-gaines.json` retains a complete public-worker run, including missing Chromium and public endpoint failures. See `STANDALONE-GOLD.md` for live and replay commands and the remaining acquisition-engine boundary.


## GOLD2 acceptance and visual review

Run `npm run gold2:benchmark` from `frontend/` after installing the development-only reviewer with `python3 -m pip install -r scripts/gold2-review-requirements.txt`. The current retained-source corpus produces ten complete, auditable records with explicitly unavailable acquisition inputs. The numeric pass count does not represent ten priced acquisitions or ten live Novi integrations.

`gold2-render-review.json` binds visual approval to input/record hashes and 72-dpi RGB page fingerprints produced by pinned PyMuPDF. React PDF randomizes embedded font-subset identifiers; raw PDF hashes are retained for file identity but are not treated as visual changes. Different report data, pixels, page counts or renderer versions require review.

For a changed template: regenerate, render all pages, inspect contact sheets and detailed pages, and check text bounds. Place the resulting per-API structural checks in `audit-work/gold2-review/final-structural-review.json` with `{api,pageCount,outOfBoundsPages}` entries. Only after inspection run `node --import tsx scripts/record-gold2-review.ts --confirm-pages-inspected`, then rerun the benchmark. Never generate an approval merely to make CI green.

`standalone-live-gold2-gaines.json` is a separate real public-source run through the full standalone sequencer. It retains all sixteen attempts and disclosed failures and does not replace the historical ten-case corpus.
