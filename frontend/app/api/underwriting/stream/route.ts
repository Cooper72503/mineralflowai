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
 * Budget: Vercel Pro maxDuration = 300 s (5 min)
 *   Step 2  parse_documents:  ≤ 90 s  (AI — worth waiting for identifiers)
 *   Step 3  resolve_asset:    ≤ 30 s
 *   Step 4  pull_production:  ≤ 20 s/well, ≤ 120 s total
 *   Step 5  pull_inspections: ≤ 30 s per sub-call (violations, injection, ICE)
 *   Step 6  pull_completions: ≤ 45 s
 *   Step 8  run_economics:    ≤ 25 s
 *   Steps 7,9,10:             < 1 s each (sync)
 *   Total ceiling:            ~240 s
 */

import { NextResponse }                    from "next/server";
import { createSupabaseFromRouteRequest }  from "@/lib/supabase/from-route-request";
import { extractUnderwritingDataFromDocuments } from "@/lib/underwriting/document-extraction";
import { fetchTrrcViolations, fetchTrrcViolationsByOperator } from "@/lib/underwriting/trrc-compliance";
import { fetchTrrcInjectionByApi, fetchTrrcInjectionByOperator } from "@/lib/underwriting/trrc-injection";
import { fetchTrrcInspectionsForApis }     from "@/lib/wells/trrc-inspection";
import { fetchTrrcCompletionsForApis }     from "@/lib/wells/trrc-completions";
import { buildDDReport, type TrrcWellProduction } from "@/lib/underwriting/report-builder";
import { lookupTrrcLeasesByApis, TX_COUNTY_CODES } from "@/lib/wells/trrc-api";
import { fetchTrrcProductionByLease }       from "@/lib/wells/trrc-production";
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
export const maxDuration = 300; // Vercel Pro — 5 minutes

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

/** Race a promise against a timeout; throws on timeout so runStep catches it */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} did not respond within ${ms / 1000}s`)), ms)
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

      // Fetch production for one resolved lease; per-well timeout of 20s
      // prevents a single slow TRRC response from blocking the whole pipeline.
      const fetchWell = async (
        api: string,
        distCode: string,
        leaseNo: string,
        operator: string | null,
      ): Promise<TrrcWellProduction | null> => {
        const res = await withTimeout(
          fetchTrrcProductionByLease(distCode, leaseNo, 36),
          20_000,
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

      if (wells.length === 0) {
        return {
          result: [],
          detail: "No production records found in TRRC for any resolved lease",
          usedFallback: true,
          fallbackReason: "No matching lease found or TRRC returned no rows — check API numbers and lease numbers",
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

  // ── 5. Pull inspections, violations, injection ─────────────────────────────
  // Each sub-call gets its OWN timeout — they run in parallel but independently.
  // This fixes the prior bug where Promise.all was awaited first, making the
  // subsequent Promise.race effectively a no-op.
  let complianceResult: import("@/lib/underwriting/trrc-compliance").TrrcViolation[] = [];
  let injectionResult: import("@/lib/underwriting/trrc-injection").TrrcInjectionRecord[] = [];
  let inspectionResult: import("@/lib/wells/trrc-inspection").TrrcInspectionRecord[] = [];

  [complianceResult, injectionResult, inspectionResult] = await runStep(
    writer,
    "pull_inspections",
    "Pulling inspections & compliance",
    async () => {
      if (!isTexasResolved) {
        return {
          result: [[], [], []] as [typeof complianceResult, typeof injectionResult, typeof inspectionResult],
          detail: "Non-Texas well — TRRC compliance lookup not applicable; provide documents for compliance review",
        };
      }

      // Each call has its own independent 30-second timeout — a slow ICE
      // response will not block violations or injection lookups.
      const [violations, injection, inspections] = await Promise.all([

        // Violations — prefer API number lookup, fall back to operator+county
        (async (): Promise<typeof complianceResult> => {
          try {
            if (apiNumbers.length > 0) {
              return await withTimeout(
                fetchTrrcViolations(apiNumbers[0]),
                30_000,
                "TRRC violations by API",
              );
            }
            if (operatorName && county) {
              return await withTimeout(
                fetchTrrcViolationsByOperator(operatorName, county),
                30_000,
                "TRRC violations by operator",
              );
            }
          } catch { /* timeout — return empty */ }
          return [];
        })(),

        // Injection wells
        (async (): Promise<typeof injectionResult> => {
          try {
            if (apiNumbers.length > 0) {
              return await withTimeout(
                fetchTrrcInjectionByApi(apiNumbers[0]),
                30_000,
                "TRRC injection by API",
              );
            }
            if (operatorName && county) {
              return await withTimeout(
                fetchTrrcInjectionByOperator(operatorName, county),
                30_000,
                "TRRC injection by operator",
              );
            }
          } catch { /* timeout — return empty */ }
          return [];
        })(),

        // ICE field inspection records
        (async (): Promise<typeof inspectionResult> => {
          if (apiNumbers.length === 0) return [];
          try {
            return await withTimeout(
              fetchTrrcInspectionsForApis(apiNumbers),
              30_000,
              "TRRC ICE inspections",
            );
          } catch { /* timeout — return empty */ }
          return [];
        })(),
      ]);

      const parts: string[] = [];
      if (violations.length > 0)  parts.push(`${violations.length} violation(s)`);
      if (injection.length  > 0)  parts.push(`${injection.length} injection well(s)`);
      if (inspections.length > 0) parts.push(`${inspections.length} ICE inspection record(s)`);
      const detail = parts.length > 0
        ? parts.join(", ")
        : "No compliance/inspection records found";

      return {
        result: [violations, injection, inspections] as
          [typeof complianceResult, typeof injectionResult, typeof inspectionResult],
        detail,
      };
    },
    [[], [], []] as [typeof complianceResult, typeof injectionResult, typeof inspectionResult],
  );

  // ── 6. Pull completion / W-2 records ───────────────────────────────────────
  let completionResult: import("@/lib/wells/trrc-completions").TrrcCompletionRecord[] = [];

  completionResult = await runStep(
    writer,
    "pull_completions",
    "Searching completion records",
    async () => {
      if (!isTexasResolved || apiNumbers.length === 0) {
        return {
          result: [],
          detail: !isTexasResolved
            ? "Non-Texas well — TRRC completion lookup not applicable; provide W-2 documents for formation data"
            : "No API numbers available — skipping completion lookup",
          usedFallback: true,
        };
      }

      // 45 seconds — CMPL two-step (EWA drilling permit → CMPL W-2) can be slow
      const results = await withTimeout(
        fetchTrrcCompletionsForApis(apiNumbers),
        45_000,
        "TRRC completion / W-2 lookup",
      );

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

      return {
        result: results,
        detail: parts.length > 0 ? parts.join("; ") : "No completion records found",
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
    trrcResolvedOperator: trrcResolvedOperator,
    trrcResolvedCounty:   trrcResolvedCounty,
    sellerClaimedMonthlyBbl,
  });

  const totalMs = Date.now() - t0;

  await writer.write(progressEvent("generate_report", "complete", "Report complete",
    `Full underwriting completed in ${(totalMs / 1000).toFixed(1)}s`, { durationMs: totalMs }));

  // Send the final report
  await writer.write(sseChunk({ type: "report", report }));
  await writer.write(sseChunk({ type: "done", totalDurationMs: totalMs }));
  await writer.close();
}
