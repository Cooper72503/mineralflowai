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
 * Budget: Vercel maxDuration = 60 s
 *   AI extraction:  40 s cap
 *   TRRC lookups:   18 s cap (parallel)
 *   Report build:    <1 s
 */

import { NextResponse }                    from "next/server";
import { createSupabaseFromRouteRequest }  from "@/lib/supabase/from-route-request";
import { extractUnderwritingDataFromDocuments } from "@/lib/underwriting/document-extraction";
import { fetchTrrcViolations, fetchTrrcViolationsByOperator } from "@/lib/underwriting/trrc-compliance";
import { fetchTrrcInjectionByApi, fetchTrrcInjectionByOperator } from "@/lib/underwriting/trrc-injection";
import { buildDDReport, type TrrcWellProduction } from "@/lib/underwriting/report-builder";
import { lookupTrrcLeasesByApis }           from "@/lib/wells/trrc-api";
import { fetchTrrcProductionByLease }       from "@/lib/wells/trrc-production";
import type { UnderwritingInput, UnderwritingResponse } from "@/lib/underwriting/types";

export const runtime    = "nodejs";
export const dynamic    = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request): Promise<NextResponse<UnderwritingResponse>> {
  const t0 = Date.now();

  try {
    // ── Auth ──────────────────────────────────────────────────────────────
    const supabase = await createSupabaseFromRouteRequest(request);
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
    }

    const body = (await request.json().catch(() => ({}))) as UnderwritingInput;

    const apiNumbers   = body.api_numbers ?? [];
    const rrcLeases    = body.rrc_lease_numbers ?? [];
    const operatorName = (body.operator_name ?? "").trim() || null;
    const leaseName    = (body.lease_name ?? "").trim() || null;
    const county       = (body.county ?? "").trim() || null;
    const state        = (body.state ?? "").trim() || null;
    const documents    = body.documents ?? [];

    const isTexas = !!state && /^texas$|^tx$/i.test(state.trim());

    // ── Phase 1: AI document extraction (up to 40 s) ──────────────────────

    const extractionDeadline = new Promise<null>(r => setTimeout(() => r(null), 40_000));
    const extracted = await Promise.race([
      extractUnderwritingDataFromDocuments(documents),
      extractionDeadline,
    ]);

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

    // ── Phase 2: TRRC + compliance + injection (parallel, 18 s cap) ───────

    const lookupDeadline = new Promise<null>(r => setTimeout(() => r(null), 18_000));

    const [trrcResult, complianceResult, injectionResult] = await Promise.all([
      // TRRC production
      (async (): Promise<TrrcWellProduction[]> => {
        if (!isTexas) return [];
        if (allLeases.length > 0) {
          // Direct lease lookup
          const wells: TrrcWellProduction[] = [];
          await Promise.allSettled(
            allLeases.slice(0, 5).map(async lease => {
              const [distCode, leaseNo] = lease.split(":");
              if (!distCode || !leaseNo) return;
              const result = await fetchTrrcProductionByLease(distCode, leaseNo, 12);
              if (!result || result.rows.length === 0) return;
              const sorted = [...result.rows].sort((a, b) => a.year !== b.year ? a.year - b.year : a.month - b.month);
              const recentRows = sorted.slice(-3).filter(r => r.oil_bbl > 0);
              const avgBbl = recentRows.length > 0
                ? recentRows.reduce((s, r) => s + r.oil_bbl, 0) / recentRows.length
                : 0;
              const latest = sorted[sorted.length - 1];
              wells.push({
                api: `42000000000`,  // placeholder when only lease known
                well_name: `Lease ${leaseNo} (District ${distCode})`,
                lease_number: leaseNo,
                district_code: distCode,
                operator: resolvedOperator,
                latest_monthly_oil_bbl: avgBbl,
                latest_production_month: latest ? `${latest.year}-${String(latest.month).padStart(2, "0")}` : null,
                cum_oil_bbl: sorted.reduce((s, r) => s + r.oil_bbl, 0),
                monthly_rows: sorted.map(r => ({
                  year: r.year, month: r.month,
                  oil_bbl: r.oil_bbl,
                  gas_mcf: r.gas_mcf ?? 0,
                  water_bbl: 0,
                })),
              });
            })
          );
          return wells;
        }

        if (allApis.length > 0) {
          // API → lease resolution. County is optional — the function derives
          // the FIPS county code from the API number itself (first 3 digits of
          // the 8-digit form), so any Texas well can be looked up with just its
          // API number, no county name required.
          const leaseRace = await Promise.race([
            lookupTrrcLeasesByApis(resolvedCounty, allApis),
            new Promise<Map<string, { distCode: string; leaseNo: string; operator: string }>>(
              r => setTimeout(() => r(new Map()), 14_000)
            ),
          ]);

          const wells: TrrcWellProduction[] = [];
          const seenLeases = new Set<string>();

          await Promise.allSettled(
            Array.from(leaseRace.entries()).slice(0, 5).map(async ([api, { distCode, leaseNo, operator }]) => {
              const key = `${distCode}:${leaseNo}`;
              if (seenLeases.has(key)) return;
              seenLeases.add(key);

              const result = await fetchTrrcProductionByLease(distCode, leaseNo, 12);
              if (!result || result.rows.length === 0) return;

              const sorted = [...result.rows].sort((a, b) => a.year !== b.year ? a.year - b.year : a.month - b.month);
              const recentRows = sorted.slice(-3).filter(r => r.oil_bbl > 0);
              const avgBbl = recentRows.length > 0
                ? recentRows.reduce((s, r) => s + r.oil_bbl, 0) / recentRows.length
                : 0;
              const latest = sorted[sorted.length - 1];

              wells.push({
                api,
                well_name: `Lease ${leaseNo} (District ${distCode})`,
                lease_number: leaseNo,
                district_code: distCode,
                operator: operator || resolvedOperator,
                latest_monthly_oil_bbl: avgBbl,
                latest_production_month: latest ? `${latest.year}-${String(latest.month).padStart(2, "0")}` : null,
                cum_oil_bbl: sorted.reduce((s, r) => s + r.oil_bbl, 0),
                monthly_rows: sorted.map(r => ({
                  year: r.year, month: r.month,
                  oil_bbl: r.oil_bbl,
                  gas_mcf: r.gas_mcf ?? 0,
                  water_bbl: 0,
                })),
              });
            })
          );
          return wells;
        }

        return [];
      })(),

      // TRRC compliance
      (async () => {
        if (!isTexas) return [];
        if (allApis.length > 0) {
          const results = await Promise.race([
            fetchTrrcViolations(allApis[0]),
            lookupDeadline.then(() => []),
          ]);
          return Array.isArray(results) ? results : [];
        }
        if (resolvedOperator && resolvedCounty) {
          const results = await Promise.race([
            fetchTrrcViolationsByOperator(resolvedOperator, resolvedCounty),
            lookupDeadline.then(() => []),
          ]);
          return Array.isArray(results) ? results : [];
        }
        return [];
      })(),

      // TRRC injection
      (async () => {
        if (!isTexas) return [];
        if (allApis.length > 0) {
          const results = await Promise.race([
            fetchTrrcInjectionByApi(allApis[0]),
            lookupDeadline.then(() => []),
          ]);
          return Array.isArray(results) ? results : [];
        }
        if (resolvedOperator && resolvedCounty) {
          const results = await Promise.race([
            fetchTrrcInjectionByOperator(resolvedOperator, resolvedCounty),
            lookupDeadline.then(() => []),
          ]);
          return Array.isArray(results) ? results : [];
        }
        return [];
      })(),
    ]);

    // ── Phase 3: Build report ─────────────────────────────────────────────

    const model = process.env.OPENAI_OCR_MODEL ?? "gpt-4o-mini";
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
      trrcWells: trrcResult,
      trrcViolations: complianceResult,
      trrcInjection: injectionResult,
      processingTimeMs: Date.now() - t0,
      aiModel: model,
    });

    return NextResponse.json({ ok: true, report });

  } catch (err) {
    console.error("[underwriting] route error:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Internal error" },
      { status: 500 }
    );
  }
}
