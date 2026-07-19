/**
 * Peer Benchmarking Engine
 *
 * Finds offset wells near the subject well and builds a formation-level
 * type curve (P10/P50/P90 EUR, IP) to:
 *   1. Score where the subject well sits in the peer EUR/IP distribution
 *   2. Provide formation production benchmarks for the report
 *   3. Flag under/over-performers relative to peers
 *
 * Texas-only (TRRC ArcGIS + TRRC production). Returns null for non-TX wells
 * or when fewer than 3 peers have enough data for DCA.
 *
 * Run server-side only.
 */

import { lookupTrrcLeasesByApis }    from "@/lib/wells/trrc-api";
import { fetchTrrcProductionByLease } from "@/lib/wells/trrc-production";
import { runDca }                     from "./decline-curve";
import type { BasinBenchmark }        from "./benchmarks";

// ── Types ─────────────────────────────────────────────────────────────────────

export type PeerWellProfile = {
  api:             string;
  distance_mi:     number;
  direction:       string;
  lat:             number;
  lng:             number;
  cum_oil_bbl:     number;
  peak_month_bbl:  number;
  eur_bbl:         number | null;
  decline_annual_pct: number | null;
  months_of_data:  number;
  is_active:       boolean;
  first_prod_year: number | null;
};

export type PeerTypeCurve = {
  well_count:             number;
  p10_eur_bbl:            number;
  p50_eur_bbl:            number;
  p90_eur_bbl:            number;
  p10_peak_bbl:           number;
  p50_peak_bbl:           number;
  p90_peak_bbl:           number;
  avg_decline_annual_pct: number | null;
  confidence:             "high" | "medium" | "low";
  wells_used:             string[];
  data_quality_note:      string | null;
};

export type PeerBenchmarkResult = {
  subject_api:                string;
  subject_lat:                number | null;
  subject_lng:                number | null;
  subject_ip_bbl:             number | null;
  subject_eur_bbl:            number | null;
  subject_ip_percentile:      number | null;
  subject_eur_percentile:     number | null;
  outperforms_peers:          boolean | null;
  radius_miles:               number;
  peer_count:                 number;
  peers_with_dca:             number;
  type_curve:                 PeerTypeCurve | null;
  peer_wells:                 PeerWellProfile[];
  basin_benchmark_p50_eur:    number | null;
  data_quality:               "high" | "medium" | "low" | "insufficient";
  note:                       string | null;
};

// ── ArcGIS spatial query ──────────────────────────────────────────────────────

const STATEWIDE_WELLS_URL =
  "https://services.arcgis.com/KTcxiTD9dsQw4r7Z/arcgis/rest/services/Statewide_Surface_Wells_Aug2019/FeatureServer/0/query";

async function fetchWellLatLng(
  apiNumber: string,
): Promise<{ lat: number; lng: number } | null> {
  const api8 = apiNumber.replace(/\D/g, "").replace(/^42/, "").slice(0, 8);
  if (api8.length !== 8) return null;

  try {
    const params = new URLSearchParams({
      where:              `API = '${api8}'`,
      outFields:          "API,LAT83,LONG83",
      returnGeometry:     "false",
      resultRecordCount:  "1",
      f:                  "json",
    });
    const res  = await fetch(`${STATEWIDE_WELLS_URL}?${params}`);
    if (!res.ok) return null;
    const json = await res.json() as { features?: Array<{ attributes: { LAT83: number | null; LONG83: number | null } }> };
    const feat = json.features?.[0];
    if (!feat || feat.attributes.LAT83 == null || feat.attributes.LONG83 == null) return null;
    return { lat: feat.attributes.LAT83, lng: feat.attributes.LONG83 };
  } catch {
    return null;
  }
}

