/**
 * Offset production enrichment, comparable-well grouping, and distribution
 * statistics. Reuses production-loader.ts (resolveWellboreToLease,
 * fetchAnalogProduction — the same TRRC EWA session-based fetchers already
 * proven live for the offset-analytics engine) and
 * formation-normalization.ts (normalizeFormation, matchFormations) rather
 * than re-implementing either.
 *
 * The spec is explicit: "Do not automatically compare unlike formations."
 * Comparable groups are keyed on canonical formation + a lateral-length
 * band + a completion-vintage band — never just distance. A group with too
 * few members, or members that only share distance and nothing else, is
 * marked validComparison=false with a stated reason rather than silently
 * producing a median from an apples-to-oranges set.
 */

import { resolveWellboreToLease, fetchAnalogProduction } from "../offset-analytics/production-loader";
import { normalizeFormation, matchFormations } from "../offset-analytics/formation-normalization";
import type { OffsetWellRecord, ComparableGroup, ProductionDistributionStats, WarningEntry } from "./types";

const MAX_PRODUCTION_ENRICHMENT = 40;
const MIN_GROUP_SIZE_FOR_VALID_COMPARISON = 3;

function lateralBand(ft: number | null): string {
  if (ft === null) return "UNKNOWN";
  if (ft < 5000) return "<5000ft";
  if (ft < 7500) return "5000-7500ft";
  if (ft < 10000) return "7500-10000ft";
  return "10000ft+";
}

function vintageBand(year: number | null): string {
  if (year === null) return "UNKNOWN";
  const bandStart = Math.floor(year / 3) * 3;
  return `${bandStart}-${bandStart + 2}`;
}

export interface EnrichOffsetsResult {
  wells: OffsetWellRecord[];
  warnings: WarningEntry[];
}

/** Enriches the nearest MAX_PRODUCTION_ENRICHMENT offset wells with real lease/production/formation data. Wells beyond the cap keep whatever offsets.ts already gave them (location, status, distance) but no production numbers — never fabricated, just absent, and disclosed via a warning. */
export async function enrichOffsetProduction(wells: OffsetWellRecord[], subjectFieldName: string | null): Promise<EnrichOffsetsResult> {
  const warnings: WarningEntry[] = [];
  const subjectFormation = normalizeFormation(subjectFieldName ?? "");

  const eligible = wells.filter(w => w.classifiedStatus === "PRODUCING" || w.classifiedStatus === "RECENTLY_ACTIVE");
  const toEnrich = eligible.slice(0, MAX_PRODUCTION_ENRICHMENT);
  if (eligible.length > MAX_PRODUCTION_ENRICHMENT) {
    warnings.push({
      code: "PRODUCTION_ENRICHMENT_CAPPED",
      message: `${eligible.length} producing/active offset wells found; only the nearest ${MAX_PRODUCTION_ENRICHMENT} were enriched with real production data (each is a live multi-request TRRC lookup).`,
      severity: "info",
    });
  }

  await Promise.all(toEnrich.map(async w => {
    const lease = await resolveWellboreToLease(w.apiNumber).catch(() => null);
    if (!lease) return;
    w.fieldName = lease.fieldName;
    w.operatorName = lease.operatorName;
    if (lease.fieldName) {
      const candidateFormation = normalizeFormation(lease.fieldName);
      w.canonicalFormation = candidateFormation.canonicalFormation;
      w.formationMatch = matchFormations(subjectFormation, candidateFormation).accepted;
    }
    const production = await fetchAnalogProduction(lease.leaseNumber, lease.district).catch(() => null);
    if (!production || !production.found || production.rows.length === 0) return;

    const sorted = [...production.rows].sort((a, b) => a.productionMonth.localeCompare(b.productionMonth));
    w.monthsOfHistory = sorted.length;
    w.firstProductionMonth = sorted[0]?.productionMonth ?? null;
    const last = sorted[sorted.length - 1];
    w.completionYear = w.firstProductionMonth ? Number(w.firstProductionMonth.slice(0, 4)) : null;

    const oilRows = sorted.filter(r => r.oilBbl !== null);
    if (oilRows.length > 0) {
      w.cumulativeOilBbl = Math.round(oilRows.reduce((s, r) => s + (r.oilBbl ?? 0), 0));
      w.sixMonthOilBbl = Math.round(oilRows.slice(-6).reduce((s, r) => s + (r.oilBbl ?? 0), 0));
      w.twelveMonthOilBbl = Math.round(oilRows.slice(-12).reduce((s, r) => s + (r.oilBbl ?? 0), 0));
    }
    const gasRows = sorted.filter(r => r.gasMcf !== null);
    if (gasRows.length > 0) w.cumulativeGasMcf = Math.round(gasRows.reduce((s, r) => s + (r.gasMcf ?? 0), 0));
    void last;
  }));

  return { wells, warnings };
}

