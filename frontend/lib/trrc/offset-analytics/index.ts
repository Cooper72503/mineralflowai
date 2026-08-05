/**
 * Offset Analytics Engine
 *
 * Evaluates unproducing or insufficiently-producing land assets using
 * nearby producing analog wells: legal description → geocoded tract →
 * true-radius offset well search → formation-qualified analog selection →
 * per-well independent decline fitting → composite type curve →
 * ownership-adjusted, risked/unrisked proxy valuation.
 *
 * ── Phase 0 audit summary (2026-08-04) ──────────────────────────────────
 *
 * Architecture decision: this module lives under frontend/lib/trrc/, not
 * a separate Python package. The whole repo is TypeScript end to end
 * (Next.js frontend, Node/TS worker) — there is no Python anywhere and no
 * documented reason to introduce it. The worker (worker/src/) has no HTTP
 * server at all (confirmed: no express/fastify/createServer) — it's a
 * polling background process with no synchronous call path from the
 * frontend, so this engine cannot call into the worker's TRRC fetchers
 * mid-request. It follows the SAME pattern already established by
 * offset-wells.ts, lateral-path.ts, and type-curve-comparison.ts: a
 * frontend-side module that queries TRRC's public EWA/GIS endpoints
 * directly, invoked from report-builder.ts during PDF generation
 * (server-side, inside a Next.js API route).
 *
 * PostGIS: not currently enabled on the Supabase Postgres instance (no
 * spatial extension or geometry/geography column in any of the 21 real
 * migrations under supabase/migrations/). It COULD be enabled via a new
 * migration — Supabase supports the postgis extension natively — but nothing
 * in this codebase queries Supabase for well/production data today; TRRC
 * data is fetched live per-run, not stored in a queryable spatial table.
 * Given that, Phase 5's "true radius search" is implemented as a true
 * geodesic (haversine) distance calculation against wells fetched from
 * TRRC's own ArcGIS REST layer, with a bounding-box pre-filter only to
 * keep the ArcGIS query itself narrow — not PostGIS ST_DWithin, but not a
 * bounding box masquerading as a radius either. If/when well and production
 * data ever moves into a real queryable store, ST_DWithin is the natural
 * upgrade path and this module's WellSearchProvider interface (well-
 * search.ts) is written so that swap doesn't touch calling code.
 *
 * Prior art found in archive/frontend/lib/underwriting/ and
 * archive/frontend/lib/location/ (offset-intelligence-engine.ts,
 * legal-description-parser.ts, property-geocode.ts,
 * trrc-abstract-lookup.ts, formation-intelligence.ts) — a real, substantial
 * prior attempt at this exact problem. Reused where legitimate, NOT reused
 * where it repeats the failure modes this rebuild exists to fix:
 *   - REUSED (adapted): the real 254-county Texas FIPS-style abstract-
 *     prefix table and the OTLS (Original Texas Land Survey) ArcGIS polygon
 *     service in trrc-abstract-lookup.ts; the BLM PLSS meridian-math
 *     fallback in property-geocode.ts (legitimate geodetic math, not
 *     fabricated coordinates — though Texas itself was never surveyed
 *     under federal PLSS, so that path only matters for non-Texas
 *     expansion, not this project's actual TX subject wells); the per-well
 *     independent decline-fit pattern in offset-intelligence-engine.ts
 *     (fits each well before aggregating, doesn't average raw histories).
 *   - NOT reused, rebuilt from scratch: offset-intelligence-engine.ts's
 *     valuation math computed `pv10 = peakMonthly * annuityFactor` (not a
 *     real discounted monthly cash flow) and derived "net mineral acres
 *     owned" as `acreage * NRI * 8` — a hardcoded 1/8 royalty-baseline
 *     assumption presented as if it were real ownership data. Both are
 *     exactly the failure modes this engine's non-negotiable principles
 *     forbid. This rebuild uses the real monthly decline-curve forecast
 *     already in decline-curve.ts and economics.ts (this session's work —
 *     real Texas statutory tax rates, real basin-benchmark disclosure,
 *     real breakeven-price math) as the valuation foundation instead, and
 *     never computes an owner-level PV-10 without validated ownership
 *     inputs (see ownership-economics.ts).
 *   - formation-intelligence.ts's basin/formation data was used only for
 *     narrative report text and as an EUR fallback benchmark — never as an
 *     analog-qualification filter. This rebuild's formation-normalization.ts
 *     is a genuine qualification/rejection step (Phase 7), which is new,
 *     not a port.
 *
 * Production data granularity: TRRC's production query is LEASE-level, not
 * well-level (see worker/src/tools/ewa.ts's getProduction and this
 * project's own decline-curve.ts caveat) — every analog's production
 * history carries that same caveat and it is propagated into this engine's
 * provenance/warnings, not silently dropped.
 *
 * ── Module layout ────────────────────────────────────────────────────────
 *   types.ts                    shared schemas (legal description, geocode,
 *                                analog, provenance, confidence, output)
 *   errors.ts                   domain-specific error classes (Phase 18)
 *   constants.ts                shared constants
 *   legal-description.ts        TX land grid + PLSS parsing (Phase 2)
 *   providers/texas-land-grid.ts  OTLS polygon + county-FIPS geocoding (Phase 3)
 *   providers/plss.ts           BLM PLSS geocoding (Phase 3)
 *   geocoding.ts                provider selection + orchestration (Phase 3)
 *   geometry.ts                 GeoJSON validation, CRS, distance (Phase 4)
 *   well-search.ts              true-radius offset well search (Phase 5)
 *   candidate-filtering.ts      status/history/duplicate filtering (Phase 6)
 *   formation-normalization.ts  canonical formation/landing-zone match (Phase 7)
 *   analog-scoring.ts           transparent multi-factor scoring (Phase 8)
 *   analog-selection.ts         top-N selection + status (Phase 9)
 *   production-loader.ts        analog production fetch (Phase 10)
 *   analog-decline-fitting.ts   per-well independent Arps fit (Phase 11)
 *   composite-profile.ts        parameter + type-curve aggregation (Phase 12)
 *   tract-scaling.ts            development-case assumptions (Phase 13)
 *   ownership-economics.ts      royalty/WI/NMA-only handling (Phase 14)
 *   proxy-valuation.ts          risked/unrisked PV-10 (Phase 15)
 *   confidence.ts               per-dimension confidence model (Phase 16)
 *   service.ts                  orchestrates all of the above into the
 *                                versioned output payload (Phase 17)
 *
 * Everything under providers/ is the only place that makes HTTP calls —
 * geometry.ts, formation-normalization.ts, analog-scoring.ts, the decline/
 * composite/valuation modules are pure functions with no I/O, matching
 * non-negotiable principle #10.
 */

export * from "./types";
export * from "./legal-description";
export * from "./geocoding";
export * from "./geometry";
export * from "./well-search";
export * from "./candidate-filtering";
export * from "./formation-normalization";
export * from "./analog-scoring";
export * from "./analog-selection";
export * from "./production-loader";
export * from "./analog-decline-fitting";
export * from "./composite-profile";
export * from "./tract-scaling";
export * from "./ownership-economics";
export * from "./proxy-valuation";
export * from "./confidence";
export { runOffsetAnalytics, type RunOffsetAnalyticsInput } from "./service";
export * from "./errors";
export * from "./constants";
export * from "./observability";
