/**
 * POST /api/trrc/due-diligence/[runId]/recalculate-economics
 *
 * Interactive "what if" recalculation for a completed run — asked for
 * directly in the 2026-08-18 Novi call ("do I get to go into software and
 * change my assumptions? Does it recalculate the economics on the fly?").
 *
 * Deliberately does NOT re-run retrieval or re-fit the decline curve from
 * scratch on every keystroke — the run's production history is already
 * persisted (trrc_production_monthly), and computeEconomics() is a pure,
 * fast function of (production arrays, price deck, ...). This endpoint
 * only re-runs that pure computation against a caller-supplied price
 * override, which is what makes "on the fly" actually true instead of a
 * label on another 2.5-minute wait.
 *
 * Oil price ($/bbl), gas price ($/Mcf), purchase price, and — as of
 * economics.ts's NglAndBasisAssumptions — NGL yield/price and Waha basis
 * differential are all live-adjustable. NGL/Waha are explicit, optional,
 * user-supplied assumptions, never automated/inferred data: there is no
 * live NGL or Waha feed anywhere in this codebase, and presenting a
 * guessed multiplier as if it were retrieved would violate this project's
 * evidence-first rule. See economics.ts's NglAndBasisAssumptions doc
 * comment for the full reasoning.
 */

import { NextRequest, NextResponse } from "next/server";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";
import type { TrrcDDProductionRow } from "@/lib/trrc/types";
import type { PriceDeck } from "@/lib/trrc/eia-pricing";
import { computeProductionAnalytics, } from "@/lib/trrc/report-builder";
import { computeEconomics, type NglAndBasisAssumptions } from "@/lib/trrc/economics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RecalcBody {
  oil_usd_bbl?: number;
  gas_usd_mcf?: number;
  purchase_price_usd?: number;
  ngl_yield_bbl_per_mcf?: number;
  ngl_price_usd_bbl?: number;
  waha_differential_usd_mcf?: number;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  // 1. Auth
  const supabase = await createSupabaseFromRouteRequest(request);
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  }

  const { runId } = await params;
  if (!runId) {
    return NextResponse.json({ ok: false, error: "runId is required." }, { status: 400 });
  }

  // 2. Parse and validate the requested overrides
  let body: RecalcBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  if (body.oil_usd_bbl !== undefined && (!isFiniteNumber(body.oil_usd_bbl) || body.oil_usd_bbl <= 0)) {
    return NextResponse.json({ ok: false, error: "oil_usd_bbl must be a positive number." }, { status: 400 });
  }
  if (body.gas_usd_mcf !== undefined && (!isFiniteNumber(body.gas_usd_mcf) || body.gas_usd_mcf <= 0)) {
    return NextResponse.json({ ok: false, error: "gas_usd_mcf must be a positive number." }, { status: 400 });
  }
  if (body.purchase_price_usd !== undefined && (!isFiniteNumber(body.purchase_price_usd) || body.purchase_price_usd <= 0)) {
    return NextResponse.json({ ok: false, error: "purchase_price_usd must be a positive number." }, { status: 400 });
  }
  if (body.ngl_yield_bbl_per_mcf !== undefined && (!isFiniteNumber(body.ngl_yield_bbl_per_mcf) || body.ngl_yield_bbl_per_mcf < 0)) {
    return NextResponse.json({ ok: false, error: "ngl_yield_bbl_per_mcf must be zero or a positive number." }, { status: 400 });
  }
  if (body.ngl_price_usd_bbl !== undefined && (!isFiniteNumber(body.ngl_price_usd_bbl) || body.ngl_price_usd_bbl < 0)) {
    return NextResponse.json({ ok: false, error: "ngl_price_usd_bbl must be zero or a positive number." }, { status: 400 });
  }
  // Deliberately not constrained to >= 0 — a real Waha differential is
  // usually a discount to Henry Hub, but the field represents whatever the
  // caller wants to model; a negative value (a premium) is a legitimate
  // scenario to test, not a malformed input.
  if (body.waha_differential_usd_mcf !== undefined && !isFiniteNumber(body.waha_differential_usd_mcf)) {
    return NextResponse.json({ ok: false, error: "waha_differential_usd_mcf must be a number." }, { status: 400 });
  }

  // 3. Load run (for field/county basin classification) + already-persisted
  // production — RLS-equivalent explicit ownership check, matching every
  // other route in this directory. No TRRC calls happen here; this is why
  // the recalculation is fast.
  const [runResult, productionResult] = await Promise.all([
    supabase
      .from("trrc_due_diligence_runs")
      .select("id, status, resolved_district, purchase_price")
      .eq("id", runId)
      .eq("user_id", user.id)
      .single(),
    supabase
      .from("trrc_production_monthly")
      .select("*")
      .eq("run_id", runId)
      .order("production_month", { ascending: false })
      .limit(120),
  ]);

  if (runResult.error || !runResult.data) {
    return NextResponse.json({ ok: false, error: "Run not found or access denied." }, { status: 404 });
  }
  if (runResult.data["status"] !== "complete") {
    return NextResponse.json({ ok: false, error: "Interactive recalculation is only available for completed runs." }, { status: 409 });
  }

  const production: TrrcDDProductionRow[] = (productionResult.data ?? []).map((p) => ({
    entity_type: p["entity_type"] as "lease" | "api",
    api_number: (p["api_number"] as string | null) ?? null,
    district: (p["district"] as string) ?? "",
    lease_number: (p["lease_number"] as string | null) ?? null,
    gas_id: (p["gas_id"] as string | null) ?? null,
    operator_number: (p["operator_number"] as string | null) ?? null,
    production_month: p["production_month"] as string,
    oil_bbl: (p["oil_bbl"] as number | null) ?? null,
    casinghead_gas_mcf: (p["casinghead_gas_mcf"] as number | null) ?? null,
    gas_mcf: (p["gas_mcf"] as number | null) ?? null,
    condensate_bbl: (p["condensate_bbl"] as number | null) ?? null,
    water_bbl: (p["water_bbl"] as number | null) ?? null,
  }));

  if (production.length === 0) {
    return NextResponse.json({ ok: false, error: "No production history on file for this run — nothing to recalculate against." }, { status: 422 });
  }

  // 4. Build a synthetic, user-driven price deck. Every scenario is
  // deliberately set to the SAME caller-supplied price — this run's
  // interactive panel is a single "what if this price" slider, not the
  // four-scenario ladder the static report shows, so returning
  // econ.scenarios.find(s => s.scenario === "base") gives exactly the
  // number the caller asked for, with zero changes to economics.ts.
  const oilPrice = body.oil_usd_bbl ?? null;
  const gasPrice = body.gas_usd_mcf ?? null;

  // Field/county aren't selected above (kept minimal) — basin classification
  // falls back to the generic LOE default in that case, same documented
  // behavior computeEconomics already has for a null fieldName/county.
  const analytics = computeProductionAnalytics(production);

  let priceDeck: PriceDeck | null = null;
  if (oilPrice !== null || gasPrice !== null) {
    // At least one override supplied — build the deck around it. Fall back
    // to a placeholder for whichever side wasn't overridden rather than
    // silently reusing an EIA-fetched value the caller never asked for and
    // this endpoint never fetched (no live EIA call here, by design).
    const oil = oilPrice ?? 70;
    const gas = gasPrice ?? 3.0;
    priceDeck = {
      source: "static_fallback",
      asOf: "user-adjusted",
      wtiSpotUsdBbl: oil,
      henryHubUsdMcf: gas,
      scenarios: {
        stress: { oilUsdBbl: oil, gasUsdMcf: gas },
        base:   { oilUsdBbl: oil, gasUsdMcf: gas },
        strip:  { oilUsdBbl: oil, gasUsdMcf: gas },
        upside: { oilUsdBbl: oil, gasUsdMcf: gas },
      },
    };
  }

  if (!priceDeck) {
    return NextResponse.json({ ok: false, error: "Provide at least one of oil_usd_bbl or gas_usd_mcf to recalculate." }, { status: 400 });
  }

  const purchasePrice = body.purchase_price_usd ?? (runResult.data["purchase_price"] as number | null) ?? null;

  // Built whenever ANY of the three fields is supplied, defaulting the
  // unset ones to 0 within the object — a caller can supply just a Waha
  // differential without also needing to supply NGL fields, and vice
  // versa. null (all three omitted) preserves exact prior behavior via
  // computeEconomics' own default.
  const nglAndBasis: NglAndBasisAssumptions | null =
    (body.ngl_yield_bbl_per_mcf !== undefined || body.ngl_price_usd_bbl !== undefined || body.waha_differential_usd_mcf !== undefined)
      ? {
          nglYieldBblPerMcf: body.ngl_yield_bbl_per_mcf ?? 0,
          nglPriceUsdBbl: body.ngl_price_usd_bbl ?? 0,
          wahaDifferentialUsdMcf: body.waha_differential_usd_mcf ?? 0,
        }
      : null;

  // Shared by the primary result and the sensitivity grid below — same
  // months of production, same gas price, only oil price varies. Kept as
  // a closure over `analytics`/`purchasePrice`/`nglAndBasis` rather than a
  // module-level export since it's only ever called with this request's
  // data.
  const runEconomicsAt = (oil: number, gas: number) => computeEconomics(
    analytics.months.map(m => m.oil_bbl ?? 0),
    analytics.months.map(m => m.gas_mcf ?? 0),
    {
      source: "static_fallback", asOf: "user-adjusted",
      wtiSpotUsdBbl: oil, henryHubUsdMcf: gas,
      scenarios: {
        stress: { oilUsdBbl: oil, gasUsdMcf: gas }, base: { oilUsdBbl: oil, gasUsdMcf: gas },
        strip:  { oilUsdBbl: oil, gasUsdMcf: gas }, upside: { oilUsdBbl: oil, gasUsdMcf: gas },
      },
    },
    null, null, // field/county — not loaded above; basin falls back to the generic LOE default, same as computeEconomics' own documented behavior
    analytics.months.map(m => m.water_bbl),
    purchasePrice,
    nglAndBasis,
  );

  const econ = runEconomicsAt(priceDeck.wtiSpotUsdBbl, priceDeck.henryHubUsdMcf);
  const result = econ.scenarios.find(s => s.scenario === "base") ?? econ.scenarios[0] ?? null;

  // Price-sensitivity grid — $7 increments around the requested oil price,
  // matching the increment size Novi's own tool uses (per the 2026-08-18
  // call: "I think we do it in increments of... seven dollar increments").
  // Gas price held constant across the row, same convention as their table
  // ("to break even, say oil price is seventy-two dollars a barrel...").
  // Only computed when there's enough data for a real base result — an
  // insufficient-data well would just repeat five identical null rows.
  const STEP = 7;
  const sensitivityGrid = econ.sufficientData
    ? [-2, -1, 0, 1, 2].map(mult => {
        const oil = Math.max(1, priceDeck!.wtiSpotUsdBbl + mult * STEP);
        const rowEcon = runEconomicsAt(oil, priceDeck!.henryHubUsdMcf);
        const rowResult = rowEcon.scenarios.find(s => s.scenario === "base") ?? rowEcon.scenarios[0] ?? null;
        return {
          oilUsdBbl: oil,
          pv10: rowResult?.pv10 ?? null,
          netCashFlow: rowResult?.netCashFlow ?? null,
          isCurrent: mult === 0,
        };
      })
    : [];

  return NextResponse.json({
    ok: true,
    data: {
      inputs: {
        oilUsdBbl: priceDeck.wtiSpotUsdBbl, gasUsdMcf: priceDeck.henryHubUsdMcf, purchasePriceUsd: purchasePrice,
        nglYieldBblPerMcf: nglAndBasis?.nglYieldBblPerMcf ?? 0,
        nglPriceUsdBbl: nglAndBasis?.nglPriceUsdBbl ?? 0,
        wahaDifferentialUsdMcf: nglAndBasis?.wahaDifferentialUsdMcf ?? 0,
      },
      pv10: result?.pv10 ?? null,
      pv15: result?.pv15 ?? null,
      netCashFlow: result?.netCashFlow ?? null,
      grossRevenue: result?.grossRevenue ?? null,
      irr: econ.irr,
      payoutMonths: econ.payoutMonths,
      breakevenOilPriceUsdBbl: econ.breakevenOilPriceUsdBbl,
      costAssumptionNote: econ.costAssumptionNote,
      irrPayoutNote: econ.irrPayoutNote,
      // Real edge case, live-caught pressure-testing this against a
      // 39-month well: computeEconomics deliberately returns an empty
      // scenarios array (all fields above null, not a crash) when neither
      // oil nor gas has enough history for an Arps fit. Surfacing this
      // explicitly so the frontend can say why every number is a dash,
      // instead of a wall of unexplained "—" that reads as broken.
      sufficientData: econ.sufficientData,
      sensitivityGrid,
    },
  });
}
