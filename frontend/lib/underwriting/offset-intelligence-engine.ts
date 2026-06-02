/**
 * Offset Intelligence Engine
 *
 * Takes a geocoded acreage location and builds a full offset well intelligence
 * profile: nearby well discovery → production fetch → DCA → type curves →
 * operator scoring → drilling momentum → probabilistic valuation.
 *
 * This is the "first-pass acquisition engine" — it must produce a directional
 * valuation even when only a legal description is provided.
 *
 * SECURITY: No user-level production is invented. Every estimate is clearly
 * labeled INFERRED or ESTIMATED and sourced to offset data.
 */

import type {
  AcreageInput,
  AcreageLocation,
  AcreageValuationReport,
  OffsetWellProfile,
  TypeCurveResult,
  OperatorProfile,
  DrillingMomentum,
  AcreageValuation,
  FormationProfile,
} from "./types-acreage";

import { parseLegalDescription, inferCountyAndStateFromTexts, extractAcreageFromTexts } from "@/lib/location/legal-description-parser";
import { geocodeProperty } from "@/lib/location/property-geocode";
import { lookupWellsByLegalDescription } from "@/lib/wells/trrc-abstract-lookup";
import { lookupTrrcLeasesByApis } from "@/lib/wells/trrc-api";
import { fetchTrrcProductionByLease } from "@/lib/wells/trrc-production";
import { runDca } from "./decline-curve";
import { inferFormationProfile } from "./formation-intelligence";
import { haversineDistanceMiles } from "@/lib/wells/nearby-wells";

// ─── Statewide wells spatial query (reused from abstract-lookup pattern) ──────

const STATEWIDE_WELLS_URL =
  "https://services.arcgis.com/KTcxiTD9dsQw4r7Z/arcgis/rest/services/Statewide_Surface_Wells_Aug2019/FeatureServer/0/query";

