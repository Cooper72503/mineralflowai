# Mineral Finder: audit, Gaines pilot and deployment

Audited against `origin/main` **40d383a82d279fab8eaddac3f02c7a1fb0c77f38** (2026-11-13).
Research and implementation verified 2026-11-23. This is a **research discovery slice**, not an automated reserve assessment or acquisition approval.

## Existing infrastructure reused

| Capability | Existing implementation | Use in Mineral Finder |
| --- | --- | --- |
| App, auth and account isolation | Next.js app router; `lib/supabase/from-route-request.ts`; `lib/trrc/use-api-fetch.ts` | Existing signed-in app shell, shared fetch and owner-scoped API routes |
| Texas API normalization | `lib/trrc/title/api-input.ts`, `normalization.ts` | Same validated API10 core; retain full catalog IDs; do not invent completion suffixes |
| Well map | `lib/trrc/well-map/gis.ts`, Leaflet and `proj4` dependencies | Same official RRC GIS base and existing map libraries; new prospect markers from persisted results |
| Regulatory retrieval | `worker/src/tools/ewa.ts`, `sequencer.ts` | Reuse existing production connector, not a second HTML production parser; detailed regulatory diligence remains in the existing engine |
| Lease production and records | `trrc_resolved_entities`, `trrc_source_attempts`, `trrc_production_monthly` | New prospect handoff opens existing package intake using `?apis=`; shared leases queried once per research pass |
| Geology | `lib/trrc/geology/*`, `offset-analytics/formation-normalization.ts`; migration 023 | Reuse named-formation normalization; do not promote field text to verified producing intervals |
| Forecast and economics | `decline-curve.ts`, `economics-provider.ts`, `deal/*` | Existing Arps lease decline only when the reported months support it. No existing producing-lease cash flow is reused as a plugged-well restart forecast |
| Title and ownership | `title_research_jobs`, `title_documents`, `title_analyses`; reviewed mineral position engine | Existing package intake creates/links title scope. Operator identity does not establish ownership or available acquisition rights |
| Reports | React PDF; licensed Nimbus Sans fonts; existing Decision Record engine | New prospect PDF from exactly the saved screening result; same font assets, explicitly included in Next tracing |
| Worker/deploy | Node poller; full-repository esbuild bundles; worker `dist/` deployment | One additional fenced research poller and bundled shared engine; no separate application |
| Well logs | migration 023 `well_log_files`, `well_log_curves`, `petrophysical_results` and deterministic petrophysics helpers | Reuse for a later document/curve ingestion stage. Current `assessPetrophysics` is explicitly not connected; do not pretend these schemas are a working log interpreter |

## External source verification and access

### RRC

Official free downloads: https://www.rrc.texas.gov/resource-center/research/data-sets-available-for-download/

The live monthly wellbore CSV was downloaded through its publicly offered GoDrive download action, not by crawling the interactive EWA search to enumerate a county:
https://mft.rrc.texas.gov/link/650649b7-e019-4d77-a8e0-d118d6455381

The latest listed file during validation was `OG_WELLBORE_EWA_Report_2026-11-03.csv`. It contained 1,371,624 physical record lines, of which 16,267 were Gaines associations. Layout comes from the official 59-field manual:
https://www.rrc.texas.gov/media/di1mm5or/og_wellbore_ewadefinitionmanual2013-10-30_subscription.pdf

Actual source defect: Dimmit row 464963 contains an improperly escaped quote in a well number. Mineral Finder filters the fixed county prefix before strictly parsing selected county rows. It never repairs malformed county records; malformed Gaines rows fail the snapshot. Original county rows and physical line references are retained. A SHA256 covers the full downloaded CSV.

Locations come from the public query service already used by MineralFlow:
https://gis.rrc.texas.gov/server/rest/services/rrc_public/RRC_Public_Viewer_Srvs/MapServer

Both well-location layer 1 and horizontal surface layer 9 are enumerated with count-checked keyset pagination. Gaines returned 13,827 GIS features; merged wellbore/GIS inventory contained 11,528 distinct API10 cores. Conflicting active associations or materially different coordinates are withheld rather than assigned arbitrarily.

RRC map symbols are not a source of drilling dates, producing intervals or verified production. Completion before a cutoff establishes earlier drilling **by that date**, not an exact spud date. Later recompletions do not prove the original drilling was later.

Existing EWA production retrieval supplies its current history window, not the entire historic lifetime. RRC offers a separate production-query CSV dump from 1993 onward and full wellbore/completion downloads; these are follow-on bulk integrations. Oil lease volumes must not be allocated to individual plugged or marginal wells without allocation evidence. Pre-1993 history, water and per-well volumes can be unavailable. This pilot does not assert countywide economic coverage.

Use published downloads and documented interfaces; honor source policies and seek an agreed bulk feed before high-volume commercial refreshes. No access restriction is bypassed.