/** Groups enriched wells into comparable-well buckets (formation + lateral-length band + completion-vintage band). Wells with an unmatched or unknown formation are never grouped with the subject's formation — they simply don't get a comparableGroupId. */
export function buildComparableGroups(wells: OffsetWellRecord[]): ComparableGroup[] {
  const groups = new Map<string, ComparableGroup>();
  for (const w of wells) {
    if (!w.canonicalFormation || w.formationMatch !== true) continue;
    const groupId = `${w.canonicalFormation}|${lateralBand(w.lateralLengthFt)}|${vintageBand(w.completionYear)}`;
    w.comparableGroupId = groupId;
    const existing = groups.get(groupId);
    if (existing) {
      existing.memberApis.push(w.apiNumber);
    } else {
      groups.set(groupId, {
        groupId,
        canonicalFormation: w.canonicalFormation,
        lateralLengthBand: lateralBand(w.lateralLengthFt),
        completionVintageBand: vintageBand(w.completionYear),
        memberApis: [w.apiNumber],
      });
    }
  }
  return Array.from(groups.values());
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Distribution stats per comparable group — median/average/best/worst/distance-weighted 12-month oil production. A group below MIN_GROUP_SIZE_FOR_VALID_COMPARISON is still summarized (never hidden) but flagged validComparison=false so the interpretation layer doesn't treat a 1-2 well "median" as a real distribution. */
export function computeProductionDistribution(wells: OffsetWellRecord[], groups: ComparableGroup[]): ProductionDistributionStats[] {
  return groups.map(g => {
    const members = wells.filter(w => w.comparableGroupId === g.groupId && w.twelveMonthOilBbl !== null);
    if (members.length === 0) {
      return {
        groupId: g.groupId, wellCount: 0, medianTwelveMonthOilBbl: null, averageTwelveMonthOilBbl: null,
        bestPerformerApi: null, bestPerformerTwelveMonthOilBbl: null, lowestPerformerApi: null, lowestPerformerTwelveMonthOilBbl: null,
        distanceWeightedTwelveMonthOilBbl: null, validComparison: false,
        invalidComparisonReason: "No group members had complete 12-month production data.",
      };
    }

    const values = members.map(m => m.twelveMonthOilBbl as number);
    const best = members.reduce((a, b) => ((a.twelveMonthOilBbl ?? 0) >= (b.twelveMonthOilBbl ?? 0) ? a : b));
    const worst = members.reduce((a, b) => ((a.twelveMonthOilBbl ?? 0) <= (b.twelveMonthOilBbl ?? 0) ? a : b));
    const totalInverseDistance = members.reduce((s, m) => s + 1 / Math.max(0.1, m.distanceMiles), 0);
    const distanceWeighted = totalInverseDistance > 0
      ? members.reduce((s, m) => s + (m.twelveMonthOilBbl ?? 0) * (1 / Math.max(0.1, m.distanceMiles)), 0) / totalInverseDistance
      : null;

    return {
      groupId: g.groupId,
      wellCount: members.length,
      medianTwelveMonthOilBbl: median(values),
      averageTwelveMonthOilBbl: Math.round(values.reduce((s, v) => s + v, 0) / values.length),
      bestPerformerApi: best.apiNumber,
      bestPerformerTwelveMonthOilBbl: best.twelveMonthOilBbl,
      lowestPerformerApi: worst.apiNumber,
      lowestPerformerTwelveMonthOilBbl: worst.twelveMonthOilBbl,
      distanceWeightedTwelveMonthOilBbl: distanceWeighted !== null ? Math.round(distanceWeighted) : null,
      validComparison: members.length >= MIN_GROUP_SIZE_FOR_VALID_COMPARISON,
      invalidComparisonReason: members.length < MIN_GROUP_SIZE_FOR_VALID_COMPARISON
        ? `Only ${members.length} comparable well(s) with complete data in this group — fewer than the ${MIN_GROUP_SIZE_FOR_VALID_COMPARISON} needed for a statistically meaningful distribution.`
        : null,
    };
  });
}