async function fetchWellsNearPoint(
  lat: number,
  lng: number,
  radiusMiles: number,
  signal?: AbortSignal,
): Promise<Array<{ api: string; lat: number; lng: number }>> {
  // Convert radius to degrees (rough, good enough for bbox pre-filter)
  const degLat = radiusMiles / 69;
  const degLng = radiusMiles / (Math.cos((lat * Math.PI) / 180) * 69.1);
  const buf    = 0.005; // small extra buffer

  const qp = new URLSearchParams({
    where: `LAT83 BETWEEN ${lat - degLat - buf} AND ${lat + degLat + buf} AND LONG83 BETWEEN ${lng - degLng - buf} AND ${lng + degLng + buf}`,
    outFields:           "API,LAT83,LONG83",
    returnGeometry:      "false",
    resultRecordCount:   "200",
    f:                   "json",
  });

  const res  = await fetch(`${STATEWIDE_WELLS_URL}?${qp}`, { signal });
  if (!res.ok) return [];
  const json = await res.json() as { features?: Array<{ attributes: { API: string; LAT83: number | null; LONG83: number | null } }> };

  return (json.features ?? [])
    .filter(f => f.attributes.LAT83 != null && f.attributes.LONG83 != null)
    .map(f => {
      const rawApi = String(f.attributes.API ?? "").replace(/\D/g, "");
      const full   = rawApi.length === 8 ? `42${rawApi}` : rawApi.length === 10 ? rawApi : null;
      return full
        ? { api: full, lat: f.attributes.LAT83!, lng: f.attributes.LONG83! }
        : null;
    })
    .filter((x): x is { api: string; lat: number; lng: number } => x !== null);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function compassDirection(fromLat: number, fromLng: number, toLat: number, toLng: number): string {
  const dLat = toLat - fromLat;
  const dLng = toLng - fromLng;
  const angle = (Math.atan2(dLng, dLat) * 180) / Math.PI; // degrees from north
  const sectors = ["N","NE","E","SE","S","SW","W","NW"];
  const idx = Math.round(((angle + 360) % 360) / 45) % 8;
  return sectors[idx];
}

function proximityZone(miles: number): OffsetWellProfile["proximity_zone"] {
  if (miles <= 0.5)  return "SAME_SECTION";
  if (miles <= 1.0)  return "1_MILE";
  if (miles <= 3.0)  return "3_MILE";
  if (miles <= 5.0)  return "5_MILE";
  return "BEYOND";
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo  = Math.floor(idx);
  const hi  = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function calcRecencyWeight(firstProdYear: number | null, lastProdYear: number | null): number {
  const refYear = 2026;
  const yr = lastProdYear ?? firstProdYear;
  if (!yr) return 0.4;
  const age = refYear - yr;
  if (age <= 2)  return 1.0;
  if (age <= 5)  return 0.85;
  if (age <= 10) return 0.65;
  if (age <= 15) return 0.45;
  return 0.3;
}

// ─── Production fetch for offset wells ───────────────────────────────────────

async function fetchOffsetProduction(
  apis: string[],
  maxWells = 15,
): Promise<Map<string, { year: number; month: number; oil_bbl: number }[]>> {
  // Step 1: resolve API → distCode + leaseNo
  const leaseMap = await lookupTrrcLeasesByApis(null, apis.slice(0, maxWells)).catch(() => new Map());

  const result = new Map<string, { year: number; month: number; oil_bbl: number }[]>();
  if (leaseMap.size === 0) return result;

  // Step 2: fetch full production history in parallel (with concurrency limit)
  const entries = Array.from(leaseMap.entries());
  const CONCURRENCY = 6;

  for (let i = 0; i < entries.length; i += CONCURRENCY) {
    const batch = entries.slice(i, i + CONCURRENCY);
    await Promise.allSettled(
      batch.map(async ([api10, { distCode, leaseNo }]) => {
        const prod = await fetchTrrcProductionByLease(distCode, leaseNo, 120).catch(() => null);
        if (prod && prod.rows.length > 0) {
          result.set(api10, prod.rows.map(r => ({ year: r.year, month: r.month, oil_bbl: r.oil_bbl })));
        }
      }),
    );
  }

  return result;
}

// ─── Build offset well profiles ───────────────────────────────────────────────

function buildOffsetProfile(
  api: string,
  operator: string,
  lat: number,
  lng: number,
  centroidLat: number,
  centroidLng: number,
  history: { year: number; month: number; oil_bbl: number }[],
): OffsetWellProfile {
  const dist = haversineDistanceMiles(centroidLat, centroidLng, lat, lng);
  const dir  = compassDirection(centroidLat, centroidLng, lat, lng);
  const zone = proximityZone(dist);

  const sorted = [...history].sort((a, b) =>
    a.year !== b.year ? a.year - b.year : a.month - b.month,
  );
  const positive = sorted.filter(r => r.oil_bbl > 0);
  const cum      = sorted.reduce((s, r) => s + r.oil_bbl, 0);
  const peak     = positive.length > 0 ? Math.max(...positive.map(r => r.oil_bbl)) : 0;
  const last12   = positive.slice(-12);
  const avg12    = last12.length > 0
    ? last12.reduce((s, r) => s + r.oil_bbl, 0) / last12.length
    : null;

  const firstProdYear  = sorted.length > 0 ? sorted[0].year : null;
  const lastProdYear   = sorted.length > 0 ? sorted[sorted.length - 1].year : null;
  const recencyWeight  = calcRecencyWeight(firstProdYear, lastProdYear);
  const isActive       = positive.length > 0 && (2026 - (lastProdYear ?? 0)) <= 2;

  // Run DCA for EUR estimate
  let eurBbl: number | null          = null;
  let declineType: OffsetWellProfile["decline_type"] = null;
  let declineAnnualPct: number | null = null;

  if (positive.length >= 3) {
    const dcaResult = runDca(positive);
    if (dcaResult) {
      eurBbl          = dcaResult.eur_bbl;
      declineType     = dcaResult.model.type;
      declineAnnualPct = dcaResult.decline_rate_annual_pct;
    }
  }

  return {
    api,
    operator,
    distance_mi:      Math.round(dist * 100) / 100,
    direction:        dir,
    lat,
    lng,
    monthly_history:  sorted,
    cum_oil_bbl:      cum,
    peak_month_bbl:   peak,
    last_12mo_avg_bbl: avg12 != null ? Math.round(avg12) : null,
    eur_bbl:          eurBbl,
    decline_type:     declineType,
    decline_annual_pct: declineAnnualPct,
    months_of_data:   sorted.length,
    proximity_zone:   zone,
    is_active:        isActive,
    first_prod_year:  firstProdYear,
    last_prod_year:   lastProdYear,
    recency_weight:   recencyWeight,
  };
}

// ─── Type curve aggregation ───────────────────────────────────────────────────

function buildTypeCurve(wells: OffsetWellProfile[]): TypeCurveResult | null {
  const withEur  = wells.filter(w => w.eur_bbl != null && w.eur_bbl > 0);
  const withPeak = wells.filter(w => w.peak_month_bbl > 0);

  if (withEur.length < 2 && withPeak.length < 2) return null;

  const eurValues  = withEur.map(w => w.eur_bbl!).sort((a, b) => a - b);
  const peakValues = withPeak.map(w => w.peak_month_bbl).sort((a, b) => a - b);

  const declines = wells
    .filter(w => w.decline_annual_pct != null && w.decline_annual_pct > 0)
    .map(w => w.decline_annual_pct!);

  const avgDecline = declines.length > 0
    ? declines.reduce((s, v) => s + v, 0) / declines.length
    : null;

  // Confidence based on well count and recency
  const avgRecency = wells.reduce((s, w) => s + w.recency_weight, 0) / wells.length;
  const confidence: TypeCurveResult["confidence"] =
    withEur.length >= 5 && avgRecency >= 0.7  ? "HIGH"   :
    withEur.length >= 3 && avgRecency >= 0.4  ? "MEDIUM" : "LOW";

  let note: string | null = null;
  if (withEur.length < 3)  note = `Only ${withEur.length} well${withEur.length !== 1 ? "s" : ""} had sufficient production for DCA — EUR estimates are directional only.`;
  if (avgRecency < 0.5)    note = (note ? note + " " : "") + "Most offset wells are older vintages; EUR expectations may not reflect current completion technology.";

  return {
    well_count:              wells.length,
    p10_eur_bbl:             Math.round(percentile(eurValues, 90)),   // P10 = 90th pctl
    p50_eur_bbl:             Math.round(percentile(eurValues, 50)),
    p90_eur_bbl:             Math.round(percentile(eurValues, 10)),   // P90 = 10th pctl
    p10_peak_bbl:            Math.round(percentile(peakValues, 90)),
    p50_peak_bbl:            Math.round(percentile(peakValues, 50)),
    p90_peak_bbl:            Math.round(percentile(peakValues, 10)),
    avg_decline_annual_pct:  avgDecline != null ? Math.round(avgDecline * 10) / 10 : null,
    confidence,
    wells_used:              withEur.map(w => w.api),
    recency_score:           Math.round(avgRecency * 100) / 100,
    data_quality_note:       note,
  };
}

// ─── Operator scoring ──────────────────────────────────────────────────────────

function buildOperatorProfiles(wells: OffsetWellProfile[]): OperatorProfile[] {
  const byOp = new Map<string, OffsetWellProfile[]>();
  for (const w of wells) {
    const key = w.operator || "Unknown";
    const arr = byOp.get(key) ?? [];
    arr.push(w);
    byOp.set(key, arr);
  }

  const profiles: OperatorProfile[] = [];

  for (const [name, opWells] of Array.from(byOp.entries())) {
    const eursValid  = opWells.filter((w: OffsetWellProfile) => w.eur_bbl != null && w.eur_bbl > 0);
    const peaksValid = opWells.filter((w: OffsetWellProfile) => w.peak_month_bbl > 0);

    const avgEur  = eursValid.length > 0
      ? eursValid.reduce((s: number, w: OffsetWellProfile) => s + w.eur_bbl!, 0) / eursValid.length
      : null;
    const avgPeak = peaksValid.length > 0
      ? peaksValid.reduce((s: number, w: OffsetWellProfile) => s + w.peak_month_bbl, 0) / peaksValid.length
      : null;
    const pctActive = (opWells.filter((w: OffsetWellProfile) => w.is_active).length / opWells.length) * 100;
    const mostRecentYr = opWells.reduce((best: number | null, w: OffsetWellProfile) => {
      const yr = w.last_prod_year ?? w.first_prod_year;
      if (yr && (best == null || yr > best)) return yr;
      return best;
    }, null);

    // Tier logic: TIER1 = high EUR + active + recent, TIER3 = marginal
    let tier: OperatorProfile["quality_tier"] = "TIER2";
    let tierRationale = "Moderate production history among offset wells";

    if (
      avgEur != null && avgEur > 400_000 &&
      pctActive >= 60 &&
      mostRecentYr != null && mostRecentYr >= 2022
    ) {
      tier           = "TIER1";
      tierRationale  = "Strong EUR, high activity rate, actively operating recently";
    } else if (
      (avgEur != null && avgEur < 80_000) ||
      pctActive < 30 ||
      (mostRecentYr != null && mostRecentYr < 2018)
    ) {
      tier           = "TIER3";
      tierRationale  = "Below-average EUR or low activity — marginal operator in this area";
    }

    profiles.push({
      name,
      well_count:          opWells.length,
      avg_eur_bbl:         avgEur != null ? Math.round(avgEur) : null,
      avg_peak_bbl:        avgPeak != null ? Math.round(avgPeak) : null,
      pct_active:          Math.round(pctActive),
      quality_tier:        tier,
      tier_rationale:      tierRationale,
      most_recent_well_yr: mostRecentYr,
    });
  }

  return profiles.sort((a, b) => b.well_count - a.well_count);
}

// ─── Drilling momentum ────────────────────────────────────────────────────────

function buildDrillingMomentum(wells: OffsetWellProfile[]): DrillingMomentum {
  const refYear = 2026;

  const spud3yr = wells.filter(w => {
    const yr = w.first_prod_year;
    return yr != null && (refYear - yr) <= 3;
  }).length;
  const spud5yr = wells.filter(w => {
    const yr = w.first_prod_year;
    return yr != null && (refYear - yr) <= 5;
  }).length;
  const post2020 = wells.filter(w => (w.first_prod_year ?? 0) >= 2020).length;
  const pctPost2020 = wells.length > 0
    ? Math.round((post2020 / wells.length) * 100)
    : 0;

  // Score
  let score = 0;
  score += Math.min(spud3yr * 10, 40);    // up to 40 pts for recent wells
  score += Math.min(spud5yr * 5, 20);     // up to 20 pts for 5-yr window
  score += Math.min(pctPost2020 / 2, 20); // up to 20 pts for recency %
  // Active wells bonus
  const activePct = wells.filter(w => w.is_active).length / Math.max(wells.length, 1) * 100;
  score += Math.min(activePct / 5, 20);
  score = Math.min(Math.round(score), 100);

  let trend: DrillingMomentum["trend"] = "INACTIVE";
  if (score >= 65)      trend = "ACCELERATING";
  else if (score >= 40) trend = "STABLE";
  else if (score >= 20) trend = "DECLINING";

  // Dominant operator
  const opCounts: Record<string, number> = {};
  for (const w of wells) {
    const k = w.operator || "Unknown";
    opCounts[k] = (opCounts[k] ?? 0) + 1;
  }
  const dominant = Object.entries(opCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  const interpretations: Record<DrillingMomentum["trend"], string> = {
    ACCELERATING: `Active development area — ${spud3yr} wells spud within 3 years. ${dominant ? dominant + " is" : "Multiple operators are"} actively drilling nearby.`,
    STABLE:       `Steady development activity — ${spud5yr} wells spud in the last 5 years. Area appears to be in a sustained development phase.`,
    DECLINING:    `Declining activity — limited recent spuds. ${spud5yr} wells within 5 years, but fewer in the last 3 (${spud3yr}). Operators may be holding acreage, awaiting price recovery, or nearing full development.`,
    INACTIVE:     "Little to no recent drilling activity detected near this acreage. May be undiscovered, held-by-production only, or outside current development fairway.",
  };

  return {
    wells_spud_last_3yr:  spud3yr,
    wells_spud_last_5yr:  spud5yr,
    pct_wells_post_2020:  pctPost2020,
    trend,
    score,
    dominant_operator:    dominant,
    interpretation:       interpretations[trend],
  };
}

// ─── Valuation engine ─────────────────────────────────────────────────────────

function buildValuation(args: {
  offsetWells:   OffsetWellProfile[];
  typeCurve:     TypeCurveResult | null;
  formation:     FormationProfile | null;
  momentum:      DrillingMomentum;
  operators:     OperatorProfile[];
  acreage:       number | null;
  nri:           number | null;
  askPrice:      number | null;
}): AcreageValuation {
  const { offsetWells, typeCurve, formation, momentum, acreage, askPrice } = args;

  const OIL_PRICE       = 72;   // $/BBL reference deck
  const DISCOUNT_RATE   = 0.10; // 10% PV10
  const nriUsed         = args.nri ?? 0.125;  // default 12.5% (1/8 royalty)
  const acreageUsed     = acreage ?? 160;     // default 160 acres (quarter section)

  // ── EUR basis: offset type curve >> formation benchmark >> fallback ─────────
  const p50Eur = typeCurve?.p50_eur_bbl
    ?? formation?.benchmark_p50_eur_bbl
    ?? null;
  const p10Eur = typeCurve?.p10_eur_bbl
    ?? formation?.benchmark_p10_eur_bbl
    ?? null;
  const p90Eur = typeCurve?.p90_eur_bbl
    ?? formation?.benchmark_p90_eur_bbl
    ?? null;

  // ── Well count (spacing) ────────────────────────────────────────────────────
  const spacingAcres = formation?.benchmark_spacing_acres ?? 80;
  const potentialWellCount = Math.max(1, Math.round(acreageUsed / spacingAcres));

  // ── Drill probability ───────────────────────────────────────────────────────
  let drillProb = 40; // base
  if (momentum.score >= 70)       drillProb += 30;
  else if (momentum.score >= 45)  drillProb += 15;
  else if (momentum.score <= 15)  drillProb -= 20;

  const tier1Count = args.operators.filter(o => o.quality_tier === "TIER1").length;
  if (tier1Count >= 1) drillProb += 10;
  const tier3Only  = args.operators.length > 0 && args.operators.every(o => o.quality_tier === "TIER3");
  if (tier3Only)   drillProb -= 10;

  if (offsetWells.length >= 5) drillProb += 10;
  if (offsetWells.length === 0) drillProb -= 20;

  drillProb = Math.min(95, Math.max(5, drillProb));

  // ── Development timing ──────────────────────────────────────────────────────
  const timingLabel =
    drillProb >= 75 ? "High probability of development within 1–3 years" :
    drillProb >= 55 ? "Moderate probability of development within 3–5 years" :
    drillProb >= 35 ? "Speculative development timeline — 5+ years or contingent on prices" :
    "Unlikely to be developed in the near term without significant improvement in activity";

  // ── Production expectations (royalty owner share) ──────────────────────────
  // Assumes ~20% of EUR is produced in first 12 months (typical for Arps hyperbolic)
  const boePerMonthFromEur = (eur: number | null) =>
    eur != null ? Math.round((eur * nriUsed) / 84) : null; // rough: 7-year life ÷ 84 mo

  const royaltyP10 = boePerMonthFromEur(p10Eur);
  const royaltyP50 = boePerMonthFromEur(p50Eur);
  const royaltyP90 = boePerMonthFromEur(p90Eur);

  // ── PV10 calculation (simplified) ──────────────────────────────────────────
  // Monthly royalty cash flow = EUR × NRI × oil_price × (1 - production tax ~7%)
  // PV10 of perpetuity-like royalty = monthly cash flow × annuity factor
  // For decline curve: annuity factor ~ 50–70 months equivalent at 10% discount
  const PV_ANNUITY_FACTOR = 60; // conservative: equivalent to ~5 years of monthly cash

  function eurToPv10(eur: number | null): number | null {
    if (eur == null) return null;
    const annualGrossRev = eur * OIL_PRICE * 0.93; // net of 7% severance
    const annualNriRev   = annualGrossRev * nriUsed;
    // PV10 of infinite annuity that declines: approximate as PV_ANNUITY_FACTOR months of peak
    // Peak monthly ~ EUR × 0.03 (approx — reasonable for Arps type B≈1 hyperbolic)
    const peakMonthly    = eur * nriUsed * OIL_PRICE * 0.93 * 0.03;
    const pv10           = peakMonthly * PV_ANNUITY_FACTOR;
    return Math.round(pv10);
  }

  // For multi-well acreage, scale by well count and probability-weight
  const scale = (pv: number | null) =>
    pv != null ? Math.round(pv * potentialWellCount * (drillProb / 100)) : null;

  const pv10Low  = scale(eurToPv10(p90Eur));
  const pv10Mid  = scale(eurToPv10(p50Eur));
  const pv10High = scale(eurToPv10(p10Eur));

  // ── Per-acre value ($/NMA) ──────────────────────────────────────────────────
  const nmaOwned = acreageUsed * nriUsed * 8; // NRA → NMA (approximate: 1/8 royalty baseline)
  const pnmaLow  = pv10Low  != null && nmaOwned > 0 ? Math.round(pv10Low  / nmaOwned) : null;
  const pnmaMid  = pv10Mid  != null && nmaOwned > 0 ? Math.round(pv10Mid  / nmaOwned) : null;
  const pnmaHigh = pv10High != null && nmaOwned > 0 ? Math.round(pv10High / nmaOwned) : null;

  // ── Quality score ───────────────────────────────────────────────────────────
  let quality = 30;
  if (offsetWells.length >= 10) quality += 25;
  else if (offsetWells.length >= 5) quality += 15;
  else if (offsetWells.length >= 2) quality += 8;

  if (momentum.score >= 65) quality += 25;
  else if (momentum.score >= 40) quality += 12;

  if (typeCurve?.confidence === "HIGH") quality += 15;
  else if (typeCurve?.confidence === "MEDIUM") quality += 8;

  if (tier1Count >= 1) quality += 5;
  quality = Math.min(100, quality);

  // ── Confidence score ────────────────────────────────────────────────────────
  let confidence = 20;
  if (offsetWells.length > 0) confidence += 20;
  if (typeCurve != null) confidence += 15;
  if (typeCurve?.confidence === "HIGH") confidence += 15;
  else if (typeCurve?.confidence === "MEDIUM") confidence += 8;
  if (momentum.score > 0) confidence += 10;
  if (formation != null && formation.primary_formation !== "Unknown") confidence += 10;
  confidence = Math.min(95, confidence);

  // ── Recommendation ──────────────────────────────────────────────────────────
  let rec: AcreageValuation["recommendation"] = "REVIEW";
  let rationale = "";

  if (quality >= 70 && drillProb >= 60 && pv10Mid != null && pv10Mid > 0) {
    rec = "PURSUE";
    rationale = `Strong offset well performance (${offsetWells.length} wells, ${typeCurve?.p50_eur_bbl ? Math.round(typeCurve.p50_eur_bbl / 1000) + "K BBL P50 EUR" : "active production"}) combined with ${momentum.trend.toLowerCase()} drilling momentum supports a PURSUE recommendation. Estimated PV10 at $${pv10Mid != null ? (pv10Mid >= 1_000_000 ? `$${(pv10Mid/1_000_000).toFixed(2)}MM` : `$${Math.round(pv10Mid/1_000)}K`) : "—"} (probability-weighted).`;
  } else if (quality <= 35 || drillProb <= 25 || offsetWells.length === 0) {
    rec = "PASS";
    rationale = `Insufficient offset well activity (${offsetWells.length} wells), ${momentum.trend.toLowerCase()} drilling momentum, or poor acreage quality score (${quality}/100) indicates limited near-term development potential.`;
  } else {
    rationale = `Moderate offset activity (${offsetWells.length} wells nearby) with ${drillProb}% estimated drill probability. Directional value estimate is encouraging but data confidence is limited — additional due diligence recommended before committing capital.`;
  }

  return {
    drill_probability_pct:      drillProb,
    development_timing_label:   timingLabel,
    potential_well_count_p50:   potentialWellCount,
    spacing_assumption_acres:   spacingAcres,
    expected_royalty_boe_p10:   royaltyP10,
    expected_royalty_boe_p50:   royaltyP50,
    expected_royalty_boe_p90:   royaltyP90,
    pv10_low:   pv10Low,
    pv10_mid:   pv10Mid,
    pv10_high:  pv10High,
    value_per_nma_low:  pnmaLow,
    value_per_nma_mid:  pnmaMid,
    value_per_nma_high: pnmaHigh,
    total_value_low:    pv10Low,
    total_value_mid:    pv10Mid,
    total_value_high:   pv10High,
    acreage_quality_score:       quality,
    confidence_score:            confidence,
    recommendation:              rec,
    recommendation_rationale:    rationale,
    oil_price_deck:              OIL_PRICE,
    nri_used:                    nriUsed,
    discount_rate:               DISCOUNT_RATE,
  };
}

// ─── Narrative builder ────────────────────────────────────────────────────────

function buildActivitySummary(
  wells: OffsetWellProfile[],
  momentum: DrillingMomentum,
  operators: OperatorProfile[],
  formation: FormationProfile | null,
): string {
  if (wells.length === 0) {
    return "No offset well production data was located within the search radius. This may indicate an early-stage exploration area, data availability limitations, or acreage outside currently active development windows.";
  }

  const producing  = wells.filter(w => w.is_active).length;
  const closest    = wells.slice().sort((a, b) => a.distance_mi - b.distance_mi)[0];
  const topOp      = operators[0];
  const formNm     = formation?.primary_formation ?? "the target formation";
  const basinNm    = formation?.basin ?? "this basin";

  const lines: string[] = [];
  lines.push(
    `${wells.length} offset well${wells.length !== 1 ? "s" : ""} identified within the search radius, of which ${producing} appear${producing !== 1 ? "" : "s"} currently active. Nearest producing well is ${closest.distance_mi.toFixed(1)} miles to the ${closest.direction}.`
  );

  if (topOp) {
    lines.push(
      `${topOp.name} is the dominant operator with ${topOp.well_count} well${topOp.well_count !== 1 ? "s" : ""} nearby (${topOp.quality_tier === "TIER1" ? "Tier 1 — strong EUR profile" : topOp.quality_tier === "TIER2" ? "Tier 2 — moderate performance" : "Tier 3 — below-average production"}).`
    );
  }

  lines.push(momentum.interpretation);

  if (formation) {
    lines.push(
      `Primary target formation: ${formNm} in the ${basinNm}. ${formation.commentary}`
    );
  }

  return lines.join(" ");
}

function buildInvestmentNarrative(
  input: AcreageInput,
  location: AcreageLocation | null,
  wells: OffsetWellProfile[],
  typeCurve: TypeCurveResult | null,
  formation: FormationProfile | null,
  momentum: DrillingMomentum,
  valuation: AcreageValuation,
): string[] {
  const county = input.county ?? location?.description ?? "the subject area";
  const state  = input.state ?? "TX";
  const acr    = input.acreage ?? 160;
  const nri    = input.nri ?? 0.125;
  const formNm = formation?.primary_formation ?? "the target formation";
  const pMid   = typeCurve?.p50_eur_bbl
    ? `${Math.round(typeCurve.p50_eur_bbl / 1000)}K BBL P50`
    : formation?.benchmark_p50_eur_bbl
    ? `~${Math.round(formation.benchmark_p50_eur_bbl / 1000)}K BBL P50 (basin benchmark)`
    : "EUR data limited";

  const fmt$ = (v: number | null) => v != null
    ? (v >= 1_000_000 ? `$${(v/1_000_000).toFixed(2)}MM` : `$${Math.round(v/1_000)}K`)
    : "—";

  const para1 = `Subject acreage is located in ${county}, ${state}, encompassing approximately ${acr.toLocaleString()} gross acres (${(acr * nri).toFixed(1)} net mineral acres at ${(nri * 100).toFixed(3)}% NRI). The primary target formation is ${formNm}${formation ? ` within the ${formation.basin}` : ""}. ${formation?.commentary ?? "Formation data is limited — production expectations derived from offset wells."}`;

  const para2 = wells.length > 0
    ? `Offset well analysis identified ${wells.length} wells within the search radius. The type curve suggests ${pMid} per well with a P90/P10 range of ${typeCurve ? `${Math.round(typeCurve.p90_eur_bbl/1000)}K – ${Math.round(typeCurve.p10_eur_bbl/1000)}K BBL` : "—"} across ${typeCurve?.well_count ?? 0} DCA-qualified wells (confidence: ${typeCurve?.confidence ?? "LOW"}). Peak production rates suggest ${typeCurve?.p50_peak_bbl ? Math.round(typeCurve.p50_peak_bbl).toLocaleString() : "—"} BBL/month at P50.`
    : "No offset well production data was available to calibrate the type curve. EUR expectations are based on regional basin benchmarks only — treat all production estimates as highly directional.";

  const para3 = `Drilling momentum score is ${momentum.score}/100 (${momentum.trend}). ${momentum.interpretation} The estimated development probability is ${valuation.drill_probability_pct ?? 0}% — ${valuation.development_timing_label?.toLowerCase() ?? "timing unknown"}.`;

  const para4 = `Risk-adjusted PV10 estimate: ${fmt$(valuation.pv10_low)} – ${fmt$(valuation.pv10_high)} (mid: ${fmt$(valuation.pv10_mid)}), probability-weighted at ${valuation.drill_probability_pct ?? 0}% drill probability using a $${valuation.oil_price_deck}/BBL price deck and ${(valuation.discount_rate * 100).toFixed(0)}% discount rate. Acreage quality score: ${valuation.acreage_quality_score}/100. Data confidence: ${valuation.confidence_score}/100. Recommendation: ${valuation.recommendation}. PRELIMINARY — FOR DISCUSSION ONLY. Verify with petroleum engineer before making an offer.`;

  return [para1, para2, para3, para4];
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function runAcreageValuation(
  input: AcreageInput,
): Promise<AcreageValuationReport> {
  const t0 = Date.now();
  const reportId = `acr-${Date.now().toString(36)}`;

  // ── 1. Parse legal description ────────────────────────────────────────────
  const rawDesc = input.legal_description ?? "";
  const parsed  = parseLegalDescription(rawDesc);
  const { county: inferredCounty, state: inferredState } =
    inferCountyAndStateFromTexts(rawDesc, input.county, input.state);
  const inferredAcreage = extractAcreageFromTexts(rawDesc);

  const county = input.county ?? inferredCounty;
  const state  = input.state  ?? inferredState;
  const acreage = input.acreage ?? inferredAcreage;
  const nri    = input.nri ?? null;

  const hasAbstract = !!(parsed.abstract_number || parsed.survey_name);
  const hasPlss     = !!(parsed.plss_township && parsed.plss_range);
  let formatDetected: AcreageValuationReport["parsed"]["format_detected"] = "UNKNOWN";
  if (parsed.block && parsed.survey_name) formatDetected = "TX_BLOCK_SURVEY";
  else if (hasAbstract) formatDetected = "TX_ABSTRACT";
  else if (hasPlss)     formatDetected = "PLSS";
  else if (hasAbstract && hasPlss) formatDetected = "MIXED";

  const parseConf: AcreageValuationReport["parsed"]["parse_confidence"] =
    (hasAbstract || hasPlss) ? "HIGH" : county ? "MEDIUM" : "LOW";

  // ── 2. Geocode ────────────────────────────────────────────────────────────
  let location: AcreageLocation | null = null;
  let geocodingSource = "none";
  let trrcLookupAttempted = false;
  let plssLookupAttempted = false;

  const isTexas = /^texas$|^tx$/i.test(state?.trim() ?? "");

  if (isTexas && hasAbstract && county) {
    trrcLookupAttempted = true;
    const otls = await lookupWellsByLegalDescription({
      county,
      state,
      abstract_number: parsed.abstract_number,
      survey_name:     parsed.survey_name,
      block:           parsed.block,
      section:         parsed.section,
    }).catch(() => null);

    if (otls?.centroid) {
      location = {
        lat:         otls.centroid.lat,
        lng:         otls.centroid.lng,
        source:      "otls_polygon",
        confidence:  "HIGH",
        description: otls.description,
      };
      geocodingSource = "otls_polygon";
    }
  }

  if (!location && hasPlss) {
    plssLookupAttempted = true;
    const geo = await geocodeProperty({
      township: parsed.plss_township,
      range:    parsed.plss_range,
      section:  parsed.section,
      state,
    }).catch(() => null);

    if (geo) {
      location = {
        lat:         geo.lat,
        lng:         geo.lng,
        source:      geo.source as AcreageLocation["source"],
        confidence:  geo.source === "plss_blm" ? "HIGH" : "MEDIUM",
        description: `${parsed.plss_township}T, ${parsed.plss_range}R${parsed.section ? ` Sec ${parsed.section}` : ""}, ${county ?? state ?? ""}`,
      };
      geocodingSource = geo.source;
    }
  }

  // ── 3. Formation inference ────────────────────────────────────────────────
  const formation = inferFormationProfile(county, state, input.formation_hint ?? null);

  // ── 4. Fetch nearby wells ─────────────────────────────────────────────────
  let offsetWells: OffsetWellProfile[] = [];
  let wellsWithProduction = 0;
  const SEARCH_RADIUS_MI = 5;

  if (location) {
    const nearbyRaw = await fetchWellsNearPoint(
      location.lat, location.lng, SEARCH_RADIUS_MI,
    ).catch(() => [] as Array<{ api: string; lat: number; lng: number }>);

    // Sort by distance, take top 20
    const withDist = nearbyRaw
      .map(w => ({ ...w, dist: haversineDistanceMiles(location!.lat, location!.lng, w.lat, w.lng) }))
      .filter(w => w.dist <= SEARCH_RADIUS_MI)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 20);

    if (withDist.length > 0) {
      // Fetch production for each well
      const apis       = withDist.map(w => w.api);
      const prodMap    = await fetchOffsetProduction(apis, 15).catch(() => new Map<string, { year: number; month: number; oil_bbl: number }[]>());
      const leaseInfoMap = await lookupTrrcLeasesByApis(null, apis.slice(0, 15)).catch(() => new Map());

      for (const w of withDist) {
        const history = prodMap.get(w.api) ?? [];
        const leaseInfo = leaseInfoMap.get(w.api);
        const operator = leaseInfo?.operator ?? "Unknown Operator";

        if (history.length > 0) wellsWithProduction++;

        const profile = buildOffsetProfile(
          w.api,
          operator,
          w.lat,
          w.lng,
          location!.lat,
          location!.lng,
          history,
        );
        offsetWells.push(profile);
      }

      // Sort: closest first, then by EUR descending
      offsetWells.sort((a, b) =>
        a.distance_mi !== b.distance_mi
          ? a.distance_mi - b.distance_mi
          : (b.eur_bbl ?? 0) - (a.eur_bbl ?? 0),
      );
    }
  }

  // ── 5. Type curve ──────────────────────────────────────────────────────────
  const typeCurve = buildTypeCurve(offsetWells);

  // ── 6. Operator profiles ───────────────────────────────────────────────────
  const operators = buildOperatorProfiles(offsetWells);

  // ── 7. Drilling momentum ───────────────────────────────────────────────────
  const momentum = buildDrillingMomentum(offsetWells);

  // ── 8. Valuation ──────────────────────────────────────────────────────────
  const valuation = buildValuation({
    offsetWells,
    typeCurve,
    formation,
    momentum,
    operators,
    acreage:   acreage ?? null,
    nri:       nri ?? null,
    askPrice:  input.ask_price_usd ?? null,
  });

  // ── 9. Narrative ──────────────────────────────────────────────────────────
  const nearbyActivitySummary = buildActivitySummary(offsetWells, momentum, operators, formation);
  const investmentNarrative   = buildInvestmentNarrative(
    { ...input, county: county ?? undefined, state: state ?? undefined, acreage: acreage ?? undefined, nri: nri ?? undefined },
    location,
    offsetWells,
    typeCurve,
    formation,
    momentum,
    valuation,
  );

  // ── 10. Flags ─────────────────────────────────────────────────────────────
  const flags: AcreageValuationReport["flags"] = [];

  if (!location) {
    flags.push({ severity: "critical", category: "data", message: "Could not geocode the legal description — offset well search skipped. Provide township/range/section or Texas abstract number.", provenance: "INFERRED" });
  }
  if (offsetWells.length === 0 && location) {
    flags.push({ severity: "warning", category: "activity", message: "No producing offset wells found within 5 miles. Production estimates rely on regional basin benchmarks only.", provenance: "ESTIMATED" });
  }
  if (typeCurve?.confidence === "LOW") {
    flags.push({ severity: "warning", category: "data", message: `Type curve built from fewer than 3 DCA-qualified wells — EUR range is highly uncertain.`, provenance: "ESTIMATED" });
  }
  if (momentum.trend === "INACTIVE") {
    flags.push({ severity: "warning", category: "activity", message: "No recent drilling activity detected in this area. Development probability is low without operator commitment.", provenance: "INFERRED" });
  }
  if (!acreage) {
    flags.push({ severity: "info", category: "data", message: "Acreage not provided — defaulting to 160 acres for well count and valuation calculations.", provenance: "ESTIMATED" });
  }
  if (!nri) {
    flags.push({ severity: "info", category: "economics", message: "NRI not provided — defaulting to 12.5% (1/8 royalty) for royalty calculations.", provenance: "ESTIMATED" });
  }

  // ── 11. Provenance table ──────────────────────────────────────────────────
  const provenance: AcreageValuationReport["provenance"] = [
    { field: "Location / Geocode",     value: location?.description ?? "Not resolved",           label: location?.source === "otls_polygon" || location?.source === "plss_blm" ? "PUBLIC_RECORD" : "ESTIMATED",  source: geocodingSource },
    { field: "Formation Profile",      value: formation.primary_formation,                       label: "ESTIMATED",     source: "Basin benchmark — ESTIMATED, not engineering-certified" },
    { field: "EUR Benchmarks",         value: typeCurve ? `${typeCurve.well_count} offset wells` : "Basin benchmark only", label: typeCurve ? "PUBLIC_RECORD" : "ESTIMATED", source: typeCurve ? "TRRC public production records" : "Formation intelligence module" },
    { field: "Drill Probability",      value: `${valuation.drill_probability_pct ?? 0}%`,        label: "INFERRED",      source: "Drilling momentum + operator scoring" },
    { field: "Oil Price Deck",         value: `$${valuation.oil_price_deck}/BBL`,                label: "ESTIMATED",     source: "MineralFlow reference deck" },
    { field: "NRI Used",               value: `${(valuation.nri_used * 100).toFixed(3)}%`,       label: nri ? "VERIFIED" : "ESTIMATED", source: nri ? "User-provided" : "Default 1/8 royalty" },
    { field: "Acreage",                value: `${(acreage ?? 160).toLocaleString()} gross acres`, label: acreage ? "VERIFIED" : "ESTIMATED", source: acreage ? "User-provided or parsed from legal description" : "Default 160 acres assumed" },
    { field: "PV10 Estimate",          value: valuation.pv10_mid != null ? (valuation.pv10_mid >= 1_000_000 ? `$${(valuation.pv10_mid/1_000_000).toFixed(2)}MM` : `$${Math.round(valuation.pv10_mid/1_000)}K`) : "—", label: "ESTIMATED", source: "Simplified DCF model — not a reserve engineering study" },
  ];

  return {
    report_id:    reportId,
    generated_at: new Date().toISOString(),
    input:        { ...input, county: county ?? undefined, state: state ?? undefined, acreage: acreage ?? undefined, nri: nri ?? undefined },
    parsed: {
      abstract_number: parsed.abstract_number,
      survey_name:     parsed.survey_name,
      block:           parsed.block,
      section:         parsed.section,
      plss_township:   parsed.plss_township,
      plss_range:      parsed.plss_range,
      county:          county ?? null,
      state:           state  ?? null,
      acreage:         acreage ?? null,
      nri:             nri ?? null,
      format_detected: formatDetected,
      parse_confidence: parseConf,
    },
    location,
    formation,
    offset_wells:       offsetWells,
    type_curve:         typeCurve,
    operators,
    drilling_momentum:  momentum,
    nearby_activity_summary: nearbyActivitySummary,
    investment_narrative:    investmentNarrative,
    valuation,
    flags,
    provenance,
    _meta: {
      processing_time_ms:    Date.now() - t0,
      geocoding_source:      geocodingSource,
      offset_well_count:     offsetWells.length,
      wells_with_production: wellsWithProduction,
      formation_source:      formation.source,
      trrc_lookup_attempted: trrcLookupAttempted,
      plss_lookup_attempted: plssLookupAttempted,
    },
  };
}