### BEG CONTINUUM

Verified active layer:
https://coastal.beg.utexas.edu/arcgis/rest/services/continuum/continuumsearch/MapServer/1

Verified schema: `ItemId`, `ApiNumber`, `CountyName`, `StateName`, `Collection`, `LogTypes`, `Formation`, `MaterialType`, top/bottom depths, `SurfaceLatitude`, `SurfaceLongitude`, `CoordsUncertain`, accession, facility and date fields. JSON querying, counts, ordering and pagination work. Advertised maximum is 2,000 records; connector uses 1,000-row keyset pages by unique `ItemId`. `ESRI_OID` is hash-derived; it is not used as the paging identity.

Real Gaines query: 7,349 collection items. Of these, 1,415 lacked a usable API, 244 had a formation attribute, 422 had a drill date, and 1,647 flagged uncertain coordinates. A metadata formation describes catalog material; it is not necessarily a producing completion. API10 joins are wellbore-core joins; full original catalog identifiers remain available for sidetrack/completion review.

Catalog completeness is explicitly disclaimed by BEG:
https://www.beg.utexas.edu/about/facilities/geophysical-log-facility
https://www.beg.utexas.edu/about/facilities/austin-core-research-center

A query-capable endpoint and blank ArcGIS copyright text do **not** establish commercial bulk retention, resale or scan-download rights. Public catalog access was tested for this research. Production catalog ingestion defaults OFF until `MINERAL_FINDER_BEG_METADATA_ACCESS=approved` is set after confirmation with BEG. No scanned logs, paid files or attachment URLs are downloaded.

Published scan price checked 2026-11-23: **$10 per log**, TIFF, not $10 per survey/page, not LAS. The application fetches and verifies that published price; if it cannot verify it, the price remains unavailable/quote required. Core viewing/analysis and reproduction/commercial rights are separate. BEG store reproduction terms also require review: https://store.beg.utexas.edu/about . Contact `glf@beg.utexas.edu` for log availability and permission terms. No purchase or outbound email is executed by this feature.

### Additional geology

USGS Texas historical log release, DOI **10.5066/P973SMX5**, version 2.1 September 2025:
https://www.usgs.gov/data/a-dataset-scanned-historical-well-and-geophysical-logs-229-counties-texas-1918-2020-ver-21

Official release describes 15,475 logs from 229 counties, scanned PDFs with CSV/Access header data, marked CC0. It is a feasible additional adapter after county/API/depth coverage review; many water-science records do not establish hydrocarbon pay. The linked ScienceBase download was not validated successfully in this environment, so **no USGS ingestion is claimed**.

TWDB BRACS is another public log catalog to evaluate: https://www.twdb.texas.gov/groundwater/bracs/WellLogs.asp . BEG publications/maps can contextualize geology but require item-level access/reproduction review. None is treated as a substitute for local reservoir evidence.

## Architecture and database changes

Existing app -> authenticated enqueue RPC -> existing Node worker -> county source/cache ingestion -> shared deterministic screen -> fenced immutable result snapshot -> map/table/prospect page/PDF. Existing package intake is the handoff for detailed title, ownership, regulatory and economics workflows.

Migration **044** adds:

- `mineral_finder_jobs`: owner-read-only research requests/results; one request key per account; max two active runs; queue/claim/recovery state.
- `mineral_finder_snapshots`: service-only source cache with explicit expiry. Original source fetch dates and raw evidence are retained. This is a pilot JSON cache; large-scale ingestion should partition catalog/association rows and immutable object storage by source release.
- `mineral_finder_wells`: normalized API10 inventory with county/latitude/longitude index. County bounding boxes can use the index; true radius distances are calculated with Haversine. No changes to existing PostGIS schemas.
- Authenticated-only `enqueue_mineral_finder`; service-only `claim_mineral_finder` and `finish_mineral_finder`. Claim tokens fence late workers; heartbeat extends leases; expired work recovers with an attempt limit.

RRC bulk cache expires after 7 days; GIS/production after 24 hours; BEG catalog after 7 days; published prices after 24 hours. Source failures never become confirmed empty results. RRC inventory failure prevents completion; optional catalog/production/price failures remain explicit in the research result. ArcGIS count changes, pagination repeats, malformed county CSV or ambiguous identities are not silently accepted. Requests have bounded timeouts/retries and pagination limits. Catalog requests are sequential and paced.

## Screening and purchase rules actually implemented

