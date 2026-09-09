# MineralFlow production pipeline status

**OVERALL: IN PROGRESS — production completion percentage not yet verifiable.**

A percentage will be calculated from agreed, testable GOLD Decision Record acceptance gates. Passing a schema with disclosed missing data does not establish investment readiness. The available repository does not contain the GOLD sample's complete schema/ruleset 2.0.0 implementation. This tracker uses observed results, not the example 43% or 42/50 figures.

Updated: 2026-09-09. Working branch: `audit/decision-record-reliability`, based on `feat/title-chain-research` at `0e281837`.

| Area | Status | Verified / remaining |
|---|---|---|
| Asset/API resolution | IN PROGRESS | Exact API matching, current association selection, ambiguity withholding tested; arbitrary Texas scope and staging remain unverified. |
| RRC retrieval | IN PROGRESS | Ten live core-source cases captured; timeouts, missing associations and rejected queries remain. Other adapters require live validation. |
| Canonical normalization | IN PROGRESS | 8/10/12/14-digit handling, 254 county hints, phase units, missing volumes and dates tested. Offshore coverage and all adapter boundaries remain unverified. |
| Title pipeline | IN PROGRESS | Existing engine retained; persistence errors surfaced. Diligence-to-title linkage and staging end-to-end validation remain. |
| Ownership validation | NOT VERIFIED | No evidenced position-specific NRI attached to benchmark diligence runs. |
| Novi integration | NOT CONNECTED | No live Novi adapter/credentials or well-to-lease reconciliation contract available in this checkout. |
| Geology | IN PROGRESS | Existing engine retained; formation handoff and failure disclosure corrected. Full live/citation validation remains. |
| Engineering | IN PROGRESS | Calendar-gap/zero-month handling and decline regressions pass. Position-specific forecasts and live full-path validation remain. |
| Economics | IN PROGRESS | Placeholder-price valuations withheld; missing outputs null; phase handoff repaired. NRI, deal-specific assumptions and reconciliation remain. |
| Evidence/QA | IN PROGRESS | 84-field provenance contract, evidence hashes, citation checks and stale-data guards implemented. Legacy export parity and original-document provenance remain. |
| Decision Record | IN PROGRESS | Downloadable evidence JSON added. Full GOLD 2.0 report/schema/decision rules not implemented in this checkout. |
| Benchmark regression suite | IN PROGRESS | Ten distinct real APIs, captured replay and CI added. Full staging pipeline and GOLD report acceptance remain. |

**CURRENT TASK:** Save the verified engineering checkpoint and maintain the remaining release gates.

**LAST VERIFIED:**

- Frontend: 563 tests passed across 56 files.
- Worker: 78 tests passed across 6 files; worker build passed.
- Frontend TypeScript check passed.
- 10/10 captured API cases produce the complete 84-field evidence schema with valid citations/calculations or explicit gaps.
- Full ten-case live run: GIS 9/10 found; wellbore 8/10 found, one empty and one timeout; production 5/10 returned rows; permits 10/10 queries completed, including empty results.
- Separate permit-symbol case recheck recovered wellbore/GIS and returned 49 months for current gas association 131160. This does not replace the failed full-run capture.
- **0/10 full GOLD 2.0 Decision Records validated.** 10/10 existing PDF benchmark render checks also pass, but are not equivalent to this gate.

**FAILURES / GAPS IN THE FULL LIVE RUN:**

| API | Exact condition | Current disposition |
|---|---|---|
| 42-165-00004 | Wellbore search returned no records; production requires lease + district. GIS discovery identifies a dry-hole symbol. | Production unavailable; no lease or zero production invented. |
| 42-255-00009 | Lease 00432 / district 02: oil query returned no results; gas query rejected lease number with Ewa_1011. | Incomplete lookup; lease type requires confirmation before concluding absence. |
| 42-329-00028 | Multiple historical lease associations, no unique current association. | Production withheld; lease selection required. |
| 42-329-01040 | Wellbore and GIS timed out; production lacked identifiers. | Separate recheck succeeded; original outage retained. Current gas lease 131160 used, not first historical oil row. |
| 42-151-00013 | Production retrieval timed out. | Production unavailable. Earlier diagnostic responses also showed oil no-results / gas Ewa_1011 rejection. |

**NEXT ACTION:** Complete report/export parity checks, then run the full worker → database → engines → GOLD report path in staging after the actual GOLD schema/ruleset and environment are available. Do not count missing or unconnected data as a successful acquisition decision.

**ACCESS / IMPLEMENTATION BLOCKERS:** No configured staging Supabase, EIA or Novi credentials in this environment. Credentials must be configured securely in the runtime, not pasted into chat. GOLD 2.0 is represented by a sample document, not a complete executable contract in this repository.

See `AUDIT-DECISION-PIPELINE.md` for implementation details, validation boundaries and remaining work. See `benchmarks/README.md` for repeatable commands and retained evidence.

**PUBLICATION:** Changes committed locally. GitHub push was blocked by automatic approval review because remote publication of code/retrieval artifacts was not explicitly authorized. No deployment or remote publication occurred. A reviewable checkpoint archive contains the patch and this tracker.
