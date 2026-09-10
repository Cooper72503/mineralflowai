# MineralFlow API → Decision Record production audit

Status: **not production certified**. Date: 2026-09-09.

The repository contains substantial working retrieval, title, geology, decline, economics and report code. It does not contain the complete executable schema/ruleset represented by the GOLD 2.0 sample. This change preserves those engines, corrects confirmed boundary defects, adds regression coverage and exposes missing evidence. It is a tested engineering checkpoint, not a claim that every defect has been found or that all valid Texas APIs now produce an acquisition-ready GOLD report.

## Checkout and scope

Repository: `cooper72503/mineralflowai`. Audit branch: `audit/decision-record-reliability`. Base: `feat/title-chain-research` commit `0e281837af5c98710552828d81c253a783c8b21e`, which includes the newer title/sequencer work absent from the older `main` checkout. Review against this base to distinguish audit changes from previously existing title work.

Read-only public RRC traffic was exercised. No production database writes, deployment, or paid Novi calls were performed. Staging Supabase, EIA and Novi credentials are not configured in the runtime. No credentials should be committed or pasted into chat.

## Confirmed defects corrected

| Boundary | Defect and correction |
|---|---|
| Input → API | Reject malformed lengths/characters and non-Texas prefixes; preserve 12/14-digit suffixes rather than truncate. Accept eight-digit county/well input. Do not coerce G-prefixed identifiers into APIs. |
| County → district | Replace incorrect hard-coded maps with all 254 county office assignments from the [RRC county/district table](https://www.rrc.texas.gov/about-us/locations/oil-gas-counties-districts/). Geographic assignments are hints; retrieved lease district takes precedence. |
| API → entities | Remove fabricated API-derived lease entities. Verify the returned API before confirming identity. Keep the original API for independent lookups even when wellbore retrieval fails. |
| API → lease/operator | Prefer matching on-schedule associations, withhold ambiguous lease mappings, and take operator/county from the selected row. Reports select the matching association rather than the first historical row. |
| GIS | Correct eight-digit query extraction; reject HTTP/ArcGIS errors, mismatched APIs and invalid coordinates. Preserve subsidiary-query errors. Multiple intersecting survey polygons no longer become an arbitrary unique survey. |
| Production retrieval | Separate query rejection, empty response, parser failure and HTTP failure. Reject malformed numeric prefixes. Keep lease-type outcomes instead of describing source rejection as a generic parse error. |
| Production handoff | Reject mismatched lease/district, invalid dates/volumes and conflicting duplicate months. Store monthly dates as YYYY-MM-01; surface persistence failures. |
| Production → engines | Keep missing volumes missing; include reported casinghead gas in gas inputs; reject calendar gaps/duplicates. Do not report unavailable offers as $0. |
| Decline calculation | Internal zero months no longer compress elapsed time. Preserve the existing fitting algorithm with correct time coordinates. Withhold restart forecasts when the last observation is zero, and reject nonfinite inputs. |
| Economics | Do not value placeholder fallback price decks. Require both explicit prices for interactive recalculation. Include reported zero-water months in averages and withhold disposal modeling on incomplete water data. Generic screening assumptions remain disclosed and are not promoted into position-specific acquisition values. |
| Worker lifecycle | Failed evidence/progress/production writes stop completion. Missing prerequisites get explicit attempts. Cancellation is protected from terminal/progress overwrites. Claim/failure writes are checked. |
| Title retrieval | Verify returned well identity; check database/storage writes instead of silently continuing. Preserve the existing tract-confirmation and analysis workflow. |
| Evidence selection | Latest attempt wins. Failed refreshes cannot be hidden by older successes. Stopped stamping coverage with today's date as if source data were current. |
| Main report/dashboard reads | Surface evidence-load errors; preserve attributes_json; recompute coverage. Exclude persisted production that is unsupported by the latest successful production payload. |
| Scorecard | Missing orphan/inactive evidence is not a clean plugging result. Missing violation count is not zero. Read the operator adapter's record shape. Fix confidence denominator; remove consistency credit for unreported volumes and unsupported activity wording. |
| Report errors | Distinguish failed offset/geology execution from unattempted work. Surface geology persistence failure. |

## Evidence contract and Decision Record

`frontend/lib/trrc/decision-record.ts` defines an explicitly versioned **provenance-1.0.0** contract with 84 required fields. Each is observed, calculated, unavailable or insufficient_data. Observed values point to retained parsed source payloads; calculations have registered methods and input references. Validation checks required fields, finite values, evidence hashes, citation pointers and deterministic API/posture derivations.

The authenticated `/api/trrc/due-diligence/[runId]/decision-record` endpoint and dashboard download expose this JSON. It does **not** claim to implement GOLD 2.0. Title, NRI, well-level vendor production, position-specific economics and closing readiness remain explicitly unavailable when the required inputs/handoffs do not exist. All benchmark postures are INSUFFICIENT_DATA.

Hashes cover parsed payloads, not original HTML, county instruments or the authenticity of a source. Most URLs are source portals, not permanently addressable result pages; GIS retains a query URL. Field presence and valid provenance are necessary but insufficient for source freshness, complete search scope or substantive investment readiness.

## Verification

The maintained counts and exact live failure table are in `PIPELINE-STATUS.md`. Commands and evidence are in `benchmarks/README.md`.

- Offline tests cover normalization, actual captured source shapes, failed refresh, association mismatch, database failure, missing/invalid volumes, elapsed-time decline fitting, price unavailability, contract tampering and source outages.
- The worker benchmark replays the entire deterministic sequence using an in-memory Supabase double. Uncaptured adapters explicitly fail; this is **not** a real database or live full-adapter integration test.
- Ten real, diverse API identifiers have public RRC discovery evidence. The completed ten-case live run is retained, including failures. A separate permit-symbol recheck documents recovery and current gas-lease matching.
- The evidence JSON regression exercises every required field for all ten APIs. This is not ten complete acquisitions or a 50-API benchmark.
- Existing PDF rendering is checked separately. Successful rendering does not establish GOLD schema parity or validate every legacy narrative conclusion.
- CI runs frontend tests/typecheck and worker tests/build. Live retrieval stays explicit and separate; unavailable third-party sources must not make ordinary CI flaky.

## Open release gates

1. **Executable GOLD contract and rules:** map the approved sample to a machine-readable schema, field-level requiredness, units, evidence scope, decision rules, closing readiness, and testable acceptance cases. The new provenance contract is an audit safeguard, not a substitute approved by the owner.
2. **Diligence → title → ownership:** link the evaluated tract/position and reviewed instruments to the diligence run. An API identifies a well, not the conveyed mineral interest. Validate fractions, burdens, effective dates and allocation before NRI/owner economics.
3. **Novi integration:** implement or supply the real adapter contract, credentials and representative response fixtures; preserve per-well vs regulator lease scopes; define reconciliation tolerance and missing-period treatment.
4. **All-source live validation:** browser/county adapters, completion/plugging/compliance and historical lease transitions require live staging cases. Core-source success does not certify these adapters. Confirm lease types for ambiguous production responses; do not choose a type merely to make an error disappear.
5. **Legacy report/export parity:** archive, manifest, spreadsheet, CSV and other older read paths need the same latest-evidence and scope enforcement. Some legacy narratives and scores remain screening proxies rather than fully cited material conclusions. PDF smoke tests do not clear this gate.
6. **Geology/engineering sufficiency:** verify formation/bench/tract scope, direct vs proxy measurements, valid production periods, water/condensate/NGL completeness, forecast suitability and source lineage before using outputs as deal conclusions. Strict missing-period handling may withhold a fit even when part of the history is usable; a justified reporting-window policy is still needed.
7. **Economics:** reviewed NRI, price/cost/tax assumptions, horizon, uncertainty and buyer criteria must feed the existing engine. Placeholder prices are blocked, but generic screening cost defaults and gross-lease calculations are not position-specific acquisition values.
8. **Texas identifier scope:** current county validation is the 254 onshore counties. Offshore/special codes and exact sidetrack/completion evidence need explicit support or a documented supported-scope contract; base-API lookup does not verify a 14-digit completion identity.
9. **Real persistence/lifecycle:** run migrations/RLS/storage, concurrent claims, retries, cancellation, stale-job recovery, actual job failures and report downloads in staging. In-memory tests cannot prove Postgres constraints or deployed worker/frontend compatibility.
10. **Production acceptance:** run the complete authenticated API → worker → database → linked engines → validated GOLD JSON/PDF path for the benchmark, then expand the set with long histories, horizontal/vertical wells, historical associations, gas/oil/condensate, plugged/dry/permit cases, difficult counties and valid missing-record inputs. Define latency, retry and availability thresholds. Do not count an unavailable field as retrieved data.

The pipeline should not be represented as production-ready for the October 6 meeting until these gates have evidence. The tracker records progress without converting test counts into an unsupported percentage of product completion.


## Standalone GOLD checkpoint (September 9)

Added `frontend/scripts/gold-report.ts` and `gold:benchmark`. The live command runs the existing worker through a local checkpointing store, then builds one provenance record used by both the GOLD PDF and JSON. The eighteen sections cover all 84 current fields. Forecasts call the existing Arps engine with preserved calendar gaps and explicit lease scope. Derived rules, coverage, assumptions, section mappings and forecasts are revalidated before rendering. Embedded licensed Nimbus fonts make the PDF portable; production and source-inventory pagination were visually checked.

New tests exercise ten real captured APIs through GOLD rendering and separately through the actual worker → local store → GOLD assembly. Local persistence tests cover cancellation, composite-key upserts, detached checkpoints and write failure. A live public-worker run is retained in `benchmarks/standalone-live-gaines.json`; its Chromium failures remain part of the evidence. Browser download retries timed out in this runtime.

Further retrieval defects found and repaired: compliance no longer reports an empty search when no form was submitted or the response was unparseable; unknown open status stays null. Operator pickers require a unique exact identity. P-5 detail identity is verified. Inactive records must match the subject API, and a shut-in date is not a plugging deadline. The Decision Record no longer relabels lease names as well names and rejects unrelated/out-of-range GIS coordinates.

This is not completion of the acquisition pipeline. Reviewed title/position, ownership/NRI, subject-specific engineering/economics, Novi reconciliation, full geology handoff and web/bulk export parity remain open. `STANDALONE-GOLD.md` states the executable boundary and reproduction commands.


## Novi decision-layer integration milestone (September 10)

Added a MineralFlow-owned cited production/forecast interchange, independent same-period lease reconciliation, and conditional royalty scenarios driven by explicit deal assumptions. Existing forecast engines are preserved; supplied partner forecasts are consumed directly. Tests cover duplicate identities/months, unit conversion, null volumes, ambiguous/incomplete membership, zero denominators, contradictions, forecast version mixing, missing forecast horizons, invalid NRI, gross/net basis and price sensitivity. The CLI retains both source evidence sets and calculation inputs. The 17 integration tests pass; full suite now 607 frontend + 92 worker tests.

This is preparation for the Novi integration, not a live Novi adapter or completed acquisition recommendation. Title linkage, measured exceptions, closing rules, remaining partner domains and GOLD/UI/bulk integration remain open. See NOVI-INTEGRATION.md.
