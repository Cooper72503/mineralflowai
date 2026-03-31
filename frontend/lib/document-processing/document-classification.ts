/**
 * Pre-extraction document categories (classifier runs before LLM + full heuristic merge).
 * Maps legacy {@link ExtractionDocumentClass} values into this taxonomy for weighting.
 */

import type { ExtractionDocumentClass } from "./extraction-normalize";

export type DocumentCategory =
  | "mineral_deed"
  | "oil_gas_lease"
  | "assignment"
  | "division_order"
  | "other";

export type DocumentCategoryResult = {
  category: DocumentCategory;
  /** Classifier confidence 0–1 (keyword / pattern strength). */
  score: number;
};

const HEAD_TAIL = (text: string): string => {
  const t = text.trim();
  if (t.length <= 8000) return t.toUpperCase();
  return `${t.slice(0, 8000)}\n${t.slice(-2500)}`.toUpperCase();
};

/**
 * Keyword-first classification on combined native + OCR + PDF text.
 * Order matters: division order and special records before generic lease/deed.
 */
export function classifyDocumentCategory(text: string): DocumentCategoryResult {
  if (!text?.trim()) return { category: "other", score: 0.35 };
  const head = HEAD_TAIL(text);
  const headEarly = text.slice(0, 6000).toUpperCase();

  // Division orders / DOI — before generic "ORDER" or lease noise
  if (
    /\bDIVISION\s+ORDER\b/.test(headEarly) ||
    /\bREVISED\s+DIVISION\s+ORDER\b/.test(headEarly) ||
    (/\bDOI\b/.test(headEarly.slice(0, 4000)) &&
      /\b(DECIMAL|INTEREST|NRI|NET\s+REVENUE|BURNDOWN|PAYEE|OWNER\s*#|INTEREST\s*TYPE)\b/.test(head)) ||
    (/\bDECIMAL\s+INTEREST\b/.test(headEarly) &&
      /\b(PAYEE|REVENUE|PRODUCTION|OPERATOR)\b/.test(head.slice(0, 5000)))
  ) {
    return { category: "division_order", score: 0.88 };
  }
  if (
    /\b(NET\s+REVENUE\s+INTEREST|WORKING\s+INTEREST|REVENUE\s+INTEREST)\b/.test(head.slice(0, 4500)) &&
    /\b(PAYEE|STATEMENT|ALLOCATION|PRODUCT\s*SPLIT)\b/.test(head.slice(0, 6000))
  ) {
    return { category: "division_order", score: 0.72 };
  }

  if (
    /\bOPERATOR\b.*\bREPORT\b|\bSCOUT\b|\bWELL\s*COMPLETION\b|\bDRILLING\s*REPORT\b|\bWELLBORE\b|\bRIG\b.*\bREPORT\b|\bPRODUCTION\s+REPORT\b|\bFIELD\s+SUMMARY\b/.test(
      head
    )
  ) {
    return { category: "other", score: 0.82 };
  }

  const explicitLeaseTitle = /\bOIL\s+AND\s+GAS\s+LEASE\b|\bPAID[\s-]*UP\s+LEASE\b|\bMINERAL\s+LEASE\b/.test(
    head.slice(0, 3500)
  );
  const taxPropertyRecordSignals =
    /\b(APPRAISAL\s*ROLL|TAX\s*ROLL|PROPERTY\s*TAX|TAX\s*CERTIFICATE|TAX\s*STATEMENT|ASSESSMENT\s*(?:ROLL|NOTICE)|PROPERTY\s*RECORD|CAD\s*RECORD|MINERAL\s*ACCOUNT|TAX\s*RECORD)\b/.test(
      head
    ) ||
    (/\b(TAX|ASSESSMENT)\b/.test(head) && /\b(PROPERTY|RECORD|ROLL|PARCEL|ACCOUNT|APPRAISAL)\b/.test(head)) ||
    (/\b(PROPERTY|RECORD)\b/.test(head) && /\b(TAX|ASSESSMENT|APPRAISAL|ROLL)\b/.test(head));
  if (taxPropertyRecordSignals && !explicitLeaseTitle) {
    return { category: "other", score: 0.78 };
  }
  if (
    /\bAPPRAISAL\s*ROLL\b|\bTAX\s*ROLL\b|\bMINERAL\s*OWNERSHIP\b|\bOWNERSHIP\s*RECORD\b|\bPRORATION\b|\b(RRC|RAILROAD\s+COMMISSION)\b/.test(
      head
    )
  ) {
    return { category: "other", score: 0.75 };
  }

  if (/\bASSIGNMENT\s+OF\b|\bASSIGNMENT\s+AND\b|\bCONVEYANCE\s+OF\b|\bDEED\s+OF\s+CONVEYANCE\b/.test(head)) {
    return { category: "assignment", score: 0.85 };
  }
  if (/\bROYALTY\s+DEED\b/.test(head)) {
    return { category: "mineral_deed", score: 0.82 };
  }
  if (/\bMINERAL\s+AND\s+ROYALTY\s+DEED\b/.test(head.slice(0, 4000))) {
    return { category: "mineral_deed", score: 0.88 };
  }
  if (/\bMINERAL\s+DEED\b|\bQUIT\s*CLAIM\s+DEED\b|\bSPECIAL\s+WARRANTY\b/.test(head)) {
    return { category: "mineral_deed", score: 0.86 };
  }
  if (/\bOIL\s+AND\s+GAS\s+LEASE\b|\bPAID[\s-]*UP\s+LEASE\b|\bMINERAL\s+LEASE\b/.test(head)) {
    return { category: "oil_gas_lease", score: 0.88 };
  }
  if (/\bDEED\b/.test(head) && !/\bLEASE\b/.test(head)) {
    return { category: "mineral_deed", score: 0.68 };
  }
  return { category: "other", score: 0.42 };
}

/** Maps legacy heuristic/LLM classes into the five-way category used for confidence. */
export function mapExtractionClassToCategory(c: ExtractionDocumentClass): DocumentCategory {
  switch (c) {
    case "mineral_deed":
    case "royalty_deed":
      return "mineral_deed";
    case "oil_and_gas_lease":
      return "oil_gas_lease";
    case "assignment":
      return "assignment";
    case "tax_mineral_ownership_record":
    case "operator_intel_report":
    case "unknown":
    default:
      return "other";
  }
}

/**
 * Prefer strong pre-classifier signal; fall back to heuristic class when early pass is weak or "other".
 */
export function resolveDocumentCategory(
  early: DocumentCategoryResult,
  heurClass: ExtractionDocumentClass
): DocumentCategory {
  const fromHeur = mapExtractionClassToCategory(heurClass);
  if (early.score >= 0.62 && early.category !== "other") return early.category;
  if (early.category === "other" && fromHeur !== "other") return fromHeur;
  if (
    early.category !== "other" &&
    fromHeur !== "other" &&
    early.category !== fromHeur
  ) {
    if (heurClass === "mineral_deed" || heurClass === "oil_and_gas_lease" || heurClass === "assignment") {
      return fromHeur;
    }
    return early.category;
  }
  return early.category !== "other" ? early.category : fromHeur;
}

export type CategoryConfidenceProfile = {
  /** Multiplier on the computed document_type_confidence component. */
  docTypeMultiplier: number;
  /** Applied to weighted baseline and post-calibration extraction confidence. */
  overallMultiplier: number;
  /** Party / legal weight multipliers (relative to fixed base weights). */
  partyWeightMult: number;
  legalWeightMult: number;
  /** When true, missing term_length does not reduce confidence (deeds, DOI). */
  skipTermMissingPenalty: boolean;
  /** When true, missing royalty_rate does not reduce confidence. */
  skipRoyaltyMissingPenalty: boolean;
  /** Extra penalty when term expected but absent (e.g. lease). */
  extraTermPenalty: number;
};

const BASE_WEIGHTS = {
  party: 0.22,
  county: 0.18,
  state: 0.08,
  legal: 0.12,
  docType: 0.12,
  acreage: 0.08,
  text: 0.2,
} as const;

export type ConfidenceBlendWeights = {
  party: number;
  county: number;
  state: number;
  legal: number;
  docType: number;
  acreage: number;
  text: number;
};

/** Keeps weights summing to 1 while nudging party/legal by category. */
export function blendConfidenceWeights(profile: CategoryConfidenceProfile): ConfidenceBlendWeights {
  const w = {
    party: BASE_WEIGHTS.party * profile.partyWeightMult,
    county: BASE_WEIGHTS.county,
    state: BASE_WEIGHTS.state,
    legal: BASE_WEIGHTS.legal * profile.legalWeightMult,
    docType: BASE_WEIGHTS.docType,
    acreage: BASE_WEIGHTS.acreage,
    text: BASE_WEIGHTS.text,
  };
  const sum = w.party + w.county + w.state + w.legal + w.docType + w.acreage + w.text;
  const f = 1 / sum;
  return {
    party: w.party * f,
    county: w.county * f,
    state: w.state * f,
    legal: w.legal * f,
    docType: w.docType * f,
    acreage: w.acreage * f,
    text: w.text * f,
  };
}

export function categoryConfidenceProfile(category: DocumentCategory): CategoryConfidenceProfile {
  switch (category) {
    case "mineral_deed":
      return {
        docTypeMultiplier: 1.05,
        overallMultiplier: 1,
        partyWeightMult: 1.06,
        legalWeightMult: 1.05,
        skipTermMissingPenalty: true,
        skipRoyaltyMissingPenalty: true,
        extraTermPenalty: 0,
      };
    case "oil_gas_lease":
      return {
        docTypeMultiplier: 1,
        overallMultiplier: 1,
        partyWeightMult: 1,
        legalWeightMult: 1,
        skipTermMissingPenalty: false,
        skipRoyaltyMissingPenalty: false,
        extraTermPenalty: 0.025,
      };
    case "assignment":
      return {
        docTypeMultiplier: 0.95,
        overallMultiplier: 0.97,
        partyWeightMult: 0.98,
        legalWeightMult: 0.98,
        skipTermMissingPenalty: true,
        skipRoyaltyMissingPenalty: false,
        extraTermPenalty: 0,
      };
    case "division_order":
      return {
        docTypeMultiplier: 0.88,
        overallMultiplier: 0.92,
        partyWeightMult: 1,
        legalWeightMult: 0.96,
        skipTermMissingPenalty: true,
        skipRoyaltyMissingPenalty: true,
        extraTermPenalty: 0,
      };
    case "other":
      return {
        docTypeMultiplier: 0.78,
        overallMultiplier: 0.9,
        partyWeightMult: 0.96,
        legalWeightMult: 0.96,
        skipTermMissingPenalty: true,
        skipRoyaltyMissingPenalty: false,
        extraTermPenalty: 0,
      };
  }
}
