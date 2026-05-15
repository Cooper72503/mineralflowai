/**
 * Nearby Well Intelligence
 *
 * Takes a property location (lat/lng) + a county-level well dataset and
 * produces a radius-filtered, aggregate intelligence object used to:
 *  - Refine activity level (real drilling activity vs. static county tier)
 *  - Anchor production estimates to actual nearby well production
 *  - Surface a plain-English summary for the Quick Screen result card
 *
 * When no lat/lng is available (no PLSS in legal description), falls back
 * to county-level aggregates without distance filtering — still useful for
 * trend/activity signals, just without per-well distance labels.
 *
 * Confidence model:
 *  Location  — high: PLSS geocoded | low: county only | none: no location
 *  Production — high: ≥3 wells with BOPD within 1 mi | medium: wells in radius
 *               with production data | low: wells found but no production data
 *  Ownership — always "low" (NRI/deed data never available here)
 */

import type { WellLookupResult, WellSummary } from "./well-types";
import type { PropertyGeocodeResult } from "@/lib/location/property-geocode";

// ── Types ─────────────────────────────────────────────────────────────────────

export type NearbyWell = {
  api: string;
  well_name: string | null;
  operator: string | null;
  /** Miles from property centroid. null when no property geocode available. */
  distance_miles: number | null;
  status: string | null;
  /** Earliest production year derived from spud_date or latest_production_month. */
  first_prod_year: number | null;
  /** Latest monthly oil in BBL ÷ 30 — approximation of daily rate. */
  latest_bopd: number | null;
  latest_production_month: string | null;
  /** null for county-level synthetic wells that have no specific location. */
  lat: number | null;
  /** null for county-level synthetic wells that have no specific location. */
  lng: number | null;
};

export type NearbyWellIntelligence = {
  property_lat: number | null;
  property_lng: number | null;
  geocode_source: "plss_blm" | "plss_estimated" | "none";
  /** Miles radius used for filtering (when geocode available). */
  radius_miles: number;
  total_count: number;
  producing_count: number;
  /** Up to 10 nearest (or highest-BOPD when no geocode) wells. */
  wells: NearbyWell[];
  avg_bopd: number | null;
  median_bopd: number | null;
  /** Min BOPD among nearby producing wells. */
  min_bopd: number | null;
  /** Max BOPD among nearby producing wells. */
  max_bopd: number | null;
  newest_prod_year: number | null;
  oldest_prod_year: number | null;
  /** Distance to nearest well found (miles). null when no geocode or no wells. */
  nearest_well_miles: number | null;
  /** When 0 wells in radius: distance to nearest well found outside the search area. */
  nearest_outside_miles: number | null;
  /** BOPD of that nearest outside-radius well (if available). */
  nearest_outside_bopd: number | null;
  /** Unique operator names (up to 3) among nearby wells. */
  operators: string[];
  /** Derived from actual nearby well count — overrides static county tier. */
  inferred_activity_level: "high" | "moderate" | "low" | "none";
  /** Human-readable one-line summary for the UI card. */
  summary: string;
  confidence: {
    location: "high" | "low";
    production: "high" | "medium" | "low";
    ownership: "low";
  };
  /** Which state data source was queried (e.g. "ndic", "trrc"). */
  data_source: string | null;
  /** True when the county well lookup hit a transfer limit. */
  data_truncated: boolean;
  /** When well data is unavailable for this state. */
  unavailable_note: string | null;
};

// ── Haversine distance ────────────────────────────────────────────────────────

