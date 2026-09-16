# Current cycle — package evidence and shared-production reconciliation

**GOLD reports validated: 0/10.** Complete real acquisition decisions only.

- Synced to deployed d069fcdd412abe9b699b79de8215a168b3992364; retained prior fixes.
- Added an authenticated 1–100 entry portfolio record and integrated review controls
  in the existing portfolio page. Failed intake entries remain visible.
- Reconciles gross production by Texas/district/oil-gas query type/lease/month/phase.
  Identical observations across wells count once; conflicting values and conflicting
  API-to-stream assignments block totals. Missing phases/months never become zero.
- Reports submitted/stated inventory discrepancies and preserves all original inputs.
  No API corrections, seller interests, allocation, reserves or values are invented.
- Saves account-scoped immutable snapshots, reopenable by record URL after refresh.
  Migration 034 is required before frontend deployment. Worker engines are unchanged.
- New loader pages retained evidence, rejects missing/inaccessible requested runs,
  and checks for run changes during reading instead of silently emitting a subset.
- The 49-entry synthetic regression verifies two shared leases are counted twice
  total, not 49 times. It is not a real acquisition or live-production acceptance test.
- Local verification: 24 new regressions; full frontend suite 813/813;
  TypeScript and Next production build clean; isolated PostgreSQL owner/cross-account/anonymous/immutability
  policy checks passed. Deployment and signed-in production checks remain outstanding.
- Critical remaining implementation: portfolio title/interest linkage, operated-asset
  cash-flow handoff, package forecast/recoverable-volume handoff and exit valuation.
  They are explicitly labeled portfolio_engine_not_connected in the saved record.
- Actual source documents, reviewed sale scope/WI/NRI, supported waterflood forecast,
  operating/capital/plugging obligations and buyer criteria are still required.
  This cycle creates a usable package evidence review, not a buy/price recommendation.
- Deployment and real-run acceptance instructions: docs/portfolio-evidence-deployment.md.

---
# Current cycle — lease coverage and explicit title scope

**GOLD reports validated: 0/10.** This counts complete real acquisition records,
not captured-source schema tests or correctly disclosed unavailable fields.

- Synced with deployed audit SHA 4addf2d16815bc4a390d172ec2e143d39fbc8203,
  preserving the previous local checkpoint and upstream intake fix.
- Lease-only runs distinguish out-of-scope sources from unavailable prerequisites.
  The persisted summary excludes not-applicable sources: regression case 5 of 5
  applicable, 11 not applicable. An inventory transport failure no longer aborts
  independent lease queries. Failed API resolution remains a retrieval gap.
- New API runs persist their selected title job. GOLD verifies that saved link
  against account and API, then follows only that scope. Unlinked competing live
  scopes remain ambiguous; cancelled/failed scopes cannot supply an old analysis.
- Added authenticated POST /api/trrc/due-diligence/[runId]/title-link with
  {"jobId":"<full UUID>"} for deliberate selection on existing runs. This does not
  confirm a tract, publish title, approve NRI, or cancel another job.
- Migration 033 validates account/API membership on link writes. Apply it before
  deploying this frontend. Title setup/link errors are returned as warnings by
  single and bulk intake. Progress/review-item query errors are disclosed.
- Local verification: worker 112/112 and build; frontend 789/789 and TypeScript;
  isolated PostgreSQL migration execution, owner/API rejection and link retention.
  These are local checks, not evidence of a deployed or authenticated production run.
- Production acceptance still required: create through the signed-in app (not
  service-role inserts), verify atomic title creation and saved run link, rerun
  lease retrieval and verify applicable-source counts, then retrieve GOLD JSON.
- The latest production results supplied by the owner remain 71 ODC association
  rows, 3 Taylor rows, and DD 14/16 sources with 49 production months. No new live
  worker run was possible here. Plugging and ICE retrieval remain unverified.
- Actual Gaines title instruments, reviewed tract/interest linkage, defensible
  production allocation, forecast and explicit economics inputs are still missing.
  No ownership, NRI or acquisition valuation has been invented to improve the count.

---
# Current cycle — lease inventory completeness and identity reconciliation

**Complete real acquisition GOLD reports independently validated: 0/10.**

