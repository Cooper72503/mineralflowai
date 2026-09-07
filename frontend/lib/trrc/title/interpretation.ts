/**
 * Interpretation engine — converts timeline.ts's raw findings and
 * asset-matching.ts's tract groupings into supporting/contradicting/risk/gap
 * findings. Deliberately 100% deterministic rule-based logic, no LLM call
 * anywhere in this file — same discipline as geology/interpretation.ts.
 *
 * Every finding carries evidenceIds. No finding in Phase 1 asserts who owns
 * a tract today, and no finding type here claims a confirmed defect —
 * everything is named and worded as "potential"/"possible", matching
 * title_findings.finding_type's soft vocabulary.
 */

import type { EnrichedClaim, CanonicalTract, TractTimeline, TitleFinding, TitleEvidenceEntry, TitleTimelineGap, TitleFindingType } from "./types";
import { recordEvidence, recordCalculatedEvidence } from "./evidence";

export interface InterpretationInputs {
  tracts: CanonicalTract[];
  timeline: TractTimeline[];
  enrichedByTract: Record<string, EnrichedClaim[]>;
}

export interface InterpretationResult {
  supportingFactors: TitleFinding[];
  contradictingFactors: TitleFinding[];
  risks: TitleFinding[];
  dataGaps: TitleFinding[];
  diligenceImplication: string;
  evidence: TitleEvidenceEntry[];
}

const GAP_TYPE_CATEGORY: Record<TitleFindingType, TitleFinding["category"]> = {
  POTENTIAL_CHAIN_DISCONTINUITY: "gap",
  POSSIBLE_DUPLICATE_INSTRUMENT: "gap",
  POTENTIAL_ACREAGE_VARIANCE: "contradicting",
  POTENTIAL_DESCRIPTION_VARIANCE: "contradicting",
};

export function interpretTitleEvidence(inputs: InterpretationInputs): InterpretationResult {
  const { tracts, timeline, enrichedByTract } = inputs;
  const evidence: TitleEvidenceEntry[] = [];
  const supportingFactors: TitleFinding[] = [];
  const contradictingFactors: TitleFinding[] = [];
  const risks: TitleFinding[] = [];
  const dataGaps: TitleFinding[] = [];

  const totalClaims = Object.values(enrichedByTract).reduce((sum, arr) => sum + arr.length, 0);
  const claimCountEv = recordEvidence({ fieldName: "instrument_claim_count", classification: "observed", source: "title_claims", rawValue: String(totalClaims), normalizedValue: String(totalClaims) });
  evidence.push(claimCountEv);

  if (totalClaims === 0) {
    dataGaps.push({
      category: "gap", classification: "observed", findingType: null,
      title: "No ownership instruments found",
      description: "No county-clerk index results and no bulk-imported records were available for this run's tract — there is nothing to build a timeline from.",
      evidenceIds: [claimCountEv.id],
    });
    return { supportingFactors, contradictingFactors, risks, dataGaps, diligenceImplication: "No title evidence is available for this asset — a manual title search is required before any ownership conclusion can be drawn.", evidence };
  }

  for (const tractTimeline of timeline) {
    const tract = tracts.find(t => t.id === tractTimeline.canonicalTractId);
    const tractLabel = tract?.legalDescription || [tract?.county, tract?.abstractNumber, tract?.surveyName].filter(Boolean).join(" / ") || "an unidentified tract";
    const claims = enrichedByTract[tractTimeline.canonicalTractId] ?? [];

    const tractEv = recordEvidence({
      fieldName: `tract_instrument_count:${tractTimeline.canonicalTractId}`,
      classification: "observed", source: "title_claims",
      rawValue: String(claims.length), normalizedValue: tractLabel,
    });
    evidence.push(tractEv);

    if (tractTimeline.gaps.length === 0 && claims.length >= 2) {
      supportingFactors.push({
        category: "supporting", classification: "observed", findingType: null,
        title: `No surface-level discontinuities detected for ${tractLabel}`,
        description: `${claims.length} instrument(s) were found for this tract. No potential chain discontinuities, possible duplicates, or acreage/description variances were detected among them. This does not confirm the chain is complete or correct — only that no automated surface-level check flagged an issue in the available data.`,
        evidenceIds: [tractEv.id],
      });
    }

    for (const gap of tractTimeline.gaps) {
      const gapEv = recordCalculatedEvidence({
        fieldName: `title_finding:${gap.type}:${tractTimeline.canonicalTractId}`,
        source: "timeline.ts",
        transformationMethod: `Deterministic ${gap.type} check over instruments grouped by canonical tract, sorted by instrument/recorded date`,
        rawValue: gap.claimIds.join(","),
        normalizedValue: gap.description,
      });
      evidence.push(gapEv);

      const finding: TitleFinding = {
        category: GAP_TYPE_CATEGORY[gap.type],
        classification: "inferred",
        findingType: gap.type,
        title: findingTypeTitle(gap.type),
        description: `${tractLabel}: ${gap.description}`,
        evidenceIds: [gapEv.id],
      };
      if (finding.category === "contradicting") contradictingFactors.push(finding);
      else dataGaps.push(finding);
    }

    const unverified = claims.filter(c => !c.instrument.instrumentContentVerified);
    if (unverified.length > 0) {
      dataGaps.push({
        category: "gap", classification: "observed", findingType: null,
        title: `Index-level evidence only for ${tractLabel}`,
        description: `${unverified.length} of ${claims.length} instrument(s) for this tract come from a county-clerk INDEX entry, not the underlying document text — an index proves a record exists, not the legal effect of the instrument. Interest fractions, reservations, exceptions, and depth limits (if any) have not been verified against the actual instrument.`,
        evidenceIds: [tractEv.id],
      });
    }
  }

  const totalGaps = timeline.reduce((sum, t) => sum + t.gaps.length, 0);
  const diligenceImplication = buildDiligenceImplication(tracts.length, totalGaps, contradictingFactors.length);

  return { supportingFactors, contradictingFactors, risks, dataGaps, diligenceImplication, evidence };
}

function findingTypeTitle(type: TitleFindingType): string {
  switch (type) {
    case "POTENTIAL_CHAIN_DISCONTINUITY": return "Potential chain discontinuity";
    case "POSSIBLE_DUPLICATE_INSTRUMENT": return "Possible duplicate instrument";
    case "POTENTIAL_ACREAGE_VARIANCE": return "Potential acreage variance";
    case "POTENTIAL_DESCRIPTION_VARIANCE": return "Potential description variance";
  }
}

function buildDiligenceImplication(tractCount: number, totalGaps: number, varianceCount: number): string {
  if (tractCount === 0) return "No title evidence is available for this asset — a manual title search is required before any ownership conclusion can be drawn.";
  if (varianceCount > 0) return `${varianceCount} potential variance(s) were found across ${tractCount} tract(s) — these should be reviewed by a landman or attorney before this data informs a transaction decision.`;
  if (totalGaps > 0) return `${totalGaps} potential gap(s) were found in the organized timeline across ${tractCount} tract(s) — this is a starting point for manual title work, not a complete chain.`;
  return `No surface-level discontinuities or variances were detected across ${tractCount} tract(s) in the available data. This does not constitute a title opinion, and the chain has not been walked or reconciled — professional verification is still required.`;
}
