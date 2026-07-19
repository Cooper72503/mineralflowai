/**
 * Shared normalization for party strings and document-type labels (single place for pipeline + scoring).
 */

const MULTISPACE = /\s+/g;

/** Collapses whitespace; title-cases obvious ALL-CAPS instrument lines. */
export function normalizeDocumentTypeLabel(value: string | null | undefined): string | null {
  if (value == null || typeof value !== "string") return null;
  const t = value.trim().replace(MULTISPACE, " ");
  if (!t) return null;
  if (t.length > 3 && t === t.toUpperCase()) {
    return t.toLowerCase().replace(/\b\w/g, (ch) => ch.toUpperCase());
  }
  return t;
}

/**
 * Canonical classifications used in extraction artifacts and early routing.
 * Display labels are human-readable; this is for logic and persistence.
 */
export type ExtractionDocumentClass =
  | "mineral_deed"
  | "royalty_deed"
  | "oil_and_gas_lease"
  | "assignment"
  | "tax_mineral_ownership_record"
  | "operator_intel_report"
  | "unknown";

const CLASS_TO_LABEL: Record<ExtractionDocumentClass, string> = {
  mineral_deed: "Mineral Deed",
  royalty_deed: "Royalty Deed",
  oil_and_gas_lease: "Oil and Gas Lease",
  assignment: "Assignment",
  tax_mineral_ownership_record: "Tax / Mineral Ownership Record",
  operator_intel_report: "Operator / Intel Report",
  unknown: "Unknown",
};

export function documentClassToDisplayLabel(c: ExtractionDocumentClass): string {
  return CLASS_TO_LABEL[c] ?? "Unknown";
}

/** Maps free-text / LLM output toward a stable document class. */
export function normalizeToDocumentClass(
  documentType: string | null | undefined,
  hintClass?: ExtractionDocumentClass | null
): ExtractionDocumentClass {
  if (hintClass && hintClass !== "unknown") return hintClass;
  const t = (documentType ?? "").trim().toLowerCase();
  if (!t) return "unknown";
  if (/\boperator\b|\bintel\b|\bscout\b|\bdrilling\s+report\b|\bwell\s*completion\b|\bwellbore\b|\bcompletion\s+report\b/.test(t)) {
    return "operator_intel_report";
  }
  if (/\bappraisal\s*roll\b|\btax\s*roll\b|\bmineral\s+ownership\b|\bownership\s+record\b|\bproration\b|\b(rrc|railroad\s+commission)\b/.test(t)) {
    return "tax_mineral_ownership_record";
  }
  if (/\bassignment\b/.test(t)) return "assignment";
  if (/\broyalty\s+deed\b/.test(t)) return "royalty_deed";
  if (/\bmineral\s+deed\b/.test(t) || /\bquit\s*claim\b/.test(t) || /\bwarranty\s+deed\b/.test(t)) {
    return "mineral_deed";
  }
  if (/\b(oil\s+and\s+gas|og\s*)?\s*lease\b|\blease\b.*\broyalt/.test(t)) {
    return "oil_and_gas_lease";
  }
  if (/\bdeed\b/.test(t)) return "mineral_deed";
  return "unknown";
}

/** Trims, collapses spaces, strips trailing punctuation common in OCR. */
export function normalizePartyName(value: string | null | undefined): string | null {
  if (value == null || typeof value !== "string") return null;
  let t = value.replace(/\u00A0/g, " ").replace(MULTISPACE, " ").trim();
  t = t.replace(/[,;]+$/g, "").trim();
  if (t.length < 2 || t.length > 280) return null;
  return t;
}
