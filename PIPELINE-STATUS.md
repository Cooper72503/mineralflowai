# MineralFlow production pipeline status

**GOLD reports validated: 0/10**

Latest GOLD2 cycle: all ten retained-source cases replayed; zero complete GOLD2 reports validated. Exact per-API acceptance errors are retained in `benchmarks/gold2-latest-validation.json`. This is a replay of captured retrieval, not a new live-source run. The integrated draft connects reviewed mineral ownership, partner reconciliation, royalty cashflows and decision predicates, but remains explicitly unvalidated. Subject production and selected forecast mappings are now connected and tested. Geology mappings, closing-risk classification, charts and full report acceptance remain incomplete. Frontend regression and TypeScript checks pass. Migration 029 has not been tested on a running database. A transient workspace disconnection recovered; changes remain local for Claude to push.

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

**PUBLICATION:** The owner authorized publication, but the push failed because this workspace has no GitHub authentication. The owner subsequently directed that work remain local and Claude will push the finished codebase. No further push is planned.

**STANDALONE COMMANDS:** See `STANDALONE-GOLD.md`. All changes remain local for Claude to push.

**PARTNERSHIP BOUNDARY:** Novi supplies data/analytics. MineralFlow normalizes, cross-checks, reconciles, calculates, compares, exposes contradictions/missing diligence, traces evidence and generates work product. The acquisition professional makes the final decision. See `NOVI-INTEGRATION.md`.

**RECOVERY:** The workspace reverted to an older snapshot. The saved 02c6727 content was recovered as commit f4064c9; the older local working files were preserved in a git stash. Integration changes after that saved checkpoint were reconstructed and tested.
