import type { FinancialSummary } from "@/lib/financial/financial-summary";
import type { LocationContext } from "@/lib/location/location-context";
import type { DealValuationInput, ValuationFieldSource } from "./types";
import { parseFinancialSignalsFromText } from "@/lib/financial/financial-summary";
import {
  normalizeOwnershipPercentToDecimal,
  normalizeRoyaltyToDecimal,
  pickFirstFiniteNumber,
} from "./normalize";
import type { DrillDifficultySnapshotSnake } from "@/lib/scoring/drillDifficultyEngine";
import type { DevelopmentSignalsSnapshot } from "@/lib/development/detect-development-signals";
import {
  extractAcreageFromTexts,
  extractLegalDescriptionBlockFromText,
  inferCountyAndStateFromTexts,
  inferCountyFromTexts,
  inferUSStateFromText,
  mergeLegalDescriptionParseResults,
  parseLegalDescription,
} from "@/lib/location/legal-description-parser";
import { preferNonEmptyString } from "@/lib/deals/dashboard-normalize";

/**
 * Haystack for valuation fallbacks: prefer pipeline {@link combinedExtractionText} (PDF + OCR + normalized),
 * then primary stored extraction, then raw PDF text layer. Deduplicates exact trimmed-string matches only.
 */
export function buildValuationHaystackText(args: {
  extractedText?: string | null;
  raw_text?: string | null;
  combinedExtractionText?: string | null;
}): string {
  const parts = [args.combinedExtractionText, args.extractedText, args.raw_text].filter(
    (s): s is string => typeof s === "string" && s.trim().length > 0,
  );
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const p of parts) {
    const key = p.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(key);
  }
  return unique.join("\n\n").trim();
}

/**
 * Infer approximate acreage from a PLSS aliquot string.
 * Quarter sections (NE/4, SW/4, etc.) ≈ 160 acres; half sections (N 1/2, etc.) ≈ 320 acres.
 * Returns null when the pattern isn't recognized (better to show nothing than a wrong number).
 */
function inferAcreageFromPlssAliquot(aliquot: string | null | undefined): number | null {
  if (!aliquot) return null;
  const a = aliquot.trim().toUpperCase().replace(/\s+/g, " ");
  // Quarter section: NE/4, NW/4, SE/4, SW/4, NE 1/4, etc.
  if (/^(NE|NW|SE|SW)\s*(\/\s*4|1\s*\/\s*4)$/i.test(a)) return 160;
  // Half section: N 1/2, S 1/2, E 1/2, W 1/2
  if (/^[NSEW]\s+1\s*\/\s*2$/i.test(a)) return 320;
  return null;
}

