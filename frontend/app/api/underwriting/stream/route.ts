/**
 * /api/underwriting/stream — Full Underwriting Pipeline (SSE)
 *
 * POST body: UnderwritingInput (same schema as /api/underwriting)
 * Response:  text/event-stream — Server-Sent Events
 *
 * Each event: `data: <JSON>\n\n`
 *   PipelineProgressEvent  — step started / completed / failed
 *   PipelineReportEvent    — final DDReport (last substantive event)
 *   PipelineDoneEvent      — stream complete with total duration
 *   PipelineErrorEvent     — fatal error before report was built
 *
 * Pipeline (sequential — never parallel):
 *   1  normalize         Parse & validate all inputs
 *   2  parse_documents   AI OCR extraction FIRST — so API/lease IDs from docs
 *                        feed every subsequent TRRC lookup
 *   3  resolve_asset     RRC wellbore query → API → distCode + leaseNo
 *   4  pull_production   Lease-level monthly production history (up to 36 mo)
 *   5  pull_inspections  ICE field inspections + violation database + injection wells
 *   6  pull_completions  EWA W-1 drilling permit + CMPL W-2 packet
 *   7  build_decline     Decline-curve analysis (DCA) — sync, no network
 *   8  run_economics     EIA oil prices + EDGAR operator financials + NPV model
 *   9  check_diligence   Missing-item tracker + risk scoring — sync
 *  10  generate_report   Final IC memo + report assembly — sync
 *
 * No per-step timeouts — every lookup runs until the upstream source responds.
 * maxDuration = 800 s (Vercel Enterprise ceiling); pipeline completes whenever
 * all sources have been fully exhausted.
 *   Steps 7,9,10:             < 1 s each (sync)
 *   Total ceiling:            ~240 s
 */

import { NextResponse }                    from "next/server";
import { createSupabaseFromRouteRequest }  from "@/lib/supabase/from-route-request";
import { extractUnderwritingDataFromDocuments } from "@/lib/underwriting/document-extraction";
import { fetchTrrcViolations, fetchTrrcViolationsByLease, fetchTrrcViolationsByOperator } from "@/lib/underwriting/trrc-compliance";
import { fetchTrrcInjectionByApi, fetchTrrcInjectionByOperator } from "@/lib/underwriting/trrc-injection";
import { fetchTrrcInspectionsForApis }     from "@/lib/wells/trrc-inspection";
import { fetchTrrcCompletionsForApis }     from "@/lib/wells/trrc-completions";
import { fetchTrrcImagedRecordsMulti }     from "@/lib/wells/trrc-imaged-records";
import type { TrrcImagedRecordsResult }    from "@/lib/wells/trrc-imaged-records";
import { fetchTrrcP5ByOperatorNo, fetchTrrcP5ByOperatorName } from "@/lib/underwriting/trrc-p5";
import type { TrrcP5Record }               from "@/lib/underwriting/trrc-p5";
import { fetchTrrcProration }              from "@/lib/underwriting/trrc-proration";
import type { TrrcProrationRecord }        from "@/lib/underwriting/trrc-proration";
import { fetchTrrcInactiveWellByApi } from "@/lib/underwriting/trrc-inactive-wells";
import type { TrrcInactiveWellRecord }     from "@/lib/underwriting/trrc-inactive-wells";
import { fetchTrrcOffsetWellsByField }     from "@/lib/underwriting/trrc-field-wells";
import type { TrrcFieldWellsResult }       from "@/lib/underwriting/trrc-field-wells";
import { fetchDistrictViolations }         from "@/lib/underwriting/trrc-district-violations";
import type { DistrictViolationResult }    from "@/lib/underwriting/trrc-district-violations";
import { fetchLeaseWellInventory }         from "@/lib/underwriting/trrc-lease-inventory";
import type { LeaseWellInventoryResult }   from "@/lib/underwriting/trrc-lease-inventory";
import {
  fetchTrrcOperatorProfile,
  fetchTrrcAnnualProductionBestOf,
  type TrrcOperatorProfile,
  type TrrcAnnualProduction,
} from "@/lib/wells/trrc-operator-profile";
import { buildDDReport, type TrrcWellProduction } from "@/lib/underwriting/report-builder";
import { lookupTrrcLeasesByApis, TX_COUNTY_CODES } from "@/lib/wells/trrc-api";
import { fetchTrrcProductionByLease, fetchTrrcProductionHistory } from "@/lib/wells/trrc-production";
import { fetchFinancialContext }            from "@/lib/underwriting/financial-lookup";
import { getBenchmarkFromApi, getBenchmarkFromCounty } from "@/lib/underwriting/benchmarks";
import { fetchBestWvdepProduction }         from "@/lib/wells/wvdep-production";
import { fetchBestOccProduction }           from "@/lib/wells/occ-production";
import { fetchBestNdicProduction }          from "@/lib/wells/ndic-production";
import type {
  UnderwritingInput,
  PipelineEvent,
  PipelineStepId,
  PipelineStepStatus,
} from "@/lib/underwriting/types";

export const runtime     = "nodejs";
export const dynamic     = "force-dynamic";
export const maxDuration = 300; // Vercel Pro ceiling — maximum allowed on this plan

// ── SSE helpers ───────────────────────────────────────────────────────────────

const encoder = new TextEncoder();

function sseChunk(event: PipelineEvent): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
}

function progressEvent(
  step: PipelineStepId,
  status: PipelineStepStatus,
  label: string,
  detail?: string,
  extras?: {
    usedFallback?: boolean;
    fallbackReason?: string;
    error?: string;
    durationMs?: number;
  },
): Uint8Array {
  return sseChunk({
    type: "progress",
    step,
    status,
    label,
    detail,
    ...extras,
  });
}

/** Wrap a step with running → complete / failed events and timing */
async function runStep<T>(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  step: PipelineStepId,
  label: string,
  fn: () => Promise<{ result: T; detail?: string; usedFallback?: boolean; fallbackReason?: string }>,
  fallbackValue: T,
): Promise<T> {
  const t0 = Date.now();
  await writer.write(progressEvent(step, "running", label + "…"));
  try {
    const { result, detail, usedFallback, fallbackReason } = await fn();
    await writer.write(progressEvent(step, "complete", label, detail, {
      usedFallback,
      fallbackReason,
      durationMs: Date.now() - t0,
    }));
    return result;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await writer.write(progressEvent(step, "failed", label, undefined, {
      error: errMsg,
      usedFallback: true,
      fallbackReason: `Step failed — continuing with partial data`,
      durationMs: Date.now() - t0,
    }));
    return fallbackValue;
  }
}