/** Returns distance in miles between two lat/lng points. */
export function haversineDistanceMiles(
  lat1: number, lng1: number,
  lat2: number, lng2: number,
): number {
  const R = 3958.8; // Earth radius in miles
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toBopdFromMonthly(monthly: number | null): number | null {
  if (monthly == null || monthly <= 0) return null;
  return Math.round((monthly / 30) * 10) / 10;
}

function firstProdYear(well: WellSummary): number | null {
  if (well.spud_date) {
    const y = parseInt(well.spud_date.slice(0, 4));
    if (y > 1900 && y <= new Date().getFullYear()) return y;
  }
  if (well.latest_production_month) {
    const y = parseInt(well.latest_production_month.slice(0, 4));
    if (y > 1900) return y;
  }
  return null;
}

function isProducingStatus(status: string | null): boolean {
  if (!status) return false;
  const s = status.toLowerCase();
  return s.includes("produc") || s.includes("active") || s === "pa" ||
    s.includes("permit") === false && (s === "active" || s === "producing");
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function inferActivityLevel(producingCount: number, totalCount: number): NearbyWellIntelligence["inferred_activity_level"] {
  if (producingCount >= 5) return "high";
  if (producingCount >= 2) return "moderate";
  if (totalCount >= 1) return "low";
  return "none";
}

function buildSummary(args: {
  total: number;
  producing: number;
  avgBopd: number | null;
  medianBopd: number | null;
  minBopd: number | null;
  maxBopd: number | null;
  oldestYear: number | null;
  newestYear: number | null;
  nearestMiles: number | null;
  nearestOutsideMiles: number | null;
  nearestOutsideBopd: number | null;
  radiusMiles: number;
  hasGeocode: boolean;
  unavailableNote: string | null;
}): string {
  if (args.unavailableNote) return args.unavailableNote;

  // No wells in search area
  if (args.total === 0) {
    if (!args.hasGeocode) return "No wells found in county well registry.";
    if (args.nearestOutsideMiles != null) {
      const nearBopd = args.nearestOutsideBopd != null
        ? ` (${args.nearestOutsideBopd} BOPD)`
        : "";
      return `No wells within ${args.radiusMiles}-mile search radius. Nearest detected activity: ${args.nearestOutsideMiles.toFixed(1)} mi${nearBopd} — low nearby production potential.`;
    }
    return `No wells found within ${args.radiusMiles}-mile search radius — insufficient data for nearby production estimate.`;
  }

  const locationStr = args.hasGeocode ? `within ${args.radiusMiles} miles` : "in county";
  const closestStr = args.nearestMiles != null ? ` (closest: ${args.nearestMiles.toFixed(1)} mi)` : "";

  // Build interpretation sentence based on evidence
  if (args.producing === 0) {
    return `${args.total} well${args.total !== 1 ? "s" : ""} located ${locationStr}${closestStr} — none currently producing. Suggests limited active development in this area.`;
  }

  const bopdStr = args.medianBopd != null
    ? `median ${args.medianBopd} BOPD`
    : args.avgBopd != null
    ? `avg ${args.avgBopd} BOPD`
    : null;

  const bopdRangeStr = (args.minBopd != null && args.maxBopd != null && args.minBopd !== args.maxBopd)
    ? ` (range ${args.minBopd}–${args.maxBopd})`
    : "";

  const yearStr = args.oldestYear != null
    ? `, active since ${args.oldestYear}`
    : "";

  const interpretation = (() => {
    if (args.producing >= 5 && bopdStr) return "Strong nearby production activity suggests good development potential.";
    if (args.producing >= 2 && bopdStr) return "Moderate nearby production activity; tract may be within an active development zone.";
    if (args.producing >= 1 && bopdStr) return "Limited nearby production — some activity detected; development potential present but not confirmed.";
    if (args.total >= 3) return "Multiple wells located nearby but production rates are limited or declining.";
    return "Low nearby well count; production potential is speculative based on available data.";
  })();

  const productionPart = bopdStr ? `, ${bopdStr}${bopdRangeStr}` : "";
  return `${args.producing} producing well${args.producing !== 1 ? "s" : ""} ${locationStr}${closestStr}${productionPart}${yearStr}. ${interpretation}`;
}

// ── Main function ─────────────────────────────────────────────────────────────

export function buildNearbyWellIntelligence(args: {
  geocode: PropertyGeocodeResult | null;
  wellLookupResult: WellLookupResult;
  /** Miles radius to use when a property geocode is available. */
  radiusMiles?: number;
}): NearbyWellIntelligence {
  const radiusMiles = args.radiusMiles ?? 3;
  const { geocode, wellLookupResult } = args;
  const allWells = wellLookupResult.wells;

  // Unavailable state
  if (wellLookupResult.source === "unavailable" || allWells.length === 0) {
    return {
      property_lat: geocode?.lat ?? null,
      property_lng: geocode?.lng ?? null,
      geocode_source: geocode?.source === "county_centroid" ? "none" : (geocode?.source ?? "none"),
      radius_miles: radiusMiles,
      total_count: 0,
      producing_count: 0,
      wells: [],
      avg_bopd: null,
      median_bopd: null,
      min_bopd: null,
      max_bopd: null,
      newest_prod_year: null,
      oldest_prod_year: null,
      nearest_well_miles: null,
      nearest_outside_miles: null,
      nearest_outside_bopd: null,
      operators: [],
      inferred_activity_level: "none",
      summary: wellLookupResult.note ?? `No well data available for this location.`,
      confidence: { location: geocode ? "high" : "low", production: "low", ownership: "low" },
      data_source: null,
      data_truncated: false,
      unavailable_note: wellLookupResult.note ?? null,
    };
  }

  // County centroid has low accuracy — treat as no geocode for distance filtering
  const effectiveGeocode = geocode?.source === "county_centroid" ? null : geocode;

  // Filter by radius if geocode available; otherwise use all county wells
  const wellsWithCoords = allWells.filter(w => w.lat != null && w.lng != null);
  let candidates: Array<WellSummary & { distance_miles: number | null }>;

  let nearestOutsideMiles: number | null = null;
  let nearestOutsideBopd: number | null = null;

  if (effectiveGeocode) {
    // Compute distance for all wells with coords, filter to radius
    const withDist = wellsWithCoords.map(w => ({
      ...w,
      distance_miles: haversineDistanceMiles(effectiveGeocode.lat, effectiveGeocode.lng, w.lat!, w.lng!),
    })).sort((a, b) => a.distance_miles - b.distance_miles);

    let inRadius = withDist.filter(w => w.distance_miles <= radiusMiles);

    // Expand radius if fewer than 3 wells found (up to 10 miles)
    if (inRadius.length < 3 && radiusMiles < 10) {
      inRadius = withDist.filter(w => w.distance_miles <= 10);
    }

    // When still empty, record nearest well outside the expanded search area
    if (inRadius.length === 0 && withDist.length > 0) {
      const nearest = withDist[0];
      nearestOutsideMiles = Math.round(nearest.distance_miles * 10) / 10;
      nearestOutsideBopd = toBopdFromMonthly(nearest.latest_monthly_oil_bbl);
    }

    candidates = inRadius;
  } else {
    // No geocode — use ALL county wells (including coord-less synthetic estimates),
    // sorted by BOPD descending so best data comes first.
    candidates = allWells.map(w => ({ ...w, distance_miles: null }))
      .sort((a, b) => (b.latest_monthly_oil_bbl ?? 0) - (a.latest_monthly_oil_bbl ?? 0));
  }

  // Compute NearbyWell objects
  const nearbyWells: NearbyWell[] = candidates.slice(0, 10).map(w => ({
    api: w.api,
    well_name: w.well_name,
    operator: w.operator,
    distance_miles: w.distance_miles != null
      ? Math.round(w.distance_miles * 10) / 10
      : null,
    status: w.status,
    first_prod_year: firstProdYear(w),
    latest_bopd: toBopdFromMonthly(w.latest_monthly_oil_bbl),
    latest_production_month: w.latest_production_month,
    lat: w.lat ?? null,
    lng: w.lng ?? null,
  }));

  // Aggregates
  const producingCount = candidates.filter(w =>
    isProducingStatus(w.status) || (w.latest_monthly_oil_bbl ?? 0) > 0
  ).length;

  const bopdValues = candidates
    .map(w => toBopdFromMonthly(w.latest_monthly_oil_bbl))
    .filter((v): v is number => v != null && v > 0);

  const avgBopd = bopdValues.length > 0
    ? Math.round((bopdValues.reduce((s, v) => s + v, 0) / bopdValues.length) * 10) / 10
    : null;
  const medianBopd = bopdValues.length > 0
    ? (() => { const m = median(bopdValues); return m != null ? Math.round(m * 10) / 10 : null; })()
    : null;
  const minBopd = bopdValues.length > 0 ? Math.round(Math.min(...bopdValues) * 10) / 10 : null;
  const maxBopd = bopdValues.length > 0 ? Math.round(Math.max(...bopdValues) * 10) / 10 : null;

  const prodYears = candidates.map(firstProdYear).filter((y): y is number => y != null);
  const oldestYear = prodYears.length > 0 ? Math.min(...prodYears) : null;
  const newestYear = prodYears.length > 0 ? Math.max(...prodYears) : null;

  // Nearest well distance (first candidate when sorted by distance, or null when no geocode)
  const nearestWellMiles = candidates.length > 0 && candidates[0].distance_miles != null
    ? Math.round(candidates[0].distance_miles * 10) / 10
    : null;

  // Unique operators (up to 3)
  const operatorsSeen = new Set<string>();
  const operators: string[] = [];
  for (const w of candidates) {
    if (w.operator && w.operator.length > 0 && !operatorsSeen.has(w.operator)) {
      operatorsSeen.add(w.operator);
      operators.push(w.operator);
      if (operators.length >= 3) break;
    }
  }

  const activity = inferActivityLevel(producingCount, candidates.length);

  // Production confidence
  let productionConf: "high" | "medium" | "low";
  const closeWellsWithBopd = effectiveGeocode
    ? candidates.filter(w => (w.distance_miles ?? Infinity) <= 1 && (w.latest_monthly_oil_bbl ?? 0) > 0).length
    : 0;
  if (closeWellsWithBopd >= 3 || (bopdValues.length >= 5)) productionConf = "high";
  else if (bopdValues.length >= 2) productionConf = "medium";
  else productionConf = "low";

  const summary = buildSummary({
    total: candidates.length,
    producing: producingCount,
    avgBopd,
    medianBopd,
    minBopd,
    maxBopd,
    oldestYear,
    newestYear,
    nearestMiles: nearestWellMiles,
    nearestOutsideMiles,
    nearestOutsideBopd,
    radiusMiles: effectiveGeocode ? radiusMiles : 0,
    hasGeocode: effectiveGeocode != null,
    unavailableNote: null,
  });

  return {
    property_lat: geocode?.lat ?? null,
    property_lng: geocode?.lng ?? null,
    geocode_source: geocode?.source === "county_centroid" ? "none" : (geocode?.source ?? "none"),
    radius_miles: radiusMiles,
    total_count: candidates.length,
    producing_count: producingCount,
    wells: nearbyWells,
    avg_bopd: avgBopd,
    median_bopd: medianBopd,
    min_bopd: minBopd,
    max_bopd: maxBopd,
    newest_prod_year: newestYear,
    oldest_prod_year: oldestYear,
    nearest_well_miles: nearestWellMiles,
    nearest_outside_miles: nearestOutsideMiles,
    nearest_outside_bopd: nearestOutsideBopd,
    operators,
    inferred_activity_level: activity,
    summary,
    confidence: {
      location: effectiveGeocode ? "high" : "low",
      production: productionConf,
      ownership: "low",
    },
    data_source: (wellLookupResult.source as string) === "unavailable" ? null : wellLookupResult.source,
    data_truncated: wellLookupResult.exceeded_transfer_limit ?? false,
    unavailable_note: null,
  };
}
