/**
 * /api/underwriting — Operator Due Diligence Brain
 *
 * POST body: UnderwritingInput
 * Response:  UnderwritingResponse
 *
 * Processing pipeline:
 *   1. Extract structured data from provided documents via OpenAI
 *   2. Resolve well identifiers via strict matching hierarchy → TRRC production
 *   3. Attempt TRRC compliance / violations lookup
 *   4. Attempt TRRC injection well lookup
 *   5. Build DDReport via report-builder
 *
 */

import { NextResponse }                    from "next/server";
import { createSupabaseFromRouteRequest }  from "@/lib/supabase/from-route-request";
import { extractUnderwritingDataFromDocuments } from "@/lib/underwriting/document-extraction";
import { fetchTrrcViolations, fetchTrrcViolationsByOperator } from "@/lib/underwriting/trrc-compliance";
import { fetchTrrcInjectionByApi, fetchTrrcInjectionByOperator } from "@/lib/underwriting/trrc-injection";
import { fetchTrrcInspectionsForApis } from "@/lib/wells/trrc-inspection";
import { fetchTrrcCompletionsForApis } from "@/lib/wells/trrc-completions";
import { buildDDReport, type TrrcWellProduction } from "@/lib/underwriting/report-builder";
import { lookupTrrcLeasesByApis }           from "@/lib/wells/trrc-api";
import { fetchTrrcProductionByLease }       from "@/lib/wells/trrc-production";
import { fetchFinancialContext }            from "@/lib/underwriting/financial-lookup";
import { getBenchmarkFromApi, getBenchmarkFromCounty } from "@/lib/underwriting/benchmarks";
import { fetchBestWvdepProduction }         from "@/lib/wells/wvdep-production";
import { fetchBestOccProduction }           from "@/lib/wells/occ-production";
import { fetchBestNdicProduction }          from "@/lib/wells/ndic-production";
import { fetchBestOcdProduction }           from "@/lib/wells/ocd-production";
import { fetchBestCogccProduction }         from "@/lib/wells/cogcc-production";
import type { UnderwritingInput, UnderwritingResponse } from "@/lib/underwriting/types";
import { fetchTrialStatus }               from "@/lib/trial/trial-status";

