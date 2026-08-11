/**
 * Development activity analysis — permit counts/locations and derived
 * recency/concentration signals for the 1/3/5-mile rings.
 *
 * SCOPING NOTE (live-verified during this engine's build): TRRC's public
 * ArcGIS "Well Locations" layer (already queried by offsets.ts for every
 * offset well) classifies some locations as "Permitted Location" — that
 * gives real, live permit COUNTS and LOCATIONS by radius band at zero
 * extra cost. Per-permit filing date and targeted formation live in a
 * separate EWA form (drillingPermitsQueryAction.do, keyed by API), and a
 * live attempt to port that endpoint into the frontend during this
 * engine's build did not reproduce the worker's working session flow
 * (returned a TRRC "Application Error" rather than real data) — rather
 * than guess at an unverified request shape, this module reports real
 * counts/locations and honestly discloses that filed-date/recency-bucket
 * detail is not available per permit in V1, instead of fabricating dates.
 * "Recently completed wells" is derived from real completion data already
 * fetched in production.ts's enrichment (firstProductionMonth) — a
 * genuinely different, already-verified signal, not a permit substitute.
 */

import type { OffsetWellRecord, RadiusBandMiles, DevelopmentActivitySummary, PermitRecord, PermitRecencyBucket, WarningEntry } from "./types";

const RADIUS_BANDS: RadiusBandMiles[] = [1, 3, 5];

function monthsSince(dateStr: string): number | null {
  const d = new Date(`${dateStr}-01T00:00:00Z`);
  if (isNaN(d.getTime())) return null;
  const now = new Date();
  return (now.getUTCFullYear() - d.getUTCFullYear()) * 12 + (now.getUTCMonth() - d.getUTCMonth());
}

export function analyzeDevelopmentActivity(wells: OffsetWellRecord[]): DevelopmentActivitySummary {
  const warnings: WarningEntry[] = [];

  const permitted = wells.filter(w => w.classifiedStatus === "PERMITTED_NOT_DRILLED");
  const permits: PermitRecord[] = permitted.map(w => ({
    apiNumber: w.apiNumber,
    permitNumber: null,
    distanceMiles: w.distanceMiles,
    radiusBandMiles: w.radiusBandMiles,
    filedDate: null,
    monthsSinceFiled: null,
    recencyBucket: "UNKNOWN" as PermitRecencyBucket,
    targetFormation: w.canonicalFormation,
    operatorName: w.operatorName,
    wellStatusAtQuery: w.gisStatusSymbol,
    sourceUrlOrQueryId: null,
    retrievedAt: new Date().toISOString(),
  }));

  if (permits.length > 0) {
    warnings.push({
      code: "PERMIT_FILING_DATE_UNAVAILABLE",
      message: "Permit locations and counts are real and live (TRRC GIS Permitted Location status). Filed date and targeted formation per individual permit could not be retrieved in this run — recency buckets below are UNKNOWN rather than guessed.",
      severity: "info",
    });
  }

  const permitCountByRadius: Record<RadiusBandMiles, number> = { 1: 0, 3: 0, 5: 0 };
  for (const p of permits) {
    for (const band of RADIUS_BANDS) {
      if ((p.distanceMiles ?? Infinity) <= band) permitCountByRadius[band]++;
    }
  }

  const permitCountByRecency: Record<PermitRecencyBucket, number> = { LAST_6_MONTHS: 0, LAST_12_MONTHS: 0, LAST_24_MONTHS: 0, OLDER: 0, UNKNOWN: permits.length };

  // Operator concentration — from real, enriched offset wells (production.ts fills operatorName when a lease resolves successfully). Wells with no resolved operator are excluded from the denominator rather than counted as an "unknown operator" bucket that would understate real concentration.
  const withOperator = wells.filter(w => w.operatorName);
  const operatorCounts = new Map<string, number>();
  for (const w of withOperator) {
    operatorCounts.set(w.operatorName as string, (operatorCounts.get(w.operatorName as string) ?? 0) + 1);
  }
  const operatorConcentration = Array.from(operatorCounts.entries())
    .map(([operatorName, wellCount]) => ({ operatorName, wellCount, sharePct: withOperator.length > 0 ? Math.round((wellCount / withOperator.length) * 1000) / 10 : 0 }))
    .sort((a, b) => b.wellCount - a.wellCount);

  // Recently completed wells — real firstProductionMonth from production.ts's enrichment, not a permit-derived guess.
  let recentlyCompletedWellCount = 0;
  for (const w of wells) {
    if (!w.firstProductionMonth) continue;
    const m = monthsSince(w.firstProductionMonth);
    if (m !== null && m <= 24) recentlyCompletedWellCount++;
  }

  const areaSqMiles5mi = Math.PI * 5 * 5;
  const totalWellsWithin5mi = wells.filter(w => w.distanceMiles <= 5).length;
  const developmentDensityPerSqMile = totalWellsWithin5mi > 0 ? Math.round((totalWellsWithin5mi / areaSqMiles5mi) * 100) / 100 : null;

  const developmentRecencyNote = recentlyCompletedWellCount > 0
    ? `${recentlyCompletedWellCount} offset well(s) began production within the last 24 months — reflects EXISTING development, not a prediction of future drilling. ${permits.length} permitted-but-undrilled location(s) are a separate, distinct signal: a permit is not proof a well will be drilled.`
    : `No offset wells with a known completion date in the last 24 months. ${permits.length} permitted-but-undrilled location(s) exist but are not evidence of committed future development.`;

  return {
    permits,
    permitCountByRadius,
    permitCountByRecency,
    operatorConcentration,
    activeOperatorCount: operatorConcentration.length,
    recentlyCompletedWellCount,
    developmentDensityPerSqMile,
    developmentRecencyNote,
    warnings,
  };
}