/** First finite numeric acreage &gt; 0 (structured fields); skips zero so text fallbacks can win. */
function pickFirstPositiveAcreage(...values: unknown[]): number | null {
  for (const v of values) {
    if (v == null) continue;
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
    if (typeof v === "string") {
      const n = parseFloat(v.trim().replace(/,/g, ""));
      if (!Number.isNaN(n) && Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

function readString(rec: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/** Overlay `parsed` onto `dealScoreInput` without letting null/empty strings wipe existing values. */
function mergeDealScoreWithParsed(
  dsi: Record<string, unknown>,
  parsed: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...dsi };
  for (const [k, v] of Object.entries(parsed)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string" && !v.trim()) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Reads `combined_text` saved inside `extraction_artifacts` on structured extraction blobs (process + DB).
 */
export function readCombinedPipelineTextFromStructured(merged: Record<string, unknown> | null | undefined): string | null {
  if (!merged || typeof merged !== "object") return null;
  const art = merged.extraction_artifacts;
  if (art == null || typeof art !== "object" || Array.isArray(art)) return null;
  const c = (art as Record<string, unknown>).combined_text;
  return typeof c === "string" && c.trim().length > 0 ? c : null;
}

/** Raw PDF text layer saved in {@link ExtractionArtifacts} on structured blobs (process + DB). */
export function readRawPdfTextFromStructured(merged: Record<string, unknown> | null | undefined): string | null {
  if (!merged || typeof merged !== "object") return null;
  const art = merged.extraction_artifacts;
  if (art == null || typeof art !== "object" || Array.isArray(art)) return null;
  const r = (art as Record<string, unknown>).raw_pdf_text;
  return typeof r === "string" && r.trim().length > 0 ? r : null;
}

function monthlyMid(fs: FinancialSummary | null | undefined): number | null {
  if (!fs) return null;
  const a = fs.monthly_revenue_estimate_min;
  const b = fs.monthly_revenue_estimate_max;
  if (a != null && b != null && a > 0 && b > 0) return (a + b) / 2;
  if (a != null && a > 0) return a;
  if (b != null && b > 0) return b;
  return null;
}

function annualMid(fs: FinancialSummary | null | undefined): number | null {
  if (!fs) return null;
  const a = fs.annual_revenue_estimate_min;
  const b = fs.annual_revenue_estimate_max;
  if (a != null && b != null && a > 0 && b > 0) return (a + b) / 2;
  const m = monthlyMid(fs);
  return m != null ? m * 12 : null;
}

/**
 * Pulls a single conservative input object from merged deal + parsed extraction — never overwrites
 * non-null with null.
 */
export function buildValuationInput(args: {
  documentId?: string | null;
  parsed: Record<string, unknown>;
  dealScoreInput: Record<string, unknown>;
  financialSummary: FinancialSummary | null;
  locationContext: LocationContext | null;
  drillSnapshot: DrillDifficultySnapshotSnake;
  extractedText: string;
  raw_text?: string | null;
  combinedExtractionText?: string | null;
}): DealValuationInput {
  const { parsed, dealScoreInput: dsi } = args;
  if (process.env.NODE_ENV !== "production") {
    console.log("[valuation-pre-merge-loc]", {
      county: dsi.county,
      state: dsi.state,
      acreage: dsi.acreage,
    });
    console.log("[valuation-parsed-structured-loc]", {
      county: parsed.county,
      state: parsed.state,
      acreage: parsed.acreage,
      legal_description:
        typeof parsed.legal_description === "string"
          ? parsed.legal_description.slice(0, 160)
          : parsed.legal_description,
    });
  }

  const merged = mergeDealScoreWithParsed(dsi, parsed);

  if (process.env.NODE_ENV !== "production") {
    console.log("[valuation-post-merge-loc]", {
      county: merged.county,
      state: merged.state,
      acreage: merged.acreage,
    });
  }

  const fullText = buildValuationHaystackText({
    extractedText: args.extractedText ?? "",
    raw_text: args.raw_text,
    combinedExtractionText: args.combinedExtractionText,
  });

  if (process.env.NODE_ENV !== "production") {
    console.log("[valuation-source-fields]", {
      hasExtractedText: !!(args.extractedText && String(args.extractedText).trim()),
      hasRawText: !!(args.raw_text && String(args.raw_text).trim()),
      hasCombinedExtractionText: !!(args.combinedExtractionText && String(args.combinedExtractionText).trim()),
    });
    console.log("[valuation-fulltext-length]", fullText.length);
    console.log("[valuation-fulltext-sample]", fullText.slice(0, 500));
  }

  const legalDescFromRecords = preferNonEmptyString(
    typeof parsed.legal_description === "string" ? parsed.legal_description : null,
    readString(merged, ["legal_description"])
  );
  const legalFromLabels = extractLegalDescriptionBlockFromText(fullText);
  const legalDescRaw = preferNonEmptyString(legalDescFromRecords, legalFromLabels);

  const parsedFromFullText = parseLegalDescription(fullText);
  const parsedFromStructuredLegal = parseLegalDescription(legalDescRaw);
  const legal_description_parsed = mergeLegalDescriptionParseResults(
    parsedFromFullText,
    parsedFromStructuredLegal
  );

  if (process.env.NODE_ENV !== "production") {
    console.log("[valuation-parsed-legal]", legal_description_parsed);
  }

  const locationHaystack = [legalDescRaw, fullText].filter(Boolean).join("\n\n");

  const countyExtracted = readString(merged, ["county"]);
  const stateExtracted = readString(merged, ["state"]);
  const inferredLoc = inferCountyAndStateFromTexts(fullText);
  const countyInferredFromText = inferCountyFromTexts(fullText);

  let county = countyExtracted ?? null;
  let county_source: ValuationFieldSource | null = null;
  if (county?.trim()) {
    county_source = "extracted";
  } else {
    county = inferredLoc.county ?? countyInferredFromText;
    county_source = county?.trim() ? "inferred" : null;
  }

  let state = stateExtracted ?? null;
  let state_source: ValuationFieldSource | null = null;
  if (state?.trim()) {
    state_source = "extracted";
  } else {
    state = inferredLoc.state ?? inferUSStateFromText(locationHaystack) ?? inferUSStateFromText(fullText);
    state_source = state?.trim() ? "inferred" : null;
  }

  const acreageExplicit =
    pickFirstPositiveAcreage(
      merged.acreage,
      merged.acres,
      merged.net_acres,
      merged.nma,
      merged.net_mineral_acres,
      parsed.acreage,
    ) ??
    extractAcreageFromTexts(fullText) ??
    extractAcreageFromTexts(legalDescRaw);

  const plssInferredAcreage = acreageExplicit == null
    ? inferAcreageFromPlssAliquot(legal_description_parsed.plss_aliquot)
    : null;

  const acreage = acreageExplicit ?? plssInferredAcreage;
  const acreage_source: "extracted" | "inferred_plss" | null =
    acreage == null ? null
    : plssInferredAcreage != null ? "inferred_plss"
    : "extracted";

  if (process.env.NODE_ENV !== "production") {
    console.log("[valuation-fallback-county]", county);
    console.log("[valuation-fallback-state]", state);
    console.log("[valuation-fallback-acreage]", acreage);
  }

  const royaltyRaw =
    readString(merged, ["royalty_rate", "lease_royalty", "royalty"]) ??
    (typeof parsed.royalty_rate === "string" ? parsed.royalty_rate : null);
  const royalty_rate = normalizeRoyaltyToDecimal(royaltyRaw);

  const ownership_percent = normalizeOwnershipPercentToDecimal(
    pickFirstFiniteNumber(merged.ownership_percent, merged.mineral_interest, merged.working_interest) ??
      readString(merged, ["ownership", "working_interest", "mineral_interest"])
  );

  const financial_summary = args.financialSummary;
  const monthly_revenue = monthlyMid(financial_summary);
  const annual_revenue = annualMid(financial_summary);

  const sig = parseFinancialSignalsFromText(fullText, royaltyRaw);
  const oilMonthly = sig.oilBblMonthlyApprox;
  const bopd =
    oilMonthly != null && oilMonthly > 0 ? oilMonthly / 30 : pickFirstFiniteNumber(merged.bopd, merged.oil_bopd, merged.barrels_per_day);

  const legalDescriptionOut =
    (legalDescRaw && legalDescRaw.trim()) || (fullText.trim() ? fullText : null);

  const out: DealValuationInput = {
    document_id: args.documentId ?? undefined,
    county,
    county_source,
    state,
    state_source,
    basin: readString(merged, ["basin"]) ?? null,
    legal_description: legalDescriptionOut,
    legal_description_parsed,
    acreage,
    acreage_source,
    royalty_rate,
    ownership_percent,
    interest_type: readString(merged, ["interest_type"]),
    bopd: bopd != null && bopd > 0 ? bopd : null,
    bwpd: pickFirstFiniteNumber(merged.bwpd, merged.water_bwpd),
    monthly_revenue: monthly_revenue != null && monthly_revenue > 0 ? monthly_revenue : null,
    annual_revenue: annual_revenue != null && annual_revenue > 0 ? annual_revenue : null,
    operator: readString(merged, ["operator", "operator_name"]),
    document_type:
      readString(merged, ["document_type"]) ??
      (typeof parsed.document_type === "string" ? parsed.document_type : null),
    location_context: args.locationContext,
    drill_difficulty: args.drillSnapshot,
    structured_source: merged,
    development_signals:
      dsi.development_signals != null && typeof dsi.development_signals === "object"
        ? (dsi.development_signals as DevelopmentSignalsSnapshot)
        : null,
    financial_summary: financial_summary ?? undefined,
    extracted_text_sample: fullText.slice(0, 4000) || null,
  };

  if (process.env.NODE_ENV !== "production") {
    console.log("[valuation-input-final]", {
      county: out.county,
      state: out.state,
      acreage: out.acreage,
      county_source: out.county_source,
      state_source: out.state_source,
      legal_len: out.legal_description?.length ?? 0,
      parsed_legal: out.legal_description_parsed,
    });
  }

  return out;
}
