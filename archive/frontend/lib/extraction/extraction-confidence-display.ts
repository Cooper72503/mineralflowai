/**
 * Human-readable extraction confidence for UI (no raw floating-point scores).
 */

export type ConfidenceLevelId = "high" | "medium" | "low";

const FIELD_LABELS: Record<string, string> = {
  lessor: "lessor / grantor",
  lessee: "lessee / grantee",
  grantor: "grantor",
  grantee: "grantee",
  county: "county",
  state: "state",
  legal_description: "legal description",
  acreage: "acreage",
  royalty_rate: "royalty rate",
  term_length: "term length",
  effective_date: "effective date",
  recording_date: "recording date",
  document_type: "document type",
  owner: "owner",
  parties: "parties",
};

function fieldLabel(key: string): string {
  return FIELD_LABELS[key] ?? key.replace(/_/g, " ");
}

function readFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = parseFloat(value.trim());
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function readStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out = value.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((s) => s.trim());
  return out.length > 0 ? out : null;
}

/**
 * Optional pipeline-provided lists (snake_case or camelCase). When present, the document UI prefers these over heuristics.
 */
export function readStructuredConfidenceLists(merged: Record<string, unknown> | null | undefined): {
  reasons: string[] | null;
  warnings: string[] | null;
} {
  const m = merged ?? {};
  const reasons = readStringArray(
    m.confidence_reasons ?? m.confidenceReasons ?? m.extraction_confidence_reasons
  );
  const warnings = readStringArray(
    m.confidence_warnings ?? m.confidenceWarnings ?? m.extraction_confidence_warnings
  );
  return { reasons, warnings };
}