- Synced to remote audit merge 203b8b4 before editing; preserved upstream fixes.
- Lease lookup requests View All, removes the silent 50-row truncation, and fails
  explicitly when pagination/count discrepancies remain or rows do not match the
  requested lease/district or contain malformed API identifiers.
- Live lease lookups now returned 71 ODC rows (47 on-schedule, 24 off-schedule)
  and 3 Taylor rows (2 on-schedule, 1 historical). On-schedule is not a producing
  status, ownership determination, or allocation basis.
- Added evidence-backed offered-inventory reconciliation preserving original
  identifiers and proposing corrections only from unique current lease/well
  matches. Real package reconciliation is retained privately outside git.
- Title worker selects a unique current association before historical rows,
  avoids mixing operator/lease fields from different rows, and explicitly flags
  ambiguity while clearing stale identity fields.
- Verification: lease parser and matching regression tests, full worker suite,
  worker build and frontend TypeScript. No production deployment is asserted.
- Remaining: source instruments for ownership, reviewed tract/interest linkage,
  production allocation and forecast/economics inputs; a real acquisition GOLD
  report has not yet been independently validated.

---
# Production decision-record completion — September 15, 2026

**Complete real acquisition GOLD reports independently validated: 0/10.**
The prior 10/10 below measures captured-source schema/unavailability acceptance,
not ten populated ownership-backed decisions. It must not be used as completion proof.

## Current cycle: title orchestration repairs
- Fixed route publication race with `create_title_research_job` (migration 032):
  jobs and wells commit atomically; missing RPC returns 503 with no unsafe fallback.
- Worker persists cited GIS surface-survey candidate tracts and associations before
  requesting review; never invents acreage or auto-confirms a producing/title tract.
- Retries preserve reviewed candidates and associations. Cancelled/review-stage
  jobs are not restarted by stale calls. Empty legacy jobs fail explicitly.
- Verification: 3 route regression tests; worker regression suite and build;
  frontend TypeScript; isolated PostgreSQL test of atomic rollback, auth gate,
  valid/invalid inputs. Actual production schema/RLS and worker remain unverified.
- Deployment order: apply migration 032, then deploy frontend and worker together.
  Existing awaiting-review jobs need a deliberate retry to create candidates.

## Outstanding blockers to the real Gaines report
- Obtain and ingest actual Gaines ownership/lease/unit instruments; no real title
  findings, verified NRI, or buyer-interest valuation have been validated here.
- Confirm the actual producing tract and review its ownership position.
- Connect due-diligence run creation to durable, account-scoped title workflow and
  reviewed report inputs. This cycle repairs title research itself, not that link.
- Diagnose live permit/completion transport failures with production worker logs;
  success on an earlier run does not prove a title-specific network defect.
- Verify lease-versus-well production, supported forecast and stated buyer inputs.
- GitHub write connection previously returned 403; these changes are local until
  published and deployed. No production or remote-success claim is made.

---
## Earlier captured-source validation history

# MineralFlow production pipeline status

**GOLD reports validated: 10/10**

Updated: 2026-09-11. Branch: `audit/decision-record-reliability`.

The full ten-case retained-source benchmark passes the GOLD2 field, calculation, rule, disclosure, chart and reviewed-render contract after regeneration. Each report contains 109 required fields, nine calculation records and eleven chart sections. Every absent field has an explicit dependency/source reason. All ten acquisition postures remain INSUFFICIENT_DATA: no real reviewed seller position/NRI, subject partner forecast or buyer economics was supplied for those cases. This count validates complete evidence-scoped work products, including honest unavailable-data outcomes; it does not establish fully populated acquisition economics or universal live-source availability.

## Last verified

- Frontend: 758 tests across 77 files passed. Populated synthetic handoff and API-delivery regressions pass. TypeScript passed after fixing the benchmark test's input typing.
- All 240 benchmark PDF pages rendered; contact-sheet layout and detailed representative pages inspected; no text outside page bounds. Review is bound to the input hash, recomputed record hash and rendered-page fingerprint. Random PDF font-subset names cannot invalidate identical renders or approve changed data.
- Independent fresh regeneration returns 10/10. Exact per-API results and unavailable-field counts: `benchmarks/gold2-latest-validation.json`. Retained visual approvals: `benchmarks/gold2-render-review.json`.
- One live standalone API run (42-165-02733) completed with 49 months of lease production and PDF/JSON delivery. Sixteen source attempts were retained; plugging, imaged documents, operator standing, compliance and inactive-status queries failed and were disclosed. Capture: `benchmarks/standalone-live-gold2-gaines.json`.
- Separate synthetic populated report exercises all eleven chart-data paths, exact NRI 3/256, twelve-month base PV $1,125, and cited TVDSS 7,050 ft. These are test inputs, not actual asset values, and do not contribute to the ten real-API cases.