- County, historical cutoff, radius, selected recorded statuses and maximum 25 leads.
- Default: Gaines; before 1995; plugged/shut-in; 3 miles; 25 results.
- Production enrichment is bounded to the initially selected research leads and up to 30 unique subject/offset leases. This cannot establish all county opportunities or all marginal wells. Same-lease results are reused rather than summed across wells.
- Offsets require distance, identical RRC field number/district, compatible named formation and recorded producing classification. They remain **field/reservoir proxies**; no verified interval, continuity or pressure communication is asserted. Offsets across county boundaries are not yet loaded.
- Research priority adds disclosed evidence points (maximum 90). It is not expected investment value or probability of success. Geological confidence remains **low** while logs and intervals are unverified.
- Conservative one-useful-subject-log recommendation using catalog type/depth availability. It avoids duplicates and excludes depth-control-only entries. It is a preliminary acquisition shortlist, not proven optimal information value; matching log depth to an established target interval still requires review.
- No buy recommendation, remaining reserves, bypassed-pay declaration, restart rate or value is produced from catalog/offset evidence alone. Individual plugging forms/compliance have not been checked merely because a bulk status exists.
- Existing user-entered economics can be investigated through the existing package engine, but that is not an automatically supported redevelopment forecast.

## Prioritized remaining deliverables

1. **Deploy and run signed-in acceptance**: apply 044, ship both tiers, submit/reopen a Gaines research run, verify saved result/PDF and real cross-account isolation. Local database policy tests are not live-auth acceptance.
2. **Reservoir qualification**: ingest full wellbore and completion intervals/formation evidence; read cited W-2/G-1/W-3 files; load a county-border buffer. Replace proxies only when a verified producing interval actually exists.
3. **History coverage**: stream/join official 1993-present bulk lease production, preserve missing months and historical lease changes; use real allocation evidence for individual-well rates. Add marginal detection only after this.
4. **Geological evidence**: BEG commercial metadata confirmation; USGS header/archive adapter; link purchased/uploaded scans to existing `well_log_files`; persist hashes, pages, calibrated depth/curves and reviewer-supported observations. Reuse petrophysics helpers after numeric-input and methodology review. Reading raster text does not extract trustworthy continuous log curves automatically.
5. **Acquisition economics**: connect reviewed wellbore/mineral/operating rights, reentry feasibility, workover/plugging liabilities, measured costs and geologist/engineer-supported redevelopment forecasts into existing economics. No value until necessary inputs are evidenced or explicitly disclosed assumptions.
6. **Purchase optimization**: target-interval coverage, existing licensed inventory and alternative free sources before recommending paid records; human-approved order workflow, no automatic spending. Formal expected information value needs calibrated probabilities/decision outcomes and is not claimed by the v1 heuristic.
7. **Expansion**: repeat real-source acceptance for Fisher, then additional counties. Gaines is the only county validated live in this checkpoint; statewide support is not claimed.

## Deployment

1. Apply migration 044 after existing migrations through 043. No existing table is rewritten.
2. Full repository: `npm ci --prefix frontend`, install worker dependencies, then `npm run build --prefix worker`. Ship **all worker dist files**, including `mineral-finder-engine.mjs`, through the existing worker deploy process.
3. Set `MINERAL_FINDER_ENABLED=true` in both Vercel and worker environments. The worker's new poller stays disabled otherwise. For BEG commercial ingestion, set `MINERAL_FINDER_BEG_METADATA_ACCESS=approved` only after access/reuse confirmation.
4. Deploy frontend; `/mineral-finder` is in the existing sidebar. Font tracing includes the new PDF endpoint.
5. Signed in: submit request -> note parsed filters -> close tab -> reopen run from history -> inspect actual source coverage, map and selected API -> download PDF -> hand off through existing due-diligence intake.
6. Verify another account gets 404 and unauthenticated routes get 401. Test worker restart recovery and do not count a browser-only fixture as live acceptance.

No Supabase production credentials were present in this environment; migration and deployed authenticated flow were not exercised here. No production configuration, worker or database was changed by this checkpoint.

## Reproduce a real-source pilot without database access

From `frontend/` with frontend and worker dependencies installed:

```sh
node --import tsx ../scripts/mineral-finder-live.mts --county GAINES --before 1995 --limit 25 --beg-catalog-research --output /tmp/mineral-finder-live
node --import tsx ../scripts/mineral-finder-acceptance.mts /tmp/mineral-finder-live
```

`--beg-catalog-research` deliberately enables a local metadata research probe; it is not commercial licensing approval. `--replay` reuses exact captured sources and their timestamps; omit it for a fresh download. The CLI writes source captures, normalized snapshot, result JSON, full prospect PDF and (acceptance command) one selected-prospect PDF. These are real public-source research leads, never fabricated opportunities.

Database guard tests:

```sh
node supabase/tests/mineral-finder.mjs /absolute/path/to/@electric-sql/pglite/dist/index.js
```

Local UI inspection with real captured results was attempted; the environment prevented Chromium from starting. A browser screenshot or authenticated production UI pass is **not** claimed. Production builds, source-record validation, PDF rendering and isolated PostgreSQL guard tests are the completed verification gates.