async function fetchWellsNearPoint(
  lat: number,
  lng: number,
  radiusMiles: number,
): Promise<Array<{ api: string; lat: number; lng: number }>> {
  const degLat = radiusMiles / 69;
  const degLng = radiusMiles / (Math.cos((lat * Math.PI) / 180) * 69.1);

  try {
    const params = new URLSearchParams({
      where: `LAT83 BETWEEN ${lat - degLat - 0.005} AND ${lat + degLat + 0.005} AND LONG83 BETWEEN ${lng - degLng - 0.005} AND ${lng + degLng + 0.005}`,
      outFields:          "API,LAT83,LONG83",
      returnGeometry:     "false",
      resultRecordCount:  "200",
      f:                  "json",
    });
    const res  = await fetch(`${STATEWIDE_WELLS_URL}?${params}`);
    if (!res.ok) return [];
    const json = await res.json() as { features?: Array<{ attributes: { API: string; LAT83: number | null; LONG83: number | null } }> };

    return (json.features ?? [])
      .filter(f => f.attributes.LAT83 != null && f.attributes.LONG83 != null)
      .map(f => {
        const raw  = String(f.attributes.API ?? "").replace(/\D/g, "");
        const full = raw.length === 8 ? `42${raw}` : raw.length === 10 ? raw : null;
        return full
          ? { api: full, lat: f.attributes.LAT83!, lng: f.attributes.LONG83! }
          : null;
      })
      .filter((x): x is { api: string; lat: number; lng: number } => x !== null);
  } catch {
    return [];
  }
}

// ── Geometry helpers ──────────────────────────────────────────────────────────

function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3958.8;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function compass(fromLat: number, fromLng: number, toLat: number, toLng: number): string {
  const dLat = toLat - fromLat;
  const dLng = toLng - fromLng;
  const angle = (Math.atan2(dLng, dLat) * 180) / Math.PI;
  const sectors = ["N","NE","E","SE","S","SW","W","NW"];
  return sectors[Math.round(((angle + 360) % 360) / 45) % 8];
}

// ── Statistical helpers ───────────────────────────────────────────────────────

