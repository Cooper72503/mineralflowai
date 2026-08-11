/**
 * Offset well search for the Geological Due Diligence Engine — 1/3/5-mile
 * rings around a specific subject well (not a legal-description tract, the
 * offset-analytics engine's use case). Reuses the same real building blocks:
 * ArcGisWellSearchProvider (well-search.ts, TRRC's own ArcGIS geodesic
 * radius query) and classifyWellStatus (candidate-filtering.ts). One live
 * query at the largest radius (5mi), then every well is bucketed into the
 * smallest ring it actually qualifies for by its real computed distance —
 * not three separate round trips.
 *
 * Horizontal-well detection requires a per-well lateral-path lookup
 * (lateral-path.ts, TRRC ArcGIS layer 9 — no orientation field exists on
 * the well-locations layer itself). That's a real per-well round trip, so
 * it's capped at MAX_LATERAL_LOOKUPS nearest wells, exactly like
 * offset-analytics/service.ts caps production enrichment — wells beyond the
 * cap are still counted in the totals, just not individually checked for
 * horizontal orientation, and that's disclosed via a warning, not hidden.
 */

import { ArcGisWellSearchProvider } from "../offset-analytics/well-search";
import { classifyWellStatus } from "../offset-analytics/candidate-filtering";
import { haversineDistanceMiles } from "../offset-analytics/geometry";
import { fetchLateralPath } from "../lateral-path";
import type { OffsetWellRecord, OffsetSearchResult, RadiusBandMiles, WarningEntry } from "./types";

const RADIUS_BANDS: RadiusBandMiles[] = [1, 3, 5];
const MAX_LATERAL_LOOKUPS = 40;

function smallestBand(distanceMiles: number): RadiusBandMiles | null {
  for (const band of RADIUS_BANDS) {
    if (distanceMiles <= band) return band;
  }
  return null; // beyond 5mi — shouldn't happen given the search radius, but never force a bucket that isn't real
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}
function bearingCompass(lat1: number, lng1: number, lat2: number, lng2: number): string {
  const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  const y = Math.sin(toRad(lng2 - lng1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lng2 - lng1));
  const deg = (Math.atan2(y, x) * 180) / Math.PI;
  return COMPASS[Math.round(((deg + 360) % 360) / 22.5) % 16];
}

export async function findOffsetWells(
  center: { lat: number; lng: number },
  subjectApiNumber: string,
  provider: { search: InstanceType<typeof ArcGisWellSearchProvider>["search"] } = new ArcGisWellSearchProvider(),
): Promise<OffsetSearchResult> {
  const warnings: WarningEntry[] = [];
  const retrievedAt = new Date().toISOString();

  const result = await provider.search(center, null, 5, "CENTROID_TO_WELL");
  warnings.push(...result.warnings);

  const subjectDigits = subjectApiNumber.replace(/\D/g, "");
  const candidates = result.candidates.filter(c => c.api.replace(/\D/g, "") !== subjectDigits);

  const wells: OffsetWellRecord[] = [];
  for (const c of candidates) {
    const band = smallestBand(c.distanceMiles);
    if (band === null) continue; // beyond the requested 5mi — the server pre-filter can occasionally overreach slightly
    wells.push({
      apiNumber: c.api,
      wellNumber: c.wellNumber || null,
      latitude: c.latitude,
      longitude: c.longitude,
      distanceMiles: c.distanceMiles,
      bearing: bearingCompass(center.lat, center.lng, c.latitude, c.longitude),
      radiusBandMiles: band,
      gisStatusSymbol: c.gisStatusSymbol,
      classifiedStatus: classifyWellStatus(c.gisStatusSymbol),
      operatorName: null,       // the well-locations layer doesn't carry operator — see offset-wells.ts's own note; enrichment (activity.ts/production stats) fills this for the comparable subset
      fieldName: null,
      canonicalFormation: null,
      formationMatch: null,
      lateralLengthFt: null,
      completionYear: null,
      firstProductionMonth: null,
      sixMonthOilBbl: null,
      twelveMonthOilBbl: null,
      cumulativeOilBbl: null,
      cumulativeGasMcf: null,
      cumulativeWaterBbl: null,
      monthsOfHistory: null,
      comparableGroupId: null,
    });
  }
  wells.sort((a, b) => a.distanceMiles - b.distanceMiles);

  // Horizontal detection — capped, real per-well lookups, nearest first.
  const toCheck = wells.slice(0, MAX_LATERAL_LOOKUPS);
  if (wells.length > MAX_LATERAL_LOOKUPS) {
    warnings.push({
      code: "HORIZONTAL_CHECK_CAPPED",
      message: `${wells.length} offset wells found within 5mi; only the nearest ${MAX_LATERAL_LOOKUPS} were checked for horizontal orientation (each check is a live per-well TRRC query). Horizontal counts below reflect the checked subset only.`,
      severity: "info",
    });
  }
  const horizontalApis = new Set<string>();
  await Promise.all(toCheck.map(async w => {
    const path = await fetchLateralPath(w.apiNumber, w.latitude, w.longitude).catch(() => null);
    if (path) {
      horizontalApis.add(w.apiNumber);
      w.lateralLengthFt = Math.round(path.straight_line_length_ft);
    }
  }));

  const countByRadius: Record<RadiusBandMiles, number> = { 1: 0, 3: 0, 5: 0 };
  const horizontalCountByRadius: Record<RadiusBandMiles, number> = { 1: 0, 3: 0, 5: 0 };
  for (const w of wells) {
    for (const band of RADIUS_BANDS) {
      if (w.distanceMiles <= band) {
        countByRadius[band]++;
        if (horizontalApis.has(w.apiNumber)) horizontalCountByRadius[band]++;
      }
    }
  }

  return {
    wells,
    countByRadius,
    horizontalCountByRadius,
    warnings,
    sourceUrlOrQueryId: result.sourceUrlOrQueryId,
    retrievedAt,
  };
}