## Connected in this integration cycle

- Supplied exception/decision modules and offset analytics merged without replacing audited retrieval, exact ownership arithmetic or atomic title publication. Legacy job-column valuation and narrative-derived dilution are not used as the GOLD2 acquisition basis.
- Confirmed API/tract-scoped title branches, instruments, encumbrances and cited findings feed the decision layer. Uncited findings are withheld and block evidence sufficiency. Fraction/tract mismatches trigger review independently of price.
- Reviewed ownership alternatives use the existing cashflow engine with unchanged commodity assumptions. Explicit hashed scenario-to-finding linkage is required. Multiple alternatives are not blindly summed.
- Cited formation tops, TVD/reference elevation, completion measurements, parent/child, interference and spacing-density observations map through the partner interchange with unit/reference checks.
- Acquisition posture, closing readiness, material-domain confidence, next actions and buyer-price-limit rules are connected. Missing buyer criteria never become defaults.
- Existing report download and evidence-JSON buttons deliver GOLD2. Authenticated POST accepts explicit reviewed supplements; title remains loaded under the authenticated account. A failed retrieval run can still deliver its retained evidence and gaps; the UI exposes those downloads.
- Incoming acquisition migration is numbered 030. Migration 031 reapplies the idempotent atomic publisher, covering databases that already used 029 for acquisition columns.

## Remaining external verification and boundaries

- Actual Novi schema/credentials and live payload mapping are unavailable. The tested interchange is MineralFlow-owned.
- Live authenticated Supabase end-to-end testing and migrations 029/030/031 remain unverified against a running database. Validate them in staging before deployment.
- Reports need reviewed position evidence to calculate real NRI. An API does not uniquely identify a seller or the offered interest. Public lease production is never allocated to a subject well by assumption.
- Ten retained cases plus one live API are bounded coverage, not proof that every external Texas endpoint will respond. Transport, outage, scope and missing-data states remain explicit.
- GitHub authentication was unavailable at the last push attempt. Changes are being preserved locally and in a cumulative recovery checkpoint; no deployment is claimed.

## Commands

From `frontend/`:

```sh
npm test
npx tsc --noEmit --incremental false
python3 -m pip install -r scripts/gold2-review-requirements.txt
npm run gold2:benchmark
npm run gold:report -- --api 42-165-02733 --out ../audit-work/live-report
npm run gold:report -- --api 42-165-02733 --replay ../benchmarks/standalone-live-gold2-gaines.json --out ../audit-work/replay-report
```

The Python reviewer is a development/benchmark dependency only; standalone report generation uses the existing Node pipeline. Changed data or rendered pixels require renewed visual review and cannot inherit an old approval.

## Prior audit history


**Historical status before integration: 0/10**

Latest GOLD2 cycle: all ten retained-source cases replayed; zero complete GOLD2 reports validated. Exact per-API acceptance errors are retained in `benchmarks/gold2-latest-validation.json`. This is a replay of captured retrieval, not a new live-source run. The integrated draft connects reviewed mineral ownership, partner reconciliation, royalty cashflows and decision predicates, but remains explicitly unvalidated. Subject production and selected forecast mappings are now connected and tested. Geology mappings, closing-risk classification, charts and full report acceptance remain incomplete. Frontend regression and TypeScript checks pass. Migration 029 has not been tested on a running database. Current files and all five preceding audit commits were verified in the workspace before publication.

Only complete GOLD 2.0 reports that pass the executable contract and audit gates advance this count. Legitimate unavailable-data failures are recorded separately. Prior test totals, GOLD 1.0 renders and schema-only passes do not advance this metric.

Updated: 2026-09-10. Working branch: `audit/decision-record-reliability`, based on `feat/title-chain-research` at `0e281837`.

