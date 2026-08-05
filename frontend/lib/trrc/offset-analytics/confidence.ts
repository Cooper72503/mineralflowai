/**
 * Confidence model — aggregates the per-dimension confidence figures
 * already produced by earlier phases into a classification. Does not
 * invent new confidence signals; each dimension here maps directly to a
 * value a prior module already computed:
 *   legalDescription <- legal-description.ts's extractionConfidence
 *   geometry         <- geocoding.ts's GeocodeResult.confidence
 *   wellLocation      <- well-search.ts (1.0 if wells were found via a
 *                         live spatial query, 0 if the search itself failed)
 *   geologicalMatch   <- analog-scoring.ts's formation dimension rawScore, averaged across selected analogs
 *   productionData    <- fraction of selected analogs with qcPassed decline fits (analog-decline-fitting.ts)
 *   declineFit        <- median R² across QC-passed fits
 *   ownership         <- ownership-economics.ts's resultType (real owner interest = high, proxy fallback = low)
 *   economics         <- derived from productionData + declineFit + ownership (an economics number is only as good as what feeds it)
 *
 * Overall classification is the MINIMUM (not average) of the dimensions —
 * one badly-confident input (e.g. no real ownership data) should pull the
 * overall rating down, not get diluted into a falsely-comfortable average
 * with seven other decent dimensions.
 */

import type { ConfidenceClassification } from "./types";

export interface ConfidenceDimensions {
  legalDescription: number;
  geometry: number;
  wellLocation: number;
  geologicalMatch: number;
  productionData: number;
  declineFit: number;
  ownership: number;
  economics: number;
}

export interface ConfidenceResult {
  dimensions: ConfidenceDimensions;
  overall: ConfidenceClassification;
}

function classify(score: number): ConfidenceClassification {
  if (score <= 0) return "INSUFFICIENT_DATA";
  if (score >= 0.75) return "HIGH";
  if (score >= 0.45) return "MODERATE";
  return "LOW";
}

const CLASSIFICATION_RANK: Record<ConfidenceClassification, number> = { INSUFFICIENT_DATA: 0, LOW: 1, MODERATE: 2, HIGH: 3 };

export function computeConfidence(dimensions: ConfidenceDimensions): ConfidenceResult {
  const perDimensionClass = Object.values(dimensions).map(classify);
  const overall = perDimensionClass.reduce((worst, current) =>
    CLASSIFICATION_RANK[current] < CLASSIFICATION_RANK[worst] ? current : worst,
  "HIGH" as ConfidenceClassification);

  return { dimensions, overall };
}

/** Ownership confidence is a fixed lookup, not a continuous score — the resultType IS the confidence signal (see ownership-economics.ts). */
export function ownershipConfidenceScore(resultType: "ROYALTY_OWNER_PV10" | "WORKING_INTEREST_OWNER_PV10" | "GROSS_TRACT_PROXY_VALUE" | "VALUE_PER_NET_MINERAL_ACRE" | "OWNER_PV10_UNAVAILABLE"): number {
  switch (resultType) {
    case "ROYALTY_OWNER_PV10":
    case "WORKING_INTEREST_OWNER_PV10": return 0.9;
    case "GROSS_TRACT_PROXY_VALUE": return 0.3;
    case "VALUE_PER_NET_MINERAL_ACRE": return 0.2;
    case "OWNER_PV10_UNAVAILABLE": return 0;
  }
}
