/**
 * Interpretation engine — converts structured findings (offset search,
 * production stats, development activity, formation context) into
 * transaction-specific due-diligence findings. Deliberately 100%
 * deterministic rule-based logic, no LLM call anywhere in this file: every
 * classification, every supporting/contradicting/risk/gap statement, and
 * the diligence-implication text are built from real computed numbers by
 * plain code, not generated prose that could drift from what was actually
 * found. If a narrative layer is ever added on top of this, its only job
 * would be restating these already-computed findings in nicer prose — it
 * must never be given the raw data and asked to draw its own conclusion.
 *
 * Every inferred statement in this file explicitly says what observed/
 * calculated facts it rests on, and every finding carries evidenceIds so
 * the report/UI can show the reader exactly what's behind it.
 */

import type {
  OffsetSearchResult, ProductionDistributionStats, DevelopmentActivitySummary, FormationDepthContext,
  GeologicalFinding, EvidenceEntry, RadiusBandMiles,
} from "./types";
import { recordEvidence, recordCalculatedEvidence } from "./evidence";

export interface InterpretationInputs {
  offsets: OffsetSearchResult;
  productionStats: ProductionDistributionStats[];
  activity: DevelopmentActivitySummary;
  formationContext: FormationDepthContext;
}

export interface InterpretationResult {
  supportingFactors: GeologicalFinding[];
  contradictingFactors: GeologicalFinding[];
  risks: GeologicalFinding[];
  dataGaps: GeologicalFinding[];
  diligenceImplication: string;
  evidence: EvidenceEntry[];
}

const RADIUS_BANDS: RadiusBandMiles[] = [1, 3, 5];

// ProductionDistributionStats carries only a groupId, not the formation/
// lateral-band/vintage-band fields themselves (those live on ComparableGroup
// in production.ts). Since production.ts constructs every groupId as
// `${canonicalFormation}|${lateralLengthBand}|${completionVintageBand}`,
// parsing it back out here avoids widening this function's inputs just to
// carry three strings that are already encoded in the id.
function parseGroupId(groupId: string): { formation: string; lateralBand: string; vintageBand: string } {
  const [formation, lateralBand, vintageBand] = groupId.split("|");
  return { formation: formation ?? "unknown formation", lateralBand: lateralBand ?? "unknown lateral length", vintageBand: vintageBand ?? "unknown vintage" };
}