function percentileValue(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo  = Math.floor(idx);
  const hi  = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Returns the percentile rank (0–100) of a value within a sorted array.
 * Higher = better (more production = higher percentile).
 */
function rankPercentile(sorted: number[], value: number): number {
  if (sorted.length === 0) return 50;
  const below = sorted.filter(v => v < value).length;
  return Math.round((below / sorted.length) * 100);
}

// ── Main engine ───────────────────────────────────────────────────────────────

export async function buildPeerBenchmark(args: {
  subjectApi:       string;
  subjectMonthly:   { year: number; month: number; oil_bbl: number }[];
  /** Optional — computed from DCA internally if not supplied */
  subjectEurBbl?:   number | null;
  benchmark:        BasinBenchmark | null;
  signal?:          AbortSignal;
}): Promise<PeerBenchmarkResult> {
  const { subjectApi, subjectMonthly, benchmark, signal } = args;

  // Only valid for Texas (API prefix 42)
  const apiDigits = subjectApi.replace(/\D/g, "");
  if (!apiDigits.startsWith("42")) {
    return nullResult(subjectApi, "Peer benchmarking is currently supported for Texas wells only (TRRC data).");
  }

  // Subject well peak and EUR — run DCA internally if not pre-supplied
  const subjectSorted = [...subjectMonthly].sort((a, b) =>
    a.year !== b.year ? a.year - b.year : a.month - b.month,
  );
  const subjectIpBbl = subjectSorted.length > 0
    ? Math.max(...subjectSorted.map(r => r.oil_bbl))
    : null;
  const subjectDca   = subjectSorted.length >= 3 ? runDca(subjectSorted) : null;
  const subjectEurBbl = args.subjectEurBbl ?? subjectDca?.eur_bbl ?? null;

  // Step 1: resolve subject well location
  const location = await fetchWellLatLng(subjectApi).catch(() => null);
  if (!location) {
    return nullResult(subjectApi, "Subject well location not found in TRRC spatial registry — peer analysis requires a geocoded well.");
  }
  if (signal?.aborted) return nullResult(subjectApi, "Peer benchmark aborted.", location.lat, location.lng);

  // Step 2: find offset wells within 5 miles
  const RADIUS = 5;
  const nearbyRaw = await fetchWellsNearPoint(location.lat, location.lng, RADIUS).catch(() => []);
  if (signal?.aborted) return nullResult(subjectApi, "Peer benchmark aborted.", location.lat, location.lng);

  // Filter: exclude subject well itself; add distance
  const subjectApi8 = apiDigits.slice(2, 10);
  const candidates = nearbyRaw
    .filter(w => {
      const a8 = w.api.replace(/\D/g, "").replace(/^42/, "").slice(0, 8);
      return a8 !== subjectApi8;
    })
    .map(w => ({
      ...w,
      dist: haversine(location.lat, location.lng, w.lat, w.lng),
      dir:  compass(location.lat, location.lng, w.lat, w.lng),
    }))
    .filter(w => w.dist <= RADIUS)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 20);

  if (candidates.length === 0) {
    return {
      subject_api:    subjectApi,
      subject_lat:    location.lat,
      subject_lng:    location.lng,
      subject_ip_bbl: subjectIpBbl,
      subject_eur_bbl: subjectEurBbl,
      subject_ip_percentile: null,
      subject_eur_percentile: null,
      outperforms_peers: null,
      radius_miles: RADIUS,
      peer_count: 0,
      peers_with_dca: 0,
      type_curve: null,
      peer_wells: [],
      basin_benchmark_p50_eur: null,
      data_quality: "insufficient",
      note: `No offset wells found within ${RADIUS}-mile radius — formation type curve unavailable.`,
    };
  }

  // Step 3: resolve TRRC leases for offset wells (batch)
  const offsetApis = candidates.map(c => c.api);
  const leaseMap = await lookupTrrcLeasesByApis(null, offsetApis).catch(() =>
    new Map<string, { distCode: string; leaseNo: string; operator: string }>(),
  );
  if (signal?.aborted) return nullResult(subjectApi, "Peer benchmark aborted.");

  // Step 4: fetch production for resolved leases (parallel, max 15)
  const leasedWells = Array.from(leaseMap.entries()).slice(0, 15);

  const peerProfiles: PeerWellProfile[] = [];

  await Promise.allSettled(
    leasedWells.map(async ([api, { distCode, leaseNo }]) => {
      const candidate = candidates.find(c => {
        const a8 = c.api.replace(/\D/g, "").replace(/^42/, "").slice(0, 8);
        const b8 = api.replace(/\D/g, "").replace(/^42/, "").slice(0, 8);
        return a8 === b8;
      });
      if (!candidate) return;

      try {
        const prod = await fetchTrrcProductionByLease(distCode, leaseNo);
        if (!prod || prod.rows.length < 3) return;

        const sorted = [...prod.rows].sort((a, b) =>
          a.year !== b.year ? a.year - b.year : a.month - b.month,
        );
        const oilRows = sorted.filter(r => r.oil_bbl > 0);
        if (oilRows.length < 3) return;

        const cumOil    = oilRows.reduce((s, r) => s + r.oil_bbl, 0);
        const peakMonth = Math.max(...oilRows.map(r => r.oil_bbl));
        const dca       = runDca(oilRows);

        const firstYear = sorted.find(r => r.oil_bbl > 0)?.year ?? null;
        const lastYear  = sorted[sorted.length - 1].year;
        const isActive  = (new Date().getFullYear() - lastYear) <= 2;

        peerProfiles.push({
          api:              candidate.api,
          distance_mi:      Math.round(candidate.dist * 10) / 10,
          direction:        candidate.dir,
          lat:              candidate.lat,
          lng:              candidate.lng,
          cum_oil_bbl:      cumOil,
          peak_month_bbl:   peakMonth,
          eur_bbl:          dca?.eur_bbl ?? null,
          decline_annual_pct: dca ? Math.round(dca.decline_rate_annual_pct * 10) / 10 : null,
          months_of_data:   oilRows.length,
          is_active:        isActive,
          first_prod_year:  firstYear,
        });
      } catch {
        // skip failed fetches — peer data is supplementary
      }
    }),
  );

  // Sort peers by distance
  peerProfiles.sort((a, b) => a.distance_mi - b.distance_mi);

  // Step 5: build type curve from peers with DCA
  const peersWithEur  = peerProfiles.filter(p => p.eur_bbl != null);
  const peersWithPeak = peerProfiles.filter(p => p.peak_month_bbl > 0);

  let typeCurve: PeerTypeCurve | null = null;

  if (peersWithEur.length >= 3) {
    const eursSorted  = [...peersWithEur.map(p => p.eur_bbl!)].sort((a, b) => a - b);
    const peaksSorted = [...peersWithPeak.map(p => p.peak_month_bbl)].sort((a, b) => a - b);

    const avgDecline = peersWithEur.reduce((s, p) => s + (p.decline_annual_pct ?? 0), 0) / peersWithEur.length;

    const confidence = peersWithEur.length >= 10 ? "high"
      : peersWithEur.length >= 5 ? "medium"
      : "low";

    const qualityNote = peersWithEur.length < 5
      ? `Type curve based on ${peersWithEur.length} wells — expand data set for higher confidence.`
      : null;

    typeCurve = {
      well_count:             peersWithEur.length,
      p10_eur_bbl:            Math.round(percentileValue(eursSorted, 90)),
      p50_eur_bbl:            Math.round(percentileValue(eursSorted, 50)),
      p90_eur_bbl:            Math.round(percentileValue(eursSorted, 10)),
      p10_peak_bbl:           peaksSorted.length >= 3 ? Math.round(percentileValue(peaksSorted, 90)) : Math.round(peaksSorted[peaksSorted.length - 1] ?? 0),
      p50_peak_bbl:           peaksSorted.length >= 3 ? Math.round(percentileValue(peaksSorted, 50)) : Math.round(peaksSorted[Math.floor(peaksSorted.length / 2)] ?? 0),
      p90_peak_bbl:           peaksSorted.length >= 3 ? Math.round(percentileValue(peaksSorted, 10)) : Math.round(peaksSorted[0] ?? 0),
      avg_decline_annual_pct: Math.round(avgDecline * 10) / 10,
      confidence,
      wells_used:             peersWithEur.map(p => p.api),
      data_quality_note:      qualityNote,
    };
  }

  // Step 6: compute subject well percentile rankings
  let subjectIpPercentile: number | null = null;
  let subjectEurPercentile: number | null = null;
  let outperforms: boolean | null = null;

  if (subjectIpBbl != null && peersWithPeak.length >= 3) {
    const peaksSorted = peersWithPeak.map(p => p.peak_month_bbl).sort((a, b) => a - b);
    subjectIpPercentile = rankPercentile(peaksSorted, subjectIpBbl);
  }

  if (subjectEurBbl != null && peersWithEur.length >= 3) {
    const eursSorted = peersWithEur.map(p => p.eur_bbl!).sort((a, b) => a - b);
    subjectEurPercentile = rankPercentile(eursSorted, subjectEurBbl);
    outperforms = subjectEurPercentile >= 50;
  }

  // Step 7: data quality
  const dataQuality = peersWithEur.length >= 10 ? "high"
    : peersWithEur.length >= 5  ? "medium"
    : peersWithEur.length >= 3  ? "low"
    : "insufficient";

  const note = dataQuality === "insufficient"
    ? `Only ${peersWithEur.length} offset wells had sufficient data for DCA — type curve unavailable.`
    : null;

  return {
    subject_api:             subjectApi,
    subject_lat:             location.lat,
    subject_lng:             location.lng,
    subject_ip_bbl:          subjectIpBbl,
    subject_eur_bbl:         subjectEurBbl,
    subject_ip_percentile:   subjectIpPercentile,
    subject_eur_percentile:  subjectEurPercentile,
    outperforms_peers:       outperforms,
    radius_miles:            RADIUS,
    peer_count:              candidates.length,
    peers_with_dca:          peersWithEur.length,
    type_curve:              typeCurve,
    peer_wells:              peerProfiles,
    basin_benchmark_p50_eur: benchmark?.typical_decline_rate_monthly
      ? null  // benchmark.ts has decline rate, not EUR — leave EUR null, use type curve
      : null,
    data_quality:            dataQuality,
    note,
  };
}

function nullResult(api: string, note: string, lat?: number, lng?: number): PeerBenchmarkResult {
  return {
    subject_api:            api,
    subject_lat:            lat ?? null,
    subject_lng:            lng ?? null,
    subject_ip_bbl:         null,
    subject_eur_bbl:        null,
    subject_ip_percentile:  null,
    subject_eur_percentile: null,
    outperforms_peers:      null,
    radius_miles:           5,
    peer_count:             0,
    peers_with_dca:         0,
    type_curve:             null,
    peer_wells:             [],
    basin_benchmark_p50_eur: null,
    data_quality:           "insufficient",
    note,
  };
}