| Area | Status | Verified / remaining |
|---|---|---|
| Asset/API resolution | IN PROGRESS | Exact API matching, current association selection, ambiguity withholding tested; arbitrary Texas scope and staging remain unverified. |
| RRC retrieval | IN PROGRESS | Ten live core-source cases captured; timeouts, missing associations and rejected queries remain. Other adapters require live validation. |
| Canonical normalization | IN PROGRESS | 8/10/12/14-digit handling, 254 county hints, phase units, missing volumes and dates tested. Offshore coverage and all adapter boundaries remain unverified. |
| Title pipeline | IN PROGRESS | Existing engine retained; persistence errors surfaced. Diligence-to-title linkage and staging end-to-end validation remain. |
| Ownership validation | NOT VERIFIED | No evidenced position-specific NRI attached to benchmark diligence runs. |
| Novi integration | IN PROGRESS | Proposed cited partner production/forecast contract, scoped reconciliation and conditional royalty scenarios implemented. Actual Novi mapping/live connection remains unverified. |
| Geology | IN PROGRESS | Existing engine retained; formation handoff and failure disclosure corrected. Full live/citation validation remains. |
| Engineering | IN PROGRESS | Calendar-gap/zero-month handling and decline regressions pass. Position-specific forecasts and live full-path validation remain. |
| Economics | IN PROGRESS | Placeholder-price valuations withheld; missing outputs null; phase handoff repaired. NRI, deal-specific assumptions and reconciliation remain. |
| Evidence/QA | IN PROGRESS | 84-field provenance contract, evidence hashes, citation checks and stale-data guards implemented. Legacy export parity and original-document provenance remain. |
| Decision Record | IN PROGRESS | Downloadable evidence JSON added. Standalone 18-section GOLD 1.0 presentation and PDF/JSON command added. Reviewed-position handoffs and reference 2.0 rule parity remain incomplete. |
| Benchmark regression suite | IN PROGRESS | Ten distinct real APIs, captured replay and CI added. Standalone GOLD rendering and worker handoff replay pass; broader live coverage and populated acquisition acceptance remain. |

**CURRENT TASK:** Connect remaining geology/source-coverage fields, measured exceptions and closing-risk classification; implement GOLD2 chart rendering and validate the actual report.

**LAST VERIFIED:**

- Publication cycle: owner-scoped published-title lookup, conflict-aware well identity/formation mappings, cited partner well measurements with explicit depth references, and integrated GOLD2 JSON/PDF delivery are implemented. The benchmark now evaluates the integrated GOLD2 draft. All ten retained-source cases remain acceptance failures (0/10); this is not live validation. Frontend: 660 tests across 69 files passed. Live title queries, migration 029, complete charts and closing rules remain unverified/incomplete.
- Latest cycle: calendar-complete subject TTM/YoY and selected forecast totals are mapped into the draft. Seven production/forecast regressions and five integrated handoff tests pass; TypeScript passes. All ten retained-source cases reran; GOLD reports validated remains 0/10. Forecast selection is independent of economic inputs.
- GOLD2 cycle: contract covers required fields, chart inputs, calculation methods, disclosures and decision predicates. Missing engine connections are acceptance failures.
- Reviewed graph holding → exact NMA/NRI → existing partner cashflow engine → commodity price grid is tested. Synthetic fixture: 40 NMA, NRI 3/256, two-month base PV $187.50; these are test values, not actual asset values.
- New `decision:gold2-draft` CLI recomputes its work product and rejects modified outputs. It emits an explicitly unvalidated draft, not a GOLD2-certified report.
- Novi transport interface validates cited payloads, subject API, cancellation and timeout behavior; no live Novi mapping/credentials are configured.
- Current frontend full run: 636 tests passed; subsequently added stale-valuation rejection and targeted handoff/ownership tests pass. TypeScript passes after the fixture correction.
- Atomic title-publication migration 029 is written and required by the new title analysis caller; database execution remains unverified. Complete-input fingerprints and exact integer parsing prevent stale/rounded ownership reuse.

Historical checks below remain diagnostic, not GOLD2 passes:

- 17 partner integration regressions pass: 10 reconciliation and 7 conditional royalty-scenario cases. The CLI executes retained synthetic evidence into a cited JSON work product.