/**
 * Race a promise against a hard deadline.
 * Throws with a labelled message if the deadline fires first.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${label}`)), ms)
    ),
  ]);
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(request: Request): Promise<Response> {
  // ── Auth ──────────────────────────────────────────────────────────────────
  const supabase = await createSupabaseFromRouteRequest(request);
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as UnderwritingInput;

  // ── Set up SSE stream ──────────────────────────────────────────────────────
  const { readable, writable } = new TransformStream<Uint8Array>();
  const writer = writable.getWriter();

  // Run the pipeline asynchronously — stream stays open until done / error
  runPipeline(writer, body).catch(async (err) => {
    try {
      await writer.write(sseChunk({
        type: "error",
        message: err instanceof Error ? err.message : "Internal pipeline error",
      }));
    } catch { /* writer may already be closed */ }
    try { await writer.close(); } catch { /* ignore */ }
  });

  return new Response(readable, {
    status: 200,
    headers: {
      "Content-Type":      "text/event-stream; charset=utf-8",
      "Cache-Control":     "no-cache, no-transform",
      "Connection":        "keep-alive",
      "X-Accel-Buffering": "no",  // disable nginx/proxy buffering
    },
  });
}

// ── Full underwriting pipeline ────────────────────────────────────────────────

async function runPipeline(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  body: UnderwritingInput,
): Promise<void> {
  const t0 = Date.now();

  // ── 1. Normalize inputs ────────────────────────────────────────────────────
  let apiNumbers   = body.api_numbers ?? [];
  let rrcLeases    = body.rrc_lease_numbers ?? [];
  let operatorName = (body.operator_name ?? "").trim() || null;
  const leaseName    = (body.lease_name ?? "").trim() || null;
  let county       = (body.county ?? "").trim() || null;
  const state        = (body.state ?? "").trim() || null;

  // TRRC-resolved identity — captured from wellbore query, distinct from user inputs
  let trrcResolvedOperator: string | null = null;
  let trrcResolvedCounty:   string | null = null;
  const documents    = body.documents ?? [];
  const nriOverride  = typeof body.nri_decimal === "number" && body.nri_decimal > 0 && body.nri_decimal <= 1
    ? body.nri_decimal : null;
  const wiOverride   = typeof body.wi_decimal === "number" && body.wi_decimal > 0 && body.wi_decimal <= 1
    ? body.wi_decimal : null;

  // ── State detection helpers ─────────────────────────────────────────────────
  // API prefixes: TX=42, OK=35, WV=47, ND=33
  const detectState = (apis: string[], st: string | null) => {
    const prefixes = apis.map(a => a.replace(/\D/g, "").slice(0, 2));
    if (st && /^texas$|^tx$/i.test(st))         return "TX";
    if (st && /^oklahoma$|^ok$/i.test(st))       return "OK";
    if (st && /^west.?virginia$|^wv$/i.test(st)) return "WV";
    if (st && /^north.?dakota$|^nd$/i.test(st))  return "ND";
    if (prefixes.some(p => p === "42"))           return "TX";
    if (prefixes.some(p => p === "35"))           return "OK";
    if (prefixes.some(p => p === "47"))           return "WV";
    if (prefixes.some(p => p === "33"))           return "ND";
    return null;
  };

  const detectedState = detectState(apiNumbers, state);
  const isTexas = detectedState === "TX" ||
    (!!state && /^texas$|^tx$/i.test(state.trim())) ||
    apiNumbers.some(a => a.replace(/\D/g, "").startsWith("42"));

  const inputSummary = [
    apiNumbers.length > 0 ? `${apiNumbers.length} API number(s)` : null,
    rrcLeases.length  > 0 ? `${rrcLeases.length} RRC lease(s)` : null,
    operatorName ? `Operator: ${operatorName}` : null,
    leaseName    ? `Lease: ${leaseName}` : null,
    county       ? `County: ${county}` : null,
    documents.length > 0 ? `${documents.length} document(s) to parse` : null,
  ].filter(Boolean).join(", ") || "No identifiers provided";

  await writer.write(progressEvent("normalize", "complete", "Resolving asset identity",
    inputSummary, { durationMs: 0 }));

  // ── 2. Parse documents FIRST ───────────────────────────────────────────────
  // Document parsing must happen before any TRRC lookup so that API numbers,
  // lease numbers, operator names, and county found in documents can be used
  // for all subsequent data fetches. Skipping this step means any identifiers
  // embedded in uploaded files are silently ignored.
  let extracted: import("@/lib/underwriting/document-extraction").DocumentExtractionResult | null = null;

  extracted = await runStep(
    writer,
    "parse_documents",
    "Parsing documents",
    async () => {
      if (documents.length === 0) {
        return {
          result: null,
          detail: "No documents provided",
          usedFallback: false,
        };
      }

      // Give AI extraction up to 90 seconds — worth waiting for.
      // Every identifier found here improves every subsequent TRRC query.
      const result = await withTimeout(
        extractUnderwritingDataFromDocuments(documents),
        90_000,
        "AI document extraction",
      );

      // Merge identifiers from documents into working sets
      if (result?.api_numbers?.length) {
        apiNumbers = [...apiNumbers, ...result.api_numbers]
          .filter((v, i, a) => v && a.indexOf(v) === i);
      }
      if (result?.rrc_lease_numbers?.length) {
        rrcLeases = [...rrcLeases, ...result.rrc_lease_numbers]
          .filter((v, i, a) => v && a.indexOf(v) === i);
      }
      if (!operatorName && result?.operator_name) operatorName = result.operator_name;
      if (!county       && result?.county)         county       = result.county;

      const parts: string[] = [];
      const docCount = documents.length;
      parts.push(`${docCount} document(s) processed`);
      if (apiNumbers.length   > 0) parts.push(`${apiNumbers.length} API number(s) now available`);
      if (rrcLeases.length    > 0) parts.push(`${rrcLeases.length} RRC lease(s) now available`);
      if (result?.completion_data?.formation_name) parts.push(`Formation: ${result.completion_data.formation_name}`);
      if (result?.completion_data?.total_depth_ft) parts.push(`Depth: ${result.completion_data.total_depth_ft.toLocaleString()} ft`);
      if (result?.loe_statements?.length)  parts.push(`${result.loe_statements.length} LOE period(s)`);
      if (result?.run_tickets_present)     parts.push(`Run tickets detected`);

      return { result, detail: parts.join("; ") };
    },
    null,
  );

  // ── 3. Resolve RRC asset identity ─────────────────────────────────────────
  // Now we have the full merged API list (manual + doc-extracted) so this
  // lookup will match even if the user only uploaded a doc with the API in it.
  let leaseMap = new Map<string, { distCode: string; leaseNo: string; operator: string }>();

  // Re-derive state with the now-enriched API list (docs may have added API numbers)
  const resolvedState = detectState(apiNumbers, state);
  const isTexasResolved = resolvedState === "TX" ||
    (!!state && /^texas$|^tx$/i.test(state.trim())) ||
    apiNumbers.some(a => a.replace(/\D/g, "").startsWith("42"));

  // Basin benchmarks — synchronous, uses enriched API list
  const api8ForBenchmark = apiNumbers
    .map(a => a.replace(/\D/g, ""))
    .map(d => d.startsWith("42") && d.length >= 10 ? d.slice(2, 10) : d.slice(0, 8))
    .find(d => d.length === 8);
  const benchmark = api8ForBenchmark
    ? getBenchmarkFromApi(api8ForBenchmark)
    : (county ? getBenchmarkFromCounty(county) : null);

  leaseMap = await runStep(
    writer,
    "resolve_asset",
    "Matching RRC lease records",
    async () => {
      if (!isTexasResolved || apiNumbers.length === 0) {
        const detail = !isTexasResolved
          ? "Non-Texas well or no API numbers — TRRC lookup skipped"
          : "No API numbers found (manual or document) — skipping TRRC wellbore query";
        return { result: new Map(), detail, usedFallback: true };
      }

      // 30 seconds — TRRC can be slow; we want accurate lease records
      const map = await withTimeout(
        lookupTrrcLeasesByApis(county, apiNumbers),
        30_000,
        "TRRC wellbore query",
      );

      if (map.size === 0) {
        return {
          result: new Map(),
          detail: "No matching TRRC lease records found for provided API numbers",
          usedFallback: true,
          fallbackReason: "API not found in TRRC wellbore query — will attempt direct lease-number path",
        };
      }

      const entries = Array.from(map) as Array<[string, { distCode: string; leaseNo: string; operator: string }]>;
      const firstOp = entries[0]?.[1]?.operator;
      // Capture TRRC-resolved operator independently so contradiction engine can
      // compare it against the doc-extracted operator even after operatorName is set.
      trrcResolvedOperator = firstOp ?? null;
      if (firstOp && !operatorName) operatorName = firstOp;

      const leaseList = entries.map(([, { distCode, leaseNo }]) =>
        `Dist ${distCode} / Lease ${leaseNo}`
      ).join("; ");

      return {
        result: map,
        detail: `Matched ${map.size} of ${apiNumbers.length} API(s) → ${leaseList}`,
      };
    },
    new Map(),
  );

  // Derive TRRC-resolved county from the embedded county code in the first API number.
  // Texas 10-digit API: 42-CCC-WWWWW  (CCC = 3-digit county FIPS code)
  // Build a reverse lookup (code → name) from the exported TX_COUNTY_CODES map.
  if (!trrcResolvedCounty && apiNumbers.length > 0) {
    const api10 = apiNumbers[0].replace(/\D/g, "");
    const countyCode3 = api10.startsWith("42") && api10.length >= 10
      ? api10.slice(2, 5)   // 10-digit form: 42-CCC-WWWWW → slice chars 2,3,4
      : api10.length >= 8
        ? api10.slice(0, 3) // 8-digit form:  CCC-WWWWW → slice chars 0,1,2
        : null;
    if (countyCode3) {
      // Reverse the name→code map to get code→name
      const reverseCounty = Object.fromEntries(
        Object.entries(TX_COUNTY_CODES).map(([name, code]) => [code, name])
      );
      const matched = reverseCounty[countyCode3];
      if (matched) {
        // Capitalize first letter of each word (e.g. "midland" → "Midland")
        trrcResolvedCounty = matched
          .split(" ")
          .map(w => w.charAt(0).toUpperCase() + w.slice(1))
          .join(" ");
      }
    }
  }

  // ── 3b. Primary lease identifiers — shared by inventory + all subsequent steps ──
  // Computed once here so every downstream step uses consistent values without
  // re-deriving from leaseMap.
  const _primaryDistCode = Array.from(leaseMap.values())[0]?.distCode ?? null;
  const _primaryLeaseNo  = Array.from(leaseMap.values())[0]?.leaseNo  ?? null;

  // ── 3c. Lease-well inventory — start concurrently with step 4 ────────────
  // Runs in the background while production is being fetched.
  // Awaited immediately after step 4 so the full 52-well API list is available
  // for completions (step 6), imaged records, ICE inspections, etc.
  //
  // Manus spec §4.3 + §8: one API ≠ one well; canClaimSingleWellProduction ALWAYS false.
  // Golden fixture: Lease 60509 / District 8A → 52 wells.
  let leaseInventoryResult: LeaseWellInventoryResult | null = null;
  const _leaseInvPromise: Promise<LeaseWellInventoryResult | null> =
    (isTexasResolved && !!_primaryDistCode && !!_primaryLeaseNo)
      ? fetchLeaseWellInventory(_primaryDistCode, _primaryLeaseNo).catch(() => null)
      : Promise.resolve(null);

  // ── 4. Pull production history ─────────────────────────────────────────────
  let trrcWells: TrrcWellProduction[] = [];

  trrcWells = await runStep(
    writer,
    "pull_production",
    "Pulling production history",
    async () => {
      // ── Non-Texas state production paths ──────────────────────────────────
      if (!isTexasResolved) {
        if (resolvedState === "WV" && apiNumbers.length > 0) {
          const wvResult = await withTimeout(
            fetchBestWvdepProduction(apiNumbers, 36),
            30_000, "WV DEP production",
          ).catch(() => null);
          if (wvResult && wvResult.rows.length > 0) {
            const sorted = wvResult.rows;
            const latest = sorted[sorted.length - 1];
            return {
              result: [{
                api: wvResult.api_number,
                well_name: `API ${wvResult.api_number} (WV DEP)`,
                lease_number: null,
                district_code: null,
                operator: operatorName,
                latest_monthly_oil_bbl: latest.oil_bbl,
                latest_production_month: `${latest.year}-${String(latest.month).padStart(2, "0")}`,
                cum_oil_bbl: sorted.reduce((s, r) => s + r.oil_bbl, 0),
                monthly_rows: sorted.map(r => ({ year: r.year, month: r.month, oil_bbl: r.oil_bbl, gas_mcf: r.gas_mcf ?? 0, water_bbl: null })),
              }] as TrrcWellProduction[],
              detail: `WV DEP: ${wvResult.months_count} months of production for API ${wvResult.api_number}`,
            };
          }
          return { result: [], detail: "No production found in WV DEP records for provided API numbers", usedFallback: true };
        }

        if (resolvedState === "OK" && apiNumbers.length > 0) {
          const okResult = await withTimeout(
            fetchBestOccProduction(apiNumbers, 36),
            35_000, "OCC production",
          ).catch(() => null);
          if (okResult && okResult.rows.length > 0) {
            const sorted = okResult.rows;
            const latest = sorted[sorted.length - 1];
            return {
              result: [{
                api: okResult.api_number,
                well_name: `API ${okResult.api_number} (OCC)`,
                lease_number: null,
                district_code: null,
                operator: operatorName,
                latest_monthly_oil_bbl: latest.oil_bbl,
                latest_production_month: `${latest.year}-${String(latest.month).padStart(2, "0")}`,
                cum_oil_bbl: sorted.reduce((s, r) => s + r.oil_bbl, 0),
                monthly_rows: sorted.map(r => ({ year: r.year, month: r.month, oil_bbl: r.oil_bbl, gas_mcf: r.gas_mcf ?? 0, water_bbl: null })),
              }] as TrrcWellProduction[],
              detail: `OCC: ${okResult.months_count} months of production for API ${okResult.api_number}`,
            };
          }
          return { result: [], detail: "No production found in OCC records for provided API numbers", usedFallback: true };
        }

        if (resolvedState === "ND" && apiNumbers.length > 0) {
          const ndResult = await withTimeout(
            fetchBestNdicProduction(apiNumbers, 36),
            40_000, "NDIC production",
          ).catch(() => null);
          if (ndResult && ndResult.rows.length > 0) {
            const sorted = ndResult.rows;
            const latest = sorted[sorted.length - 1];
            return {
              result: [{
                api: ndResult.api_number,
                well_name: `API ${ndResult.api_number} (NDIC)`,
                lease_number: null,
                district_code: null,
                operator: operatorName,
                latest_monthly_oil_bbl: latest.oil_bbl,
                latest_production_month: `${latest.year}-${String(latest.month).padStart(2, "0")}`,
                cum_oil_bbl: sorted.reduce((s, r) => s + r.oil_bbl, 0),
                monthly_rows: sorted.map(r => ({ year: r.year, month: r.month, oil_bbl: r.oil_bbl, gas_mcf: r.gas_mcf ?? 0, water_bbl: null })),
              }] as TrrcWellProduction[],
              detail: `NDIC: ${ndResult.months_count} months, file #${ndResult.file_number}`,
            };
          }
          return { result: [], detail: "No production found in NDIC records for provided API numbers", usedFallback: true };
        }

        return {
          result: [],
          detail: `State not supported for automated production pull (detected: ${resolvedState ?? "unknown"}). Provide documents with production data.`,
          usedFallback: true,
        };
      }

      const wells: TrrcWellProduction[] = [];
      const seenLeases = new Set<string>();

      // Fetch production for one resolved lease.
      // fetchTrrcProductionByLease now uses 2 HTTP requests (pageSize=500) instead of
      // 41 sequential pages — typical time is 1-3s regardless of history length.
      // 60s timeout is a safety net only.
      const fetchWell = async (
        api: string,
        distCode: string,
        leaseNo: string,
        operator: string | null,
      ): Promise<TrrcWellProduction | null> => {
        const res = await withTimeout(
          fetchTrrcProductionByLease(distCode, leaseNo),
          60_000,
          `TRRC production Dist ${distCode} Lease ${leaseNo}`,
        );
        if (!res || res.rows.length === 0) return null;
        const sorted = [...res.rows].sort((a, b) =>
          a.year !== b.year ? a.year - b.year : a.month - b.month
        );
        const latest = sorted[sorted.length - 1];
        return {
          api,
          well_name: `Lease ${leaseNo} (District ${distCode})`,
          lease_number: leaseNo,
          district_code: distCode,
          operator: operator || operatorName,
          latest_monthly_oil_bbl: latest?.oil_bbl ?? 0,
          latest_production_month: latest
            ? `${latest.year}-${String(latest.month).padStart(2, "0")}` : null,
          cum_oil_bbl: sorted.reduce((s, r) => s + r.oil_bbl, 0),
          monthly_rows: sorted.map(r => ({
            year: r.year, month: r.month,
            oil_bbl: r.oil_bbl,
            gas_mcf: r.gas_mcf ?? 0,
            // TRRC production reports do NOT include water volumes; null prevents
            // false "0% water cut" calculations downstream.
            water_bbl: null,
          })),
        };
      };

      // Path A: resolved lease map (API → distCode + leaseNo from TRRC wellbore query)
      if (leaseMap.size > 0) {
        for (const [api, { distCode, leaseNo, operator }] of Array.from(leaseMap)) {
          const key = `${distCode}:${leaseNo}`;
          if (seenLeases.has(key)) continue;
          seenLeases.add(key);
          try {
            const w = await fetchWell(api, distCode, leaseNo, operator);
            if (w) wells.push(w);
          } catch {
            // timeout or error for this specific well — log and continue
          }
        }
      }

      // Path B: explicit RRC lease numbers (manual or doc-extracted)
      // Run even if leaseMap found results — may catch additional leases
      if (rrcLeases.length > 0) {
        const DISTRICT_CODES = ["7C","7B","8","8A","1","2","3","4","5","6","9","10"];
        for (const lease of rrcLeases.slice(0, 8)) {
          const parts = lease.split(":");
          if (parts.length >= 2) {
            const [distCode, leaseNo] = parts;
            const key = `${distCode}:${leaseNo}`;
            if (!seenLeases.has(key)) {
              seenLeases.add(key);
              try {
                const w = await fetchWell("42000000000", distCode, leaseNo, null);
                if (w) wells.push(w);
              } catch { /* per-well timeout — skip */ }
            }
          } else {
            // No distCode hint — try most common Permian districts first
            const leaseNo = lease.trim();
            for (const distCode of DISTRICT_CODES) {
              const key = `${distCode}:${leaseNo}`;
              if (seenLeases.has(key)) continue;
              seenLeases.add(key);
              try {
                const w = await fetchWell("42000000000", distCode, leaseNo, null);
                if (w) { wells.push(w); break; } // stop once we find a match
              } catch { /* per-well timeout — try next district */ }
            }
          }
        }
      }

      // Path C — operator-name re-query.
      // When both the wellbore-resolved leaseMap and the explicit lease list
      // returned no production rows, use the TRRC-resolved operator name to
      // re-run the wellbore lookup.  This catches cases where the API number
      // returned a leaseMap entry but that lease had no production (e.g. a
      // recently drilled well) while a separate lease under the same operator
      // does have history.
      if (wells.length === 0 && trrcResolvedOperator && county) {
        try {
          const opMap = await withTimeout(
            lookupTrrcLeasesByApis(county, apiNumbers),
            20_000,
            "TRRC production Path C (operator re-query)",
          );
          for (const [api, { distCode, leaseNo, operator }] of Array.from(opMap)) {
            const key = `${distCode}:${leaseNo}`;
            if (seenLeases.has(key)) continue;
            seenLeases.add(key);
            try {
              const w = await fetchWell(api, distCode, leaseNo, operator);
              if (w) wells.push(w);
            } catch { /* per-well timeout */ }
          }
        } catch { /* Path C timeout — accept empty */ }
      }

      // Path D — direct API-number production history.
      // Uses a separate TRRC entry point (wellboreQueryAction → specificLeaseQueryAction)
      // that resolves the lease from the API number internally.  Catches cases where
      // the leaseMap lookup failed (session issue, network blip) but the API is valid.
      if (wells.length === 0 && apiNumbers.length > 0) {
        for (const api of apiNumbers.slice(0, 4)) {
          try {
            const result = await fetchTrrcProductionHistory(api);
            if (result && result.rows.length > 0) {
              const key = `${result.district_code}:${result.lease_number}`;
              if (!seenLeases.has(key)) {
                seenLeases.add(key);
                const sorted = [...result.rows].sort((a, b) =>
                  a.year !== b.year ? a.year - b.year : a.month - b.month
                );
                const latest = sorted[sorted.length - 1];
                wells.push({
                  api,
                  well_name: `Lease ${result.lease_number} (District ${result.district_code})`,
                  lease_number: result.lease_number,
                  district_code: result.district_code,
                  operator: operatorName,
                  latest_monthly_oil_bbl: latest?.oil_bbl ?? 0,
                  latest_production_month: latest
                    ? `${latest.year}-${String(latest.month).padStart(2, "0")}` : null,
                  cum_oil_bbl: sorted.reduce((s, r) => s + r.oil_bbl, 0),
                  monthly_rows: sorted.map(r => ({
                    year: r.year, month: r.month,
                    oil_bbl: r.oil_bbl, gas_mcf: r.gas_mcf ?? 0, water_bbl: null,
                  })),
                });
              }
            }
          } catch { /* per-API error — continue */ }
        }
      }

      if (wells.length === 0) {
        return {
          result: [],
          detail: "No production records found in TRRC after exhausting all resolution strategies (leaseMap, explicit leases, operator re-query, direct API history)",
          usedFallback: true,
          fallbackReason: "No matching lease found or TRRC returned no rows — verify API numbers, lease numbers, and operator name",
        };
      }

      const totalLatest = wells.reduce((s, w) => s + (w.latest_monthly_oil_bbl ?? 0), 0);
      const totalMonths = wells.reduce((s, w) => s + (w.monthly_rows?.length ?? 0), 0);
      const wellList = wells
        .map(w => `Lease ${w.lease_number}: ${w.latest_monthly_oil_bbl?.toLocaleString() ?? 0} BOPD`)
        .join("; ");
      return {
        result: wells,
        detail: `${wells.length} lease(s) — ${totalLatest.toLocaleString()} BOPD combined, ${totalMonths} monthly data points. ${wellList}`,
      };
    },
    [],
  );

  // ── 4b. Collect inventory + build full well API list ─────────────────────
  // The inventory promise started before step 4. By the time production finishes
  // (20–60 s), the inventory query (35 s) is almost always done.
  leaseInventoryResult = await _leaseInvPromise;

  // allLeaseApis = input APIs + all APIs discovered in the lease inventory.
  // Input APIs come first so the user's anchor wells are always prioritized.
  // This list is used by completions, imaged records, ICE inspections, inactive
  // well checks — giving full coverage of the lease instead of just 4 APIs.
  const allLeaseApis: string[] = (() => {
    const seen = new Set<string>(apiNumbers.map(a => a.replace(/\D/g, "")));
    const combined = [...apiNumbers];
    for (const w of leaseInventoryResult?.wells ?? []) {
      const clean = w.api10.replace(/\D/g, "");
      if (clean.length >= 8 && !seen.has(clean)) {
        seen.add(clean);
        combined.push(w.api10);
      }
    }
    return combined;
  })();

  // ── 5. Pull inspections, violations, injection, P-5, H-15 ─────────────────
  // All sub-calls run in parallel with individual error isolation.
  let complianceResult: import("@/lib/underwriting/trrc-compliance").TrrcViolation[] = [];
  let injectionResult: import("@/lib/underwriting/trrc-injection").TrrcInjectionRecord[] = [];
  let inspectionResult: import("@/lib/wells/trrc-inspection").TrrcInspectionRecord[] = [];
  let operatorProfile: TrrcOperatorProfile | null = null;
  let annualProduction: TrrcAnnualProduction | null = null;
  let districtViolationsResult: DistrictViolationResult | null = null;

  [complianceResult, injectionResult, inspectionResult, operatorProfile, annualProduction] = await runStep(
    writer,
    "pull_inspections",
    "Pulling inspections & compliance",
    async () => {
      if (!isTexasResolved) {
        return {
          result: [[], [], [], null, null] as
            [typeof complianceResult, typeof injectionResult, typeof inspectionResult, typeof operatorProfile, typeof annualProduction],
          detail: "Non-Texas well — TRRC compliance lookup not applicable; provide documents for compliance review",
        };
      }

      // All six calls run concurrently — no call blocks any other.
      // EXHAUSTION POLICY: every lookup tries all available identifier strategies
      // before accepting an empty result.
      //
      // Entry 6 is the Manus-spec mandatory district violation file:
      //   6 — district violation file download (RRC official TXT artifact, full history)
      //
      // Note: lease-well inventory (previously entry 7) now runs before step 4 so
      // allLeaseApis is available for all steps. Entry 7 returns the cached result.
      //
      // allLeaseApis contains ALL well APIs on this lease (up to 52 for lease 60509).
      // Violations, injection, and ICE inspections now cover ALL wells — not just 4.
      const [violations, injection, inspections, p5Profile, h15Annual, distViolsLocal, leaseInvLocal] = await Promise.all([

        // ── Violations ────────────────────────────────────────────────────────
        // Strategy 1: query every available API (up to 4) — different APIs on
        //   the same lease may have separate violation records in TRRC.
        // Strategy: query by LEASE NUMBER first (single call covers all wells on the
        //   lease), then operator + county as a second pass.
        //
        // Previously iterated allLeaseApis (up to 52) sequentially — that took 52 ×
        // 3s = 156s on fast networks and returned nothing on Vercel because each
        // initIceSession() round-trip added up.  A single lease-number query is both
        // faster and more complete: one ICE search returns ALL violations filed against
        // that lease regardless of which specific API they reference.
        (async (): Promise<typeof complianceResult> => {
          type V = import("@/lib/underwriting/trrc-compliance").TrrcViolation;
          const seen  = new Set<string>();
          const merged: V[] = [];
          const addAll = (rows: V[]) => {
            for (const v of rows) {
              const key = `${v.violation_id ?? ""}|${v.date ?? ""}|${v.type}`;
              if (!seen.has(key)) { seen.add(key); merged.push(v); }
            }
          };

          const firstLease = Array.from(leaseMap.values())[0];
          const leaseNoForViolations = firstLease?.leaseNo ?? null;
          const distCodeForViolations = firstLease?.distCode ?? null;

          // S1 — single ICE query by lease number (covers all APIs on the lease)
          // Uses fetchTrrcViolationsByLease which sends EMPTY qvapino field.
          // Passing any API value to qvapino alongside a lease number causes ICE
          // to AND the two filters → 0 results when the API mask doesn't match.
          if (leaseNoForViolations) {
            try {
              addAll(await withTimeout(
                fetchTrrcViolationsByLease(leaseNoForViolations),
                30_000,
                `TRRC violations lease ${leaseNoForViolations}`,
              ));
            } catch { /* timeout */ }
          }

          // S1b — per-API fallback: first 4 anchor APIs only (not all 52)
          // Catches violations indexed by API but not by lease number.
          if (merged.length === 0) {
            for (const api of apiNumbers.slice(0, 4)) {
              try {
                addAll(await withTimeout(
                  fetchTrrcViolations(api, distCodeForViolations, leaseNoForViolations),
                  30_000,
                  `TRRC violations API ${api}`,
                ));
              } catch { /* per-API timeout — continue to next */ }
            }
          }

          // S2 — by operator + county, only when S1/S1b found nothing.
          // Skipped when lease-number query already returned results — avoids
          // adding an extra 20s wait on every report that has ICE violations.
          if (merged.length === 0 && operatorName && county) {
            try {
              addAll(await withTimeout(
                fetchTrrcViolationsByOperator(operatorName, county),
                20_000,
                "TRRC violations by operator",
              ));
            } catch { /* timeout — violations from S1 still used */ }
          }

          return merged;
        })(),

        // ── Injection wells ───────────────────────────────────────────────────
        // Strategy 1: query every available API (up to 4).
        // Strategy 2: operator + county fallback only when S1 returns nothing —
        //   injection records are per-well and the operator scan can over-return.
        (async (): Promise<typeof injectionResult> => {
          type IR = import("@/lib/underwriting/trrc-injection").TrrcInjectionRecord;
          const seen  = new Set<string>();
          const merged: IR[] = [];
          const addAll = (rows: IR[]) => {
            for (const r of rows) {
              const key = `${r.api10}|${r.permit_number ?? ""}`;
              if (!seen.has(key)) { seen.add(key); merged.push(r); }
            }
          };

          // S1 — by API: first 6 anchor APIs (injection wells are rare; don't need all 52)
          for (const api of apiNumbers.slice(0, 6)) {
            try {
              addAll(await withTimeout(
                fetchTrrcInjectionByApi(api),
                20_000,
                `TRRC injection API ${api}`,
              ));
            } catch { /* per-API timeout — continue */ }
          }

          // S2 — operator + county when S1 found nothing
          if (merged.length === 0 && operatorName && county) {
            try {
              addAll(await withTimeout(
                fetchTrrcInjectionByOperator(operatorName, county),
                20_000,
                "TRRC injection by operator",
              ));
            } catch { /* timeout */ }
          }

          return merged;
        })(),

        // ── ICE field inspection records ──────────────────────────────────────
        // ICE inspection records are indexed per-well API.  We check the first
        // 10 wells (anchor APIs first, then inventory wells).
        //
        // Why capped at 10:
        //   - Each API = 2 HTTP round-trips (GET session + POST search)
        //   - 60 APIs × 2 requests / 4 concurrent = ~15 batches × ~700ms = ~10s+
        //   - If ALL 60 return empty, a fallback loop re-runs all 60 sequentially —
        //     that's 120+ serial requests and 60+ seconds with no outer timeout.
        //   - ICE inspection records are per-individual-well; if the first 10 wells
        //     on a lease have no inspection records, the remaining 50 won't either
        //     (inspectors log by lease/district, not by every wellbore API).
        // The district violation file (VIOLATIONS_DIST*.txt) captures compliance
        // history at the lease level and is already fetched in parallel above.
        (async (): Promise<typeof inspectionResult> => {
          type IR = import("@/lib/wells/trrc-inspection").TrrcInspectionRecord;
          if (allLeaseApis.length === 0) return [];

          // Use up to 10 APIs: anchor APIs come first in allLeaseApis
          const apisToCheck = allLeaseApis.slice(0, 10);

          try {
            return await withTimeout(
              fetchTrrcInspectionsForApis(apisToCheck),
              40_000,
              "TRRC ICE inspections (first 10 lease wells)",
            );
          } catch {
            return [];
          }
        })(),

        // ── P-5 Operator Organization ─────────────────────────────────────────
        // Fetches the current P-5 org record for the resolved operator.
        // Provides bond status, P-5 number, and contact info directly from TRRC.
        (async (): Promise<TrrcOperatorProfile | null> => {
          const name = trrcResolvedOperator ?? operatorName;
          if (!name) return null;
          try {
            return await withTimeout(
              fetchTrrcOperatorProfile(name),
              20_000,
              "TRRC P-5 operator profile",
            );
          } catch { return null; }
        })(),

        // ── H-15 Annual Production ────────────────────────────────────────────
        // Fetches cumulative annual production totals for the resolved lease.
        // Longer historical view than the 36-month monthly window.
        (async (): Promise<TrrcAnnualProduction | null> => {
          const first = Array.from(leaseMap.values())[0];
          if (!first) return null;
          try {
            return await withTimeout(
              fetchTrrcAnnualProductionBestOf(first.distCode, first.leaseNo),
              20_000,
              "TRRC H-15 annual production",
            );
          } catch { return null; }
        })(),

        // ── ENTRY 6: District violation file (Manus spec §4.5 / §7.2) ────────
        // Downloads the official RRC district violation TXT file, hashes it,
        // parses every row, and filters by lease number + API variants.
        //
        // Critical rule: failed download ≠ clean compliance.
        // Golden fixture: Lease 60509 / District 8A → 39 matching records.
        (async (): Promise<DistrictViolationResult | null> => {
          if (!_primaryDistCode || !_primaryLeaseNo) return null;
          try {
            // Pass allLeaseApis so the district file search matches against all
            // 52 API numbers on the lease, not just the 1-4 anchor APIs.
            return await withTimeout(
              fetchDistrictViolations(_primaryDistCode, _primaryLeaseNo, allLeaseApis, operatorName),
              50_000,
              `District ${_primaryDistCode} violation file`,
            );
          } catch { return null; }
        })(),

        // ── ENTRY 7: Lease-well inventory — return already-computed result ─────
        // Inventory was started before step 4 (section 3c) and awaited after step 4.
        // Returning the cached result here keeps the Promise.all structure intact
        // while adding zero extra latency — the result is already in memory.
        Promise.resolve(leaseInventoryResult),
      ]);

      // ── Store new evidence in outer scope (captured by closure) ────────────
      districtViolationsResult = distViolsLocal ?? null;
      leaseInventoryResult     = leaseInvLocal  ?? null;

      // Merge district file violations into the ICE violations array so that
      // the downstream report builder sees the full combined violation set.
      // De-duplicate by violation_id + date + type.
      if (distViolsLocal?.matching_violations?.length) {
        const dvSeen = new Set(
          violations.map(v => `${v.violation_id ?? ""}|${v.date ?? ""}|${v.type}`)
        );
        for (const dv of distViolsLocal.matching_violations) {
          const key = `${dv.violation_id ?? ""}|${dv.date ?? ""}|${dv.type}`;
          if (!dvSeen.has(key)) { dvSeen.add(key); violations.push(dv); }
        }
      }

      const parts: string[] = [];
      if (violations.length > 0)   parts.push(`${violations.length} violation(s)`);
      if (injection.length  > 0)   parts.push(`${injection.length} injection well(s)`);
      if (inspections.length > 0)  parts.push(`${inspections.length} ICE inspection record(s)`);
      if (p5Profile)               parts.push(`P-5 operator record found`);
      if (h15Annual?.rows.length)  parts.push(`H-15: ${h15Annual.rows.length} year(s) of annual production`);
      // District violation file
      if (distViolsLocal?.status === "success") {
        parts.push(`District ${distViolsLocal.district} violation file: ${distViolsLocal.match_count} matching record(s) of ${distViolsLocal.total_rows_in_file.toLocaleString()} total`);
      } else if (distViolsLocal?.status === "download_failed") {
        parts.push(`District violation file DOWNLOAD FAILED — compliance unverified`);
      } else if (distViolsLocal?.status === "no_url_for_district") {
        parts.push(`District violation file: no URL found for district ${_primaryDistCode ?? "unknown"}`);
      }
      // Lease-well inventory
      if (leaseInvLocal) {
        if (leaseInvLocal.query_failed) {
          parts.push(`Lease-well inventory query failed — well count unknown`);
        } else {
          parts.push(`Lease inventory: ${leaseInvLocal.well_count} well(s) on Lease ${leaseInvLocal.lease_number}`);
        }
      }

      const detail = parts.length > 0
        ? parts.join(", ")
        : "No compliance/inspection records found";

      return {
        result: [violations, injection, inspections, p5Profile, h15Annual] as
          [typeof complianceResult, typeof injectionResult, typeof inspectionResult, typeof operatorProfile, typeof annualProduction],
        detail,
      };
    },
    [[], [], [], null, null] as
      [typeof complianceResult, typeof injectionResult, typeof inspectionResult, typeof operatorProfile, typeof annualProduction],
  );

  // ── 6. Pull completion / W-2 records + TRRC imaged records ──────────────
  let completionResult: import("@/lib/wells/trrc-completions").TrrcCompletionRecord[] = [];
  let imagedRecordsResult: TrrcImagedRecordsResult[] | null = null;
  let p5StatusResult:      TrrcP5Record | null = null;
  let prorationResult:     TrrcProrationRecord[] | null = null;
  let inactiveWellsResult: TrrcInactiveWellRecord[] | null = null;
  let fieldWellsResult:    TrrcFieldWellsResult | null = null;
  let cmplPacketDetailResult: import("@/lib/wells/trrc-imaged-records").CmplPacketDetail | null = null;

  completionResult = await runStep(
    writer,
    "pull_completions",
    "Searching completion records",
    async () => {
      if (!isTexasResolved || allLeaseApis.length === 0) {
        return {
          result: [],
          detail: !isTexasResolved
            ? "Non-Texas well — TRRC completion lookup not applicable; provide W-2 documents for formation data"
            : "No API numbers available — skipping completion lookup",
          usedFallback: true,
        };
      }

      // EXHAUSTION POLICY: try batched lookup first, then fall back to individual
      // per-API lookups when the batch times out or returns nothing.  The CMPL
      // two-step (EWA drilling permit → CMPL W-2) is slow.
      //
      // FULL FAN-OUT: allLeaseApis includes ALL wells discovered by the lease
      // inventory (up to 52 for lease 60509), not just the 4 anchor APIs.
      // This ensures completions are pulled for every well on the lease.
      type CR = import("@/lib/wells/trrc-completions").TrrcCompletionRecord;
      let results: CR[] = [];

      // Pass 1 — batched for up to 20 wells (fastest when TRRC is responsive)
      try {
        results = await withTimeout(
          fetchTrrcCompletionsForApis(allLeaseApis),
          90_000,
          `TRRC completion / W-2 lookup (batch — ${allLeaseApis.length} wells)`,
        );
      } catch { /* batch timed out — fall through to per-API retry */ }

      // Pass 2 — individual per-API retry for any API that didn't get a result
      // in Pass 1 (covers timeouts and partial batch failures).
      const coveredApis = new Set(results.map(r => r.api?.replace(/\D/g, "")));
      const { fetchTrrcCompletionByApi } = await import("@/lib/wells/trrc-completions");
      for (const api of allLeaseApis) {
        const api10 = api.replace(/\D/g, "");
        if (coveredApis.has(api10)) continue; // already have a result for this API
        try {
          const r = await withTimeout(
            fetchTrrcCompletionByApi(api),
            25_000,
            `TRRC completion API ${api} (retry)`,
          );
          if (r) results.push(r);
        } catch { /* per-API timeout — continue to next */ }
      }

      // Run imaged records, P-5, proration, and inactive-well queries in parallel
      const firstLease = Array.from(leaseMap.values())[0];
      const distCodeForPro = firstLease?.distCode ?? "";
      const firstApi = allLeaseApis[0] ?? "";

      const [imagedResults, p5Rec, proRec, inactiveRec] = await Promise.allSettled([
        // TRRC imaged records (W-1/W-2/G-1/P-4 viewer links)
        // Use allLeaseApis so imaged records are fetched for all lease wells, not just 4.
        allLeaseApis.length > 0
          ? withTimeout(
              fetchTrrcImagedRecordsMulti(allLeaseApis),
              60_000,
              `TRRC imaged records (W-1/W-2/G-1/P-4 — ${allLeaseApis.length} wells)`,
            ).catch(() => null)
          : Promise.resolve(null),

        // TRRC P-5 operator organization status
        (async (): Promise<TrrcP5Record | null> => {
          if (!isTexasResolved) return null;
          // Try by resolved operator name first
          const name = trrcResolvedOperator ?? operatorName;
          if (!name) return null;
          return withTimeout(
            fetchTrrcP5ByOperatorName(name),
            15_000, "TRRC P-5 operator status",
          ).catch(() => null);
        })(),

        // TRRC oil + gas proration factors
        (async (): Promise<TrrcProrationRecord[] | null> => {
          if (!isTexasResolved || !firstApi || !distCodeForPro) return null;
          return withTimeout(
            fetchTrrcProration(firstApi, distCodeForPro),
            15_000, "TRRC proration factors",
          ).catch(() => null);
        })(),

        // TRRC inactive well status — cover all wells on the lease.
        // allLeaseApis gives us every well from the inventory, not just the anchor API.
        // Cap at 10 APIs — inactive well queries are fast but we respect TRRC load limits.
        (async (): Promise<TrrcInactiveWellRecord[] | null> => {
          if (!isTexasResolved) return null;
          const seen = new Set<string>();
          const merged: TrrcInactiveWellRecord[] = [];
          for (const api of allLeaseApis) {
            try {
              const res = await withTimeout(
                fetchTrrcInactiveWellByApi(api),
                12_000, `TRRC inactive well API ${api}`,
              ).catch(() => ({ is_active_not_flagged: true, records: [] as TrrcInactiveWellRecord[] }));
              for (const r of res.records) {
                const key = `${r.api8}|${r.lease_name ?? ""}`;
                if (!seen.has(key)) { seen.add(key); merged.push(r); }
              }
            } catch { /* per-API timeout — continue */ }
          }
          return merged.length > 0 ? merged : null;
        })(),
      ]);

      imagedRecordsResult  = imagedResults.status  === "fulfilled" ? imagedResults.value  : null;
      p5StatusResult       = p5Rec.status           === "fulfilled" ? p5Rec.value           : null;
      prorationResult      = proRec.status          === "fulfilled" ? proRec.value          : null;
      inactiveWellsResult  = inactiveRec.status     === "fulfilled" ? inactiveRec.value     : null;

      // Extract CMPL packet detail from the most recent imaged record with a W-2 packet
      if (imagedRecordsResult) {
        for (const r of imagedRecordsResult) {
          if (r.cmpl_packet_detail) {
            cmplPacketDetailResult = r.cmpl_packet_detail;
            break;
          }
        }
      }

      // Fetch offset/nearby wells using field number from proration result (Gap 2)
      // ⚠ These are OFFSET / NEARBY ACTIVITY — never subject-asset production
      const fieldNoFromPro = prorationResult?.find(r => r.field_no)?.field_no ?? null;
      if (isTexasResolved && firstApi && fieldNoFromPro) {
        try {
          fieldWellsResult = await withTimeout(
            fetchTrrcOffsetWellsByField(firstApi, fieldNoFromPro),
            20_000,
            "TRRC offset/nearby wells (same field)",
          ).catch(() => null);
        } catch {
          fieldWellsResult = null;
        }
      }

      const found    = results.filter(r => r.packet_found);
      const notFound = results.filter(r => !r.packet_found);
      const parts: string[] = [];
      if (found.length > 0) {
        parts.push(`${found.length} W-2 packet(s) found`);
        const depths = found
          .filter(r => r.total_depth_ft)
          .map(r => `${r.total_depth_ft?.toLocaleString()} ft`);
        if (depths.length > 0) parts.push(`depth: ${depths.join(", ")}`);
        const formations = found
          .filter(r => r.formation)
          .map(r => r.formation);
        if (formations.length > 0) parts.push(`formation: ${formations.join(", ")}`);
      }
      if (notFound.length > 0) {
        parts.push(`${notFound.length} well(s) not found in CMPL online records`);
      }
      const totalImagedDocs = (imagedResults.status === "fulfilled" ? imagedResults.value : null)
        ?.reduce((s, r) => s + r.records.length, 0) ?? 0;
      if (totalImagedDocs > 0) parts.push(`${totalImagedDocs} imaged record(s) found`);
      if (p5StatusResult)      parts.push(`P-5 status: ${p5StatusResult.org_status}`);
      if (prorationResult && prorationResult.length > 0) parts.push(`proration: ${prorationResult.length} record(s)`);
      if (inactiveWellsResult && inactiveWellsResult.length > 0) parts.push(`${inactiveWellsResult.length} inactive well(s)`);
      if (fieldWellsResult && fieldWellsResult.wells.length > 0) parts.push(`${fieldWellsResult.total_count} offset/nearby well(s) in field ${fieldWellsResult.field_no}`);
      if (cmplPacketDetailResult?.formation) parts.push(`CMPL formation: ${cmplPacketDetailResult.formation}`);

      return {
        result: results,
        detail: parts.length > 0 ? parts.join("; ") : "No completion records found in TRRC CMPL — request W-2 from seller",
        usedFallback: found.length === 0,
        fallbackReason: found.length === 0
          ? "W-2 not in CMPL online system — may be in RRC imaged records; request from seller"
          : undefined,
      };
    },
    [],
  );

  // ── 7. Build decline curves (sync) ────────────────────────────────────────
  await writer.write(progressEvent("build_decline", "running", "Building decline curves…"));
  const totalDataPoints = trrcWells.reduce((s, w) => s + (w.monthly_rows?.length ?? 0), 0);
  await writer.write(progressEvent("build_decline", "complete", "Building decline curves",
    trrcWells.length > 0
      ? `${trrcWells.length} well(s) — DCA from ${totalDataPoints} monthly data points`
      : "No production data — decline model will use benchmark parameters",
    { durationMs: 0 }));

  // ── 8. Run economics (EIA prices + EDGAR + NPV model) ────────────────────
  let financialContext: import("@/lib/underwriting/financial-lookup").FinancialContext | null = null;

  financialContext = await runStep(
    writer,
    "run_economics",
    "Running economics",
    async () => {
      // 25 seconds — EIA and EDGAR are separate fetches and can be slow
      const ctx = await withTimeout(
        fetchFinancialContext(operatorName),
        25_000,
        "EIA / EDGAR financial data",
      );

      const parts: string[] = [];
      if (ctx?.oil_price?.wti_spot_usd)  parts.push(`WTI: $${ctx.oil_price.wti_spot_usd.toFixed(2)}/bbl`);
      if (ctx?.oil_price?.henry_hub_usd) parts.push(`Henry Hub: $${ctx.oil_price.henry_hub_usd.toFixed(2)}/MMBtu`);
      if (ctx?.edgar?.loe_per_boe)       parts.push(`EDGAR LOE: $${ctx.edgar.loe_per_boe.toFixed(2)}/BOE`);

      return {
        result: ctx,
        detail: parts.length > 0
          ? parts.join("; ")
          : "EIA / EDGAR data unavailable — using benchmark defaults",
        usedFallback: !ctx,
        fallbackReason: !ctx ? "EIA / EDGAR lookup timed out — benchmark defaults applied" : undefined,
      };
    },
    null,
  );

  // ── 9. Check missing diligence (sync) ─────────────────────────────────────
  await writer.write(progressEvent("check_diligence", "running", "Checking missing diligence…"));
  await writer.write(progressEvent("check_diligence", "complete", "Checking missing diligence",
    "Diligence tracker built from all collected data", { durationMs: 0 }));

  // ── 10. Generate report ────────────────────────────────────────────────────
  await writer.write(progressEvent("generate_report", "running", "Generating report…"));

  const model = process.env.OPENAI_OCR_MODEL ?? "gpt-4o-mini";

  // Derive seller-claimed monthly production from document extraction.
  // Use the most recent production month present in seller documents (sorted
  // descending by period) as the seller's stated current rate.
  const sellerClaimedMonthlyBbl: number | null = (() => {
    const months = extracted?.production_months ?? [];
    if (months.length === 0) return null;
    const sorted = [...months].sort((a, b) => b.period.localeCompare(a.period));
    return sorted[0]?.oil_bbl ?? null;
  })();

  const report = buildDDReport({
    input: {
      api_numbers:        apiNumbers,
      rrc_lease_numbers:  rrcLeases,
      operator_name:      operatorName ?? undefined,
      lease_name:         leaseName ?? undefined,
      county:             county ?? undefined,
      state:              state ?? undefined,
      documents,
    },
    extracted,
    trrcWells:            trrcWells,
    trrcViolations:       complianceResult,
    trrcInjection:        injectionResult,
    trrcInspections:      inspectionResult,
    trrcCompletions:      completionResult,
    financialContext:     financialContext ?? undefined,
    benchmark:            benchmark ?? undefined,
    nriOverride:          nriOverride ?? undefined,
    wiOverride:           wiOverride  ?? undefined,
    processingTimeMs:     Date.now() - t0,
    aiModel:              model,
    scanMode:             "full",
    trrcResolvedOperator:  trrcResolvedOperator,
    trrcResolvedCounty:    trrcResolvedCounty,
    sellerClaimedMonthlyBbl,
    trrcOperatorProfile:   operatorProfile,
    trrcAnnualProduction:  annualProduction,
    imagedRecords:         imagedRecordsResult,
    trrcP5Status:          p5StatusResult,
    trrcProration:         prorationResult,
    trrcInactiveWells:     inactiveWellsResult,
    trrcFieldWells:        fieldWellsResult,
    cmplPacketDetail:      cmplPacketDetailResult,
    districtViolations:    districtViolationsResult,
    leaseWellInventory:    leaseInventoryResult,
  });

  const totalMs = Date.now() - t0;

  await writer.write(progressEvent("generate_report", "complete", "Report complete",
    `Full underwriting completed in ${(totalMs / 1000).toFixed(1)}s`, { durationMs: totalMs }));

  // Send the final report
  await writer.write(sseChunk({ type: "report", report }));
  await writer.write(sseChunk({ type: "done", totalDurationMs: totalMs }));
  await writer.close();
}