export function interpretGeologicalEvidence(inputs: InterpretationInputs): InterpretationResult {
  const { offsets, productionStats, activity, formationContext } = inputs;
  const evidence: EvidenceEntry[] = [];
  const supportingFactors: GeologicalFinding[] = [];
  const contradictingFactors: GeologicalFinding[] = [];
  const risks: GeologicalFinding[] = [];
  const dataGaps: GeologicalFinding[] = [];

  const pushEvidence = (e: EvidenceEntry) => { evidence.push(e); return e.id; };

  // ── OBSERVED FACT: offset well counts ────────────────────────────────────
  const count3mi = offsets.countByRadius[3];
  const horizontal3mi = offsets.horizontalCountByRadius[3];
  const countEvidenceId = pushEvidence(recordEvidence({
    fieldName: "offset_well_count_3mi", classification: "observed",
    source: "TRRC GIS Well Locations (ArcGIS)", sourceUrlOrDocId: offsets.sourceUrlOrQueryId,
    retrievedAt: offsets.retrievedAt, rawValue: String(count3mi), normalizedValue: String(count3mi),
  }));

  const producingCount3mi = offsets.wells.filter(w => w.distanceMiles <= 3 && (w.classifiedStatus === "PRODUCING" || w.classifiedStatus === "RECENTLY_ACTIVE")).length;
  const plugged3mi = offsets.wells.filter(w => w.distanceMiles <= 3 && w.classifiedStatus === "PLUGGED").length;
  const dryHole3mi = offsets.wells.filter(w => w.distanceMiles <= 3 && w.classifiedStatus === "DRY_HOLE").length;

  if (count3mi >= 5 && producingCount3mi >= 3) {
    supportingFactors.push({
      category: "supporting", classification: "observed",
      title: "Established offset development within 3 miles",
      description: `${count3mi} offset well(s) found within 3 miles, including ${horizontal3mi} horizontal well(s) and ${producingCount3mi} currently producing or recently active — a real, spatially confirmed development footprint, not an isolated well.`,
      evidenceIds: [countEvidenceId],
    });
  } else if (count3mi === 0) {
    dataGaps.push({
      category: "gap", classification: "observed",
      title: "No offset wells found within 3 miles",
      description: "No wells were found in TRRC's public GIS database within a 3-mile radius. This may reflect genuinely undeveloped acreage, sparse public GIS coverage in the area, or a subject location outside an active play — the search itself does not distinguish between those.",
      evidenceIds: [countEvidenceId],
    });
  } else {
    dataGaps.push({
      category: "gap", classification: "observed",
      title: "Limited offset well count within 3 miles",
      description: `Only ${count3mi} offset well(s) found within 3 miles (${producingCount3mi} producing/active) — too few to characterize development density with confidence.`,
      evidenceIds: [countEvidenceId],
    });
  }

  if (plugged3mi > 0 || dryHole3mi > 0) {
    const statusEvidenceId = pushEvidence(recordEvidence({
      fieldName: "plugged_or_dry_offset_count_3mi", classification: "observed",
      source: "TRRC GIS Well Locations (ArcGIS)", sourceUrlOrDocId: offsets.sourceUrlOrQueryId,
      retrievedAt: offsets.retrievedAt, rawValue: `plugged=${plugged3mi},dry=${dryHole3mi}`, normalizedValue: `${plugged3mi + dryHole3mi}`,
    }));
    const severity = (plugged3mi + dryHole3mi) >= producingCount3mi ? "risk" : "contradicting";
    (severity === "risk" ? risks : contradictingFactors).push({
      category: severity, classification: "observed",
      title: "Plugged or dry-hole wells present nearby",
      description: `${plugged3mi} plugged and ${dryHole3mi} dry-hole/abandoned well(s) within 3 miles${(plugged3mi + dryHole3mi) >= producingCount3mi ? " — at or exceeding the number of currently producing offsets, a real signal worth investigating before relying on nearby success alone" : ""}.`,
      evidenceIds: [statusEvidenceId],
    });
  }

  // ── CALCULATED RESULT: production distribution per comparable group ─────
  const validGroups = productionStats.filter(g => g.validComparison);
  const invalidGroups = productionStats.filter(g => !g.validComparison);

  for (const g of validGroups) {
    const { formation, lateralBand, vintageBand } = parseGroupId(g.groupId);
    const evId = pushEvidence(recordCalculatedEvidence({
      fieldName: `median_12mo_oil_bbl_${g.groupId}`, source: "TRRC EWA production (lease-level)",
      rawValue: JSON.stringify({ wellCount: g.wellCount }), normalizedValue: String(g.medianTwelveMonthOilBbl),
      transformationMethod: `Median of 12-month trailing oil production across ${g.wellCount} comparable wells (same formation, similar lateral length and completion vintage).`,
    }));
    supportingFactors.push({
      category: "supporting", classification: "calculated",
      title: "Consistent offset production in a comparable well group",
      description: `Among ${g.wellCount} comparable offset wells (${formation}, ${lateralBand} laterals, ${vintageBand} vintage), median 12-month oil production is ${g.medianTwelveMonthOilBbl?.toLocaleString()} BBL (average ${g.averageTwelveMonthOilBbl?.toLocaleString()} BBL; distance-weighted ${g.distanceWeightedTwelveMonthOilBbl?.toLocaleString() ?? "n/a"} BBL). Best performer: API ${g.bestPerformerApi} at ${g.bestPerformerTwelveMonthOilBbl?.toLocaleString()} BBL; lowest: API ${g.lowestPerformerApi} at ${g.lowestPerformerTwelveMonthOilBbl?.toLocaleString()} BBL.`,
      evidenceIds: [evId],
    });
  }

  for (const g of invalidGroups) {
    const { formation, lateralBand, vintageBand } = parseGroupId(g.groupId);
    dataGaps.push({
      category: "gap", classification: "calculated",
      title: "Insufficient comparable wells for a statistically meaningful production read",
      description: `${g.invalidComparisonReason ?? "Group too small for a valid comparison."} (formation: ${formation}, ${lateralBand}, ${vintageBand})`,
      evidenceIds: [],
    });
  }

  if (productionStats.length === 0) {
    dataGaps.push({
      category: "gap", classification: "observed",
      title: "No comparable-well production data available",
      description: "No offset wells shared both a matched formation and enough production history to form a comparable group. Any development-quality read below is based on well counts and status alone, not on production performance.",
      evidenceIds: [],
    });
  }

  // ── OBSERVED FACT / INFERRED: development activity ───────────────────────
  const permitCount3mi = activity.permitCountByRadius[3];
  if (permitCount3mi > 0) {
    const evId = pushEvidence(recordEvidence({
      fieldName: "permit_count_3mi", classification: "observed",
      source: "TRRC GIS Well Locations (Permitted Location status)", retrievedAt: new Date().toISOString(),
      rawValue: String(permitCount3mi), normalizedValue: String(permitCount3mi),
    }));
    supportingFactors.push({
      category: "supporting", classification: "observed",
      title: "Active permitting nearby",
      description: `${permitCount3mi} permitted-but-undrilled location(s) within 3 miles. A permit reflects an operator's stated intent, not a commitment — it is not proof a well will actually be drilled.`,
      evidenceIds: [evId],
    });
  }

  if (activity.recentlyCompletedWellCount > 0) {
    const evId = pushEvidence(recordEvidence({
      fieldName: "recently_completed_well_count", classification: "observed",
      source: "TRRC EWA wellbore/production records", retrievedAt: new Date().toISOString(),
      rawValue: String(activity.recentlyCompletedWellCount), normalizedValue: String(activity.recentlyCompletedWellCount),
    }));
    supportingFactors.push({
      category: "supporting", classification: "observed",
      title: "Recent drilling activity in the area",
      description: `${activity.recentlyCompletedWellCount} offset well(s) began production within the last 24 months — this is existing, completed development, a stronger signal than a permit alone.`,
      evidenceIds: [evId],
    });
  }

  if (activity.activeOperatorCount >= 2) {
    supportingFactors.push({
      category: "supporting", classification: "observed",
      title: "Multiple active operators",
      description: `${activity.activeOperatorCount} distinct operator(s) identified among offset wells — development interest is not concentrated in a single company's activity alone.`,
      evidenceIds: [],
    });
  }

  // ── Formation context gap (always present in V1 — see formations.ts) ────
  dataGaps.push({
    category: "gap", classification: "observed",
    title: "Formation tops and structural depth not available",
    description: formationContext.dataGapNote,
    evidenceIds: [],
  });
  if (formationContext.subjectTvdssFt === null) {
    dataGaps.push({
      category: "gap", classification: "observed",
      title: "TVDSS not calculated",
      description: "TVDSS requires both a reported TVD and a reference elevation for this well; at least one was not available, so TVDSS was not calculated rather than estimated.",
      evidenceIds: [],
    });
  }

  // ── INFERRED CONCLUSION: diligence implication ───────────────────────────
  const hasValidComparableProduction = validGroups.length > 0;
  const hasEstablishedOffsetDevelopment = count3mi >= 5 && producingCount3mi >= 3;
  const hasMaterialRisk = risks.length > 0;

  let diligenceImplication: string;
  if (hasEstablishedOffsetDevelopment && hasValidComparableProduction && !hasMaterialRisk) {
    diligenceImplication = `Established same-zone offset development (${producingCount3mi} producing/active wells within 3 miles) with a statistically meaningful comparable production set supports commercial viability of the target interval in this area. This does not confirm the subject acreage itself will perform similarly — reservoir quality across the specific subject tract has not been independently measured, and nearby success does not guarantee subject performance.`;
  } else if (hasEstablishedOffsetDevelopment && !hasValidComparableProduction) {
    diligenceImplication = `Offset wells are present nearby, but formation or completion-vintage mismatches prevented a statistically meaningful production comparison. The area appears developed, but this assessment cannot say with confidence what production level is typical for a well matching the subject's likely formation and design — that gap should be closed with a targeted comparable-well pull before relying on offset performance in an offer.`;
  } else if (hasMaterialRisk) {
    diligenceImplication = `Plugged or dry-hole wells within the immediate offset radius are a material consideration — at or above the count of currently producing wells nearby. This does not necessarily mean the subject acreage is unproductive, but it means nearby drilling results have been mixed, and any offer should not assume uniform success across the area.`;
  } else {
    diligenceImplication = `Available public offset data is too sparse (${count3mi} well(s) within 3 miles) to support a confident read on development character in this area. This is a genuine data gap, not a negative finding — it means the geological evidence available through public records alone is insufficient to characterize this acreage, and additional diligence (subsurface data, a wider search radius, or direct operator inquiry) would be needed before drawing a conclusion.`;
  }

  return { supportingFactors, contradictingFactors, risks, dataGaps, diligenceImplication, evidence };
}