- Frontend: 607 tests passed across 60 files.
- Worker: 92 tests passed across 8 files; worker build passed.
- Frontend TypeScript check passed.
- 10/10 captured API cases produce the complete 84-field evidence schema with valid citations/calculations or explicit gaps.
- Full ten-case live run: GIS 9/10 found; wellbore 8/10 found, one empty and one timeout; production 5/10 returned rows; permits 10/10 queries completed, including empty results.
- Separate permit-symbol case recheck recovered wellbore/GIS and returned 49 months for current gas association 131160. This does not replace the failed full-run capture.
- 10/10 captured APIs validate and render through the new 18-section GOLD 1.0 PDF/JSON path. Separate worker → standalone store → GOLD handoff tests pass for all ten.
- One full standalone public-worker run completed without a database. Its retained capture is `benchmarks/standalone-live-gaines.json`; browser-based lookups failed because Chromium was absent. A subsequent Chromium installation attempt failed after download timeouts.
- Two real captured gas histories reach the existing decline engine; the captured oil history contains internal reporting gaps and is withheld. A separate synthetic oil-history test verifies the populated engineering handoff.
- **0/10 populated acquisition decisions validated.** Title/position/NRI, subject-well forecasts and acquisition values remain unavailable. Rendering an honest report is a separate gate from having sufficient acquisition evidence.

**FAILURES / GAPS IN THE FULL LIVE RUN:**

| API | Exact condition | Current disposition |
|---|---|---|
| 42-165-00004 | Wellbore search returned no records; production requires lease + district. GIS discovery identifies a dry-hole symbol. | Production unavailable; no lease or zero production invented. |
| 42-255-00009 | Lease 00432 / district 02: oil query returned no results; gas query rejected lease number with Ewa_1011. | Incomplete lookup; lease type requires confirmation before concluding absence. |
| 42-329-00028 | Multiple historical lease associations, no unique current association. | Production withheld; lease selection required. |
| 42-329-01040 | Wellbore and GIS timed out; production lacked identifiers. | Separate recheck succeeded; original outage retained. Current gas lease 131160 used, not first historical oil row. |
| 42-151-00013 | Production retrieval timed out. | Production unavailable. Earlier diagnostic responses also showed oil no-results / gas Ewa_1011 rejection. |

**NEXT ACTION:** Connect completion/geology evidence, measured exceptions and independent closing rules to the integrated draft; implement and inspect GOLD2 charts, then rerun the ten-case acceptance gate. Validate migration 029 on a test database.

**ACCESS / IMPLEMENTATION BLOCKERS:** Standalone public retrieval does not require Supabase. Browser installation downloads timed out; browser adapters are covered by regression tests but are not live-verified here. No actual Novi payload/credentials are configured. A MineralFlow-owned production/forecast interchange is implemented; it is not an actual Novi schema. GOLD 2.0 is represented by a sample, not complete executable predicates. Reviewed mineral-position/economics linkage is now implemented in the draft; live evidence and complete report acceptance remain unverified.

See `AUDIT-DECISION-PIPELINE.md` for implementation details, validation boundaries and remaining work. See `benchmarks/README.md` for repeatable commands and retained evidence.

**PUBLICATION:** The owner explicitly reauthorized publication of all appropriate audit changes to `audit/decision-record-reliability`. Publication was attempted and blocked: Git could not read a GitHub username with terminal prompts disabled; no authenticated GitHub push is available. All six local audit commits are preserved for a cumulative bundle, binary patch and verified file checkpoint for Claude. Remote publication is not verified.

**STANDALONE COMMANDS:** See `STANDALONE-GOLD.md`. All changes remain local for Claude to push.

**PARTNERSHIP BOUNDARY:** Novi supplies data/analytics. MineralFlow normalizes, cross-checks, reconciles, calculates, compares, exposes contradictions/missing diligence, traces evidence and generates work product. The acquisition professional makes the final decision. See `NOVI-INTEGRATION.md`.

**RECOVERY:** The workspace reverted to an older snapshot. The saved 02c6727 content was recovered as commit f4064c9; the older local working files were preserved in a git stash. Integration changes after that saved checkpoint were reconstructed and tested.