function asPlainRecord(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Stored as 0–1 or 0–100; returns 0–100 integer for display. */
export function confidencePercentFromStored(score: unknown): number | null {
  const n = readFiniteNumber(score);
  if (n == null) return null;
  const p = n > 1 ? n : n * 100;
  return Math.round(Math.max(0, Math.min(100, p)));
}

export function confidenceLevelFromPercent(percent: number): ConfidenceLevelId {
  if (percent >= 85) return "high";
  if (percent >= 65) return "medium";
  return "low";
}

export function confidenceLevelTitle(level: ConfidenceLevelId): string {
  switch (level) {
    case "high":
      return "High";
    case "medium":
      return "Medium";
    case "low":
      return "Low";
    default:
      return "Low";
  }
}

export function resolveExtractionConfidencePercent(args: {
  columnScore: number | null | undefined;
  merged: Record<string, unknown> | null | undefined;
}): number | null {
  const fromCol = confidencePercentFromStored(args.columnScore);
  if (fromCol != null) return fromCol;
  const m = args.merged ?? {};
  return (
    confidencePercentFromStored(m.confidence_score) ??
    confidencePercentFromStored(m.extraction_confidence) ??
    null
  );
}

function readNestedArtifacts(merged: Record<string, unknown>): Record<string, unknown> | null {
  return asPlainRecord(merged.extraction_artifacts);
}

function confidenceByFieldMap(merged: Record<string, unknown>): Record<string, number> | null {
  const top = merged.confidence_by_field;
  const fromTop = asPlainRecord(top);
  if (fromTop) {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(fromTop)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return Object.keys(out).length ? out : null;
  }
  const art = readNestedArtifacts(merged);
  const nested = art?.confidence_by_field;
  const fromNested = asPlainRecord(nested);
  if (!fromNested) return null;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(fromNested)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

function inferredFieldKeys(merged: Record<string, unknown>): string[] {
  const art = readNestedArtifacts(merged);
  const inf = art?.inferred_fields ?? merged.inferred_fields;
  const rec = asPlainRecord(inf);
  if (!rec) return [];
  return Object.keys(rec).filter((k) => rec[k] != null && rec[k] !== "");
}

function extractionErrorMessages(merged: Record<string, unknown>): string[] {
  const art = readNestedArtifacts(merged);
  const raw = art?.extraction_errors ?? merged.extraction_errors;
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
}

function readComponent(
  merged: Record<string, unknown>,
  key: "party_confidence" | "county_confidence" | "text_quality_confidence" | "ocr_confidence"
): number | undefined {
  const v = readFiniteNumber(merged[key]);
  if (v != null) return v;
  const art = readNestedArtifacts(merged);
  if (!art) return undefined;
  return readFiniteNumber(art[key]);
}

/** 2–4 bullets explaining what drives confidence (no raw decimals). */
export function buildConfidenceWhyBullets(
  merged: Record<string, unknown> | null | undefined,
  percent: number | null
): string[] {
  const m = merged ?? {};
  const bullets: string[] = [];

  bullets.push(
    "Overall confidence reflects how reliably we could match parties, location, document type, and lease terms to the extracted text."
  );

  const status = typeof m.extraction_status === "string" ? m.extraction_status.trim().toLowerCase() : "";
  if (status === "complete") {
    bullets.push("Core extraction stages completed; remaining uncertainty is normal for scanned or dense legal language.");
  } else if (status === "partial") {
    bullets.push("Some fields could not be fully resolved from the page—treat missing items as needing review.");
  } else if (status === "low_confidence") {
    bullets.push("Several signals were weak or conflicting, so extracted values should be verified against the source PDF.");
  } else if (status === "failed" || status === "failed_no_ocr") {
    bullets.push("Extraction hit hard limits (e.g. little or no readable text), so confidence stays conservative.");
  }

  const byField = confidenceByFieldMap(m);
  if (byField && Object.keys(byField).length >= 2) {
    const sorted = Object.entries(byField).sort((a, b) => a[1] - b[1]);
    const [a, b] = sorted;
    const labelA = fieldLabel(a[0]);
    const labelB = fieldLabel(b[0]);
    if (a[0] !== b[0]) {
      bullets.push(`The softest signals in this run are around the ${labelA} and ${labelB} fields.`);
    }
  }

  const party = readComponent(m, "party_confidence");
  const county = readComponent(m, "county_confidence");
  if (party != null && party < 0.45) {
    bullets.push("Party identification was shaky—names or roles may not match the document perfectly.");
  } else if (
    party != null &&
    county != null &&
    party >= 0.65 &&
    county >= 0.5
  ) {
    bullets.push("Party and location cues were relatively strong compared with the rest of the extraction.");
  }

  const textQ = readComponent(m, "text_quality_confidence");
  if (textQ != null) {
    if (textQ < 0.45) {
      bullets.push("The underlying text is thin, noisy, or fragmented, which caps how certain we can be.");
    } else if (textQ >= 0.65) {
      bullets.push("The readable text layer was good enough to support structured field extraction.");
    }
  }

  const ocr = readComponent(m, "ocr_confidence");
  if (ocr != null) {
    if (ocr < 0.5) {
      bullets.push("OCR was part of the pipeline; when OCR is noisy, dates and numbers deserve extra scrutiny.");
    } else if (ocr >= 0.65) {
      bullets.push("OCR output was clear enough to contribute reliably to the overall score.");
    }
  }

  const hasConfidenceDetail =
    confidenceByFieldMap(m) != null ||
    readComponent(m, "party_confidence") != null ||
    readComponent(m, "text_quality_confidence") != null ||
    (typeof m.extraction_status === "string" && m.extraction_status.trim() !== "");

  if (merged && Object.keys(m).length > 0 && !hasConfidenceDetail) {
    bullets.push(
      "Limited structured metadata is stored for this extraction; re-run processing for richer confidence detail."
    );
  }

  const uniq: string[] = [];
  const seen = new Set<string>();
  for (const b of bullets) {
    if (!seen.has(b)) {
      seen.add(b);
      uniq.push(b);
    }
  }

  let out = uniq.slice(0, 4);
  if (out.length < 2 && percent != null) {
    out = [
      ...out,
      "Confirm high-stakes fields (royalty, term, parties) against the signed document.",
    ].filter((s, i, arr) => arr.indexOf(s) === i);
    out = out.slice(0, 4);
  }
  return out;
}

export type ExtractionColumnSnapshot = {
  lessor: string | null | undefined;
  lessee: string | null | undefined;
  county: string | null | undefined;
  state: string | null | undefined;
  legal_description: string | null | undefined;
  effective_date: string | null | undefined;
  recording_date: string | null | undefined;
  royalty_rate: string | null | undefined;
  term_length: string | null | undefined;
};

function isEmpty(v: string | null | undefined): boolean {
  return v == null || String(v).trim() === "";
}

/** Warnings: missing fields, inferred values, weak OCR/text — no raw confidence decimals. */
export function buildConfidenceWarnings(
  merged: Record<string, unknown> | null | undefined,
  columns: ExtractionColumnSnapshot
): string[] {
  const m = merged ?? {};
  const warnings: string[] = [];

  const missingLabels: string[] = [];
  if (isEmpty(columns.lessor)) missingLabels.push("Lessor / grantor");
  if (isEmpty(columns.lessee)) missingLabels.push("Lessee / grantee");
  if (isEmpty(columns.county)) missingLabels.push("County");
  if (isEmpty(columns.state)) missingLabels.push("State");
  if (isEmpty(columns.legal_description)) missingLabels.push("Legal description");
  if (isEmpty(columns.effective_date)) missingLabels.push("Effective date");
  if (isEmpty(columns.recording_date)) missingLabels.push("Recording date");
  if (isEmpty(columns.royalty_rate)) missingLabels.push("Royalty rate");
  if (isEmpty(columns.term_length)) missingLabels.push("Term length");

  if (missingLabels.length > 0) {
    const shown = missingLabels.slice(0, 6);
    const extra = missingLabels.length - shown.length;
    const list = extra > 0 ? `${shown.join(", ")}, and ${extra} more` : shown.join(", ");
    warnings.push(`Missing or empty fields: ${list}.`);
  }

  const inferredKeys = inferredFieldKeys(m);
  if (inferredKeys.length > 0) {
    const human = inferredKeys.slice(0, 4).map(fieldLabel);
    const extra = inferredKeys.length - human.length;
    warnings.push(
      extra > 0
        ? `Some values were inferred (not explicitly quoted), including ${human.join(", ")} and ${extra} more.`
        : `Some values were inferred (not explicitly quoted), including ${human.join(", ")}.`
    );
  }

  const ocr = readComponent(m, "ocr_confidence");
  if (ocr != null && ocr < 0.5) {
    warnings.push("Weak OCR: character-level recognition was noisy—verify critical numbers and names on the PDF.");
  }

  const textQ = readComponent(m, "text_quality_confidence");
  if (textQ != null && textQ < 0.45) {
    warnings.push("Weak text layer: embedded or extracted text is limited, which increases extraction risk.");
  }

  const status = typeof m.extraction_status === "string" ? m.extraction_status.trim().toLowerCase() : "";
  if (status === "partial") {
    warnings.push("Partial extraction: not all expected fields were filled with high certainty.");
  } else if (status === "low_confidence") {
    warnings.push("Marked low-confidence by the pipeline—double-check before relying on this data.");
  }

  for (const err of extractionErrorMessages(m).slice(0, 3)) {
    warnings.push(`Extraction note: ${err}`);
  }

  const uniq: string[] = [];
  const seen = new Set<string>();
  for (const w of warnings) {
    if (!seen.has(w)) {
      seen.add(w);
      uniq.push(w);
    }
  }
  return uniq;
}