export const runtime    = "nodejs";
export const dynamic    = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request): Promise<NextResponse<UnderwritingResponse>> {
  const t0 = Date.now();

  try {
    // ── Auth ──────────────────────────────────────────────────────────────
    const supabase = await createSupabaseFromRouteRequest(request);
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
    }
    const trialStatus = await fetchTrialStatus(supabase, user.id);
    if (trialStatus.state === "expired" || trialStatus.state === "no_trial") {
      return NextResponse.json({ ok: false, error: "Subscription required." }, { status: 402 });
    }

    const body = (await request.json().catch(() => ({}))) as UnderwritingInput;

    const apiNumbers   = body.api_numbers ?? [];
    const rrcLeases    = body.rrc_lease_numbers ?? [];
    const operatorName = (body.operator_name ?? "").trim() || null;
    const leaseName    = (body.lease_name ?? "").trim() || null;
    const county       = (body.county ?? "").trim() || null;
    const state        = (body.state ?? "").trim() || null;
    const documents    = body.documents ?? [];
    const nriOverride  = typeof body.nri_decimal === "number" && body.nri_decimal > 0 && body.nri_decimal <= 1
      ? body.nri_decimal : null;
    const wiOverride   = typeof body.wi_decimal  === "number" && body.wi_decimal  > 0 && body.wi_decimal  <= 1
      ? body.wi_decimal  : null;

    const detectState = (apis: string[], st: string | null) => {
      // API prefix is authoritative — checked first.
      // State name is a hint used only when no API is provided.
      const prefixes = apis.map(a => a.replace(/\D/g, "").slice(0, 2));
      if (prefixes.some(p => p === "42"))               return "TX";
      if (prefixes.some(p => p === "35"))               return "OK";
      if (prefixes.some(p => p === "47"))               return "WV";
      if (prefixes.some(p => p === "33"))               return "ND";
      if (prefixes.some(p => p === "30"))               return "NM";
      if (prefixes.some(p => p === "05"))               return "CO";
      if (prefixes.some(p => p === "49"))               return "WY";
      if (prefixes.some(p => p === "17"))               return "LA";
      if (st && /^texas$|^tx$/i.test(st))              return "TX";
      if (st && /^oklahoma$|^ok$/i.test(st))            return "OK";
      if (st && /^west.?virginia$|^wv$/i.test(st))      return "WV";
      if (st && /^north.?dakota$|^nd$/i.test(st))       return "ND";
      if (st && /^new.?mexico$|^nm$/i.test(st))         return "NM";
      if (st && /^colorado$|^co$/i.test(st))            return "CO";
      if (st && /^wyoming$|^wy$/i.test(st))             return "WY";
      if (st && /^louisiana$|^la$/i.test(st))           return "LA";
      return null;
    };

    // Texas if state explicitly says so, OR if any API number starts with "42"
    const resolvedState = detectState(apiNumbers, state);
    const isTexas = resolvedState === "TX";

    // ── Phase 1: AI document extraction ───────────────────────────────────

    const extracted = await extractUnderwritingDataFromDocuments(documents);

    // Merge API numbers from extraction
    const allApis = [
      ...apiNumbers,
      ...(extracted?.api_numbers ?? []),
    ].filter((v, i, a) => v && a.indexOf(v) === i);

    const allLeases = [
      ...rrcLeases,
      ...(extracted?.rrc_lease_numbers ?? []),
    ].filter((v, i, a) => v && a.indexOf(v) === i);

    const resolvedCounty  = county  ?? extracted?.county  ?? null;
    const resolvedOperator = operatorName ?? extracted?.operator_name ?? null;

    // ── Phase 2: TRRC + compliance + injection (parallel) ─────────────────

    // Basin benchmarks — synchronous, no network call
    const api8ForBenchmark = allApis
      .map(a => a.replace(/\D/g, ""))
      .map(d => d.startsWith("42") && d.length >= 10 ? d.slice(2, 10) : d.slice(0, 8))
      .find(d => d.length === 8);
    const benchmark = api8ForBenchmark
      ? getBenchmarkFromApi(api8ForBenchmark)
      : (resolvedCounty ? getBenchmarkFromCounty(resolvedCounty) : null);

    const [trrcResult, complianceResult, injectionResult, inspectionResult, completionResult, financialContext] = await Promise.all([
      // Production — Texas via TRRC, other states via their own agencies
      (async (): Promise<TrrcWellProduction[]> => {
        if (!isTexas) {
          // Non-Texas: dispatch to the appropriate state agency fetcher
          const buildRow = (api: string, agencyLabel: string, rows: Array<{ year: number; month: number; oil_bbl: number; gas_mcf: number | null; water_bbl?: number | null }>, cumOil: number): TrrcWellProduction => {
            const sorted = [...rows].sort((a, b) => a.year !== b.year ? a.year - b.year : a.month - b.month);
            const latest = sorted[sorted.length - 1];
            return {
              api,
              well_name: `API ${api} (${agencyLabel})`,
              lease_number: null,
              district_code: null,
              operator: resolvedOperator,
              latest_monthly_oil_bbl: latest?.oil_bbl ?? 0,
              latest_production_month: latest ? `${latest.year}-${String(latest.month).padStart(2, "0")}` : null,
              cum_oil_bbl: cumOil,
              monthly_rows: sorted.map(r => ({ year: r.year, month: r.month, oil_bbl: r.oil_bbl, gas_mcf: r.gas_mcf ?? 0, water_bbl: r.water_bbl ?? null })),
            };
          };

          if (resolvedState === "WV" && allApis.length > 0) {
            const res = await fetchBestWvdepProduction(allApis, 36).catch(() => null);
            if (res?.rows.length) return [buildRow(res.api_number, "WV DEP", res.rows, res.rows.reduce((s, r) => s + r.oil_bbl, 0))];
          }
          if (resolvedState === "OK" && allApis.length > 0) {
            const res = await fetchBestOccProduction(allApis, 36).catch(() => null);
            if (res?.rows.length) return [buildRow(res.api_number, "OCC", res.rows, res.rows.reduce((s, r) => s + r.oil_bbl, 0))];
          }
          if (resolvedState === "ND" && allApis.length > 0) {
            const res = await fetchBestNdicProduction(allApis, 36).catch(() => null);
            if (res?.rows.length) return [buildRow(res.api_number, "NDIC", res.rows, res.rows.reduce((s, r) => s + r.oil_bbl, 0))];
          }
          if (resolvedState === "NM" && allApis.length > 0) {
            const res = await fetchBestOcdProduction(allApis, 36).catch(() => null);
            if (res?.rows.length) return [buildRow(res.api_number, "NM OCD", res.rows, res.rows.reduce((s, r) => s + r.oil_bbl, 0))];
          }
          if (resolvedState === "CO" && allApis.length > 0) {
            const res = await fetchBestCogccProduction(allApis, 36).catch(() => null);
            if (res?.rows.length) return [buildRow(res.api_number, "CO COGCC", res.rows, res.rows.reduce((s, r) => s + r.oil_bbl, 0))];
          }
          return [];
        }

        // Helper: fetch production for a resolved lease entry
        const fetchWell = async (
          api: string,
          distCode: string,
          leaseNo: string,
          operator: string | null,
        ): Promise<TrrcWellProduction | null> => {
          const result = await fetchTrrcProductionByLease(distCode, leaseNo);
          if (!result || result.rows.length === 0) return null;
          const sorted = [...result.rows].sort((a, b) =>
            a.year !== b.year ? a.year - b.year : a.month - b.month
          );
          const latest = sorted[sorted.length - 1];
          return {
            api,
            well_name: `Lease ${leaseNo} (District ${distCode})`,
            lease_number: leaseNo,
            district_code: distCode,
            operator: operator || resolvedOperator,
            // Use the actual latest month's reported production — not a smoothed average.
            // Rolling averages (3/6/12-month) are computed in report-builder from monthly_rows.
            latest_monthly_oil_bbl: latest ? latest.oil_bbl : 0,
            latest_production_month: latest ? `${latest.year}-${String(latest.month).padStart(2, "0")}` : null,
            cum_oil_bbl: sorted.reduce((s, r) => s + r.oil_bbl, 0),
            monthly_rows: sorted.map(r => ({
              year: r.year, month: r.month,
              oil_bbl: r.oil_bbl,
              gas_mcf: r.gas_mcf ?? 0,
              // TRRC production reports do NOT include water disposition volumes.
              // Storing null here prevents false "0% water cut" calculations.
              water_bbl: null,
            })),
          };
        };

        // ── Path A: API numbers supplied (primary path) ───────────────────
        // Always try this first — API number carries its own county code so
        // no state/county input is needed from the user.
        if (allApis.length > 0) {
          const leaseRace = await lookupTrrcLeasesByApis(resolvedCounty, allApis);

          const wells: TrrcWellProduction[] = [];
          const seenLeases = new Set<string>();

          await Promise.allSettled(
            Array.from(leaseRace.entries()).slice(0, 5).map(async ([api, { distCode, leaseNo, operator }]) => {
              const key = `${distCode}:${leaseNo}`;
              if (seenLeases.has(key)) return;
              seenLeases.add(key);
              const w = await fetchWell(api, distCode, leaseNo, operator);
              if (w) wells.push(w);
            })
          );
          if (wells.length > 0) return wells;
          // fall through to lease path if API lookup yielded no production
        }

        // ── Path B: RRC lease numbers supplied ────────────────────────────
        // Accepts two formats:
        //   "7B:29126"  → distCode=7B, leaseNo=29126  (explicit)
        //   "29126"     → leaseNo only; we try common district codes
        if (allLeases.length > 0) {
          const wells: TrrcWellProduction[] = [];
          const seenLeases = new Set<string>();
          const DISTRICT_CODES = ["1","2","3","4","5","6","7B","7C","8","8A","9","10"];

          await Promise.allSettled(
            allLeases.slice(0, 5).map(async lease => {
              const parts = lease.split(":");
              if (parts.length >= 2) {
                // Explicit distCode:leaseNo
                const [distCode, leaseNo] = parts;
                const key = `${distCode}:${leaseNo}`;
                if (seenLeases.has(key)) return;
                seenLeases.add(key);
                const w = await fetchWell(`42000000000`, distCode, leaseNo, null);
                if (w) wells.push(w);
              } else {
                // Raw lease number — try all district codes and take the first hit
                const leaseNo = lease.trim();
                for (const distCode of DISTRICT_CODES) {
                  const key = `${distCode}:${leaseNo}`;
                  if (seenLeases.has(key)) continue;
                  seenLeases.add(key);
                  const w = await fetchWell(`42000000000`, distCode, leaseNo, null);
                  if (w) { wells.push(w); break; }
                }
              }
            })
          );
          return wells;
        }

        return [];
      })(),

      // TRRC compliance
      (async () => {
        if (!isTexas) return [];
        if (allApis.length > 0) return fetchTrrcViolations(allApis[0]);
        if (resolvedOperator && resolvedCounty)
          return fetchTrrcViolationsByOperator(resolvedOperator, resolvedCounty);
        return [];
      })(),

      // TRRC injection
      (async () => {
        if (!isTexas) return [];
        if (allApis.length > 0) return fetchTrrcInjectionByApi(allApis[0]);
        if (resolvedOperator && resolvedCounty)
          return fetchTrrcInjectionByOperator(resolvedOperator, resolvedCounty);
        return [];
      })(),

      // TRRC ICE inspection records (field visits, pass/fail, defect notes)
      // No leaseNo available in this path — falls back to per-API (capped at 8).
      (async () => {
        if (!isTexas || allApis.length === 0) return [];
        return fetchTrrcInspectionsForApis(allApis, null);
      })(),

      // TRRC completions query (W-2 packet: formation, spud, depth, interval)
      (async () => {
        if (!isTexas || allApis.length === 0) return [];
        return fetchTrrcCompletionsForApis(allApis);
      })(),

      // EIA prices + EDGAR operator financials
      fetchFinancialContext(resolvedOperator),
    ]);

    // ── Phase 3: Build report ─────────────────────────────────────────────

    const report = buildDDReport({
      input: {
        api_numbers:        allApis,
        rrc_lease_numbers:  allLeases,
        operator_name:      resolvedOperator ?? undefined,
        lease_name:         leaseName ?? undefined,
        county:             resolvedCounty ?? undefined,
        state:              state ?? undefined,
        documents,
      },
      extracted,
      trrcWells:        trrcResult,
      trrcViolations:   complianceResult,
      trrcInjection:    injectionResult,
      trrcInspections:  inspectionResult,
      trrcCompletions:  completionResult,
      financialContext: financialContext ?? undefined,
      benchmark: benchmark ?? undefined,
      nriOverride: nriOverride ?? undefined,
      wiOverride:  wiOverride  ?? undefined,
      processingTimeMs: Date.now() - t0,
      aiModel: process.env.EXTRACTION_MODEL ?? "claude-sonnet-4-6",
      // This endpoint is always Quick Scan — full underwriting uses /api/underwriting/stream
      scanMode: "quick",
    });

    // ── Server-side truth-check redaction ────────────────────────────────
    // Same rules as /api/underwriting/stream — blocked data never leaves the
    // server regardless of which route the caller hit.
    //
    // 1. block_economics → null entire economics + acquisition_economics sections
    // 2. offer_gate closed → null the three offer range fields only
    // 3. overall_verdict "block" → force diligence_run_label to "Failed Verification"
    if (report.truth_check?.gate?.block_economics) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (report as any).economics             = null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (report as any).acquisition_economics = null;
    }

    if (report.offer_gate?.gate_open === false && report.acquisition_economics != null) {
      const blockedDp = {
        value:      null,
        source:     "missing" as const,
        confidence: "none"    as const,
        note:       "Offer gate closed — provide LOE statements and division order to unlock.",
      };
      const acq = report.acquisition_economics as Record<string, unknown>;
      acq.offer_range_low  = blockedDp;
      acq.offer_range_mid  = blockedDp;
      acq.offer_range_high = blockedDp;
    }

    if (report.truth_check?.overall_verdict === "block") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (report as any).diligence_run_label = "Failed Verification";
    }

    return NextResponse.json({ ok: true, report });

  } catch (err) {
    console.error("[underwriting] route error:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Internal error" },
      { status: 500 }
    );
  }
}
