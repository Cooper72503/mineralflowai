/**
 * Multi-stage structured extraction:
 * A/B: native PDF + OCR text provided by caller ({@link processDocumentContent})
 * C: deterministic heuristics
 * D: LLM normalization (optional)
 * E: inference, failsafes, confidence, debug artifacts
 */

import {
  cleanExtractedDocumentText,
  estimateExtractedTextConfidence,
} from "./extracted-text-quality";
import {
  type ExtractionDocumentClass,
  documentClassToDisplayLabel,
  normalizePartyName,
} from "./extraction-normalize";
import {
  classifyDocumentFromKeywords,
  detectTexasContext,
  extractAcreageFromText,
  extractCountyFromLegalFragment,
  extractHeuristicFields,
  extractLegalDescriptionHeuristic,
  extractStateFromText,
  inferCountyFromTxCityLine,
  inferOwnerFromCapitalizedNameBlock,
  inferOwnerFromCapitalizedNameLine,
  inferOwnerFromNameAddressBlock,
  type HeuristicFieldResult,
} from "./heuristic-field-extraction";
import { parseLeaseFieldsWithOpenAi } from "./lease-fields-openai";
import { parseAcreageFromLegalDescription } from "./parse-acreage-from-legal";
import {
  type ParsedLeaseResult,
  normalizeParsedLeaseResult,
  withPartyKinds,
} from "./parsed-lease-result";

const EXTRACT_LOG = "[extract]";

export type ExtractionStatus = "complete" | "partial" | "low_confidence" | "failed";

export type ExtractionArtifacts = {
  /** @deprecated use raw_pdf_text — kept for existing readers */
  raw_text: string;
  raw_pdf_text: string;
  ocr_text: string | null;
  combined_text: string;
  normalized_text: string;
  detected_document_type: string;
  extracted_fields: Record<string, unknown>;
  inferred_fields: Record<string, unknown>;
  fallback_extracted_fields: Record<string, unknown>;
  final_extracted_fields: Record<string, unknown>;
  confidence_by_field: Record<string, number>;
  extraction_status: ExtractionStatus;
  extraction_errors: string[];
  text_quality_confidence: number;
  ocr_confidence: number | null;
  ocr_quality_confidence: number | null;
  party_confidence: number;
  county_confidence: number;
  acreage_confidence: number;
  document_type_confidence: number;
  legal_description_confidence: number;
  extraction_confidence: number;
};

export type StructuredExtractionResult = {
  parsed: ParsedLeaseResult;
  artifacts: ExtractionArtifacts;
};

export type RunStructuredExtractionArgs = {
  normalizedText: string;
  rawPdfText?: string | null;
  ocrText?: string | null;
  pdfNumPages?: number;
  ocrMeanConfidence0to100?: number | null;
  docCounty?: string | null;
  docState?: string | null;
  openAiModel?: string;
  /** When true, skip OpenAI (no key / caller choice). */
  skipOpenAi?: boolean;
};

function logExtract(event: string, payload?: Record<string, unknown>): void {
  console.log(`${EXTRACT_LOG} ${event}`, payload ?? {});
}

function mergeStr(llm: string | null | undefined, heur: string | null | undefined): string | null {
  const a = llm?.trim();
  if (a) return a;
  const b = heur?.trim();
  return b || null;
}

function computeUsableTextLength(normalizedText: string, ocrText: string | null, rawPdfText: string): number {
  return Math.max(
    normalizedText.trim().length,
    (ocrText ?? "").trim().length,
    rawPdfText.trim().length
  );
}

function buildCombinedText(normalizedText: string, ocrText: string | null, rawPdfText: string): string {
  const parts = [normalizedText.trim(), (ocrText ?? "").trim(), rawPdfText.trim()].filter((p) => p.length > 0);
  return parts.join("\n\n");
}

/** Prefer the richest readable layer for the LLM (OCR often beats a thin / junk native layer). */
function selectTextForLlm(normalizedText: string, ocrText: string | null, rawPdfText: string): string {
  const n = normalizedText.trim();
  const o = (ocrText ?? "").trim();
  const r = rawPdfText.trim();
  if (n.length >= 120 && n.length >= o.length * 0.35) return normalizedText;
  if (o.length > n.length + 15) return ocrText ?? o;
  if (!n.length && o.length) return ocrText ?? o;
  if (!n.length && !o.length && r.length) return rawPdfText;
  return normalizedText || (ocrText ?? "") || rawPdfText;
}

function legalSnippetFromBody(text: string): string | null {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\u00A0/g, " ").trim());
  const skip = /^(state|county|page|know\s+all|whereas)\b/i;
  for (const line of lines.slice(0, 55)) {
    if (line.length < 28) continue;
    if (skip.test(line)) continue;
    if (/\d/.test(line) || /section|abstract|survey|tract|block|lot|acres|mineral|parcel|nma\b/i.test(line)) {
      return line.replace(/\s+/g, " ").trim().slice(0, 520);
    }
  }
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length >= 40 ? flat.slice(0, 520) : null;
}

function allCriticalStructuredBlank(p: ParsedLeaseResult): boolean {
  if (p.document_type?.trim()) return false;
  if (p.grantor?.trim() || p.lessor?.trim() || p.owner?.trim()) return false;
  if (p.grantee?.trim() || p.lessee?.trim() || p.buyer?.trim()) return false;
  if (p.county?.trim() || p.state?.trim()) return false;
  if (p.legal_description?.trim()) return false;
  return true;
}

function heuristicToPartialParsed(h: HeuristicFieldResult): Omit<ParsedLeaseResult, "parties" | "confidence_score"> {
  return {
    lessor: h.lessor,
    lessee: h.lessee,
    grantor: h.grantor,
    grantee: h.grantee,
    county: h.county,
    state: h.state,
    legal_description: h.legal_description,
    effective_date: h.effective_date,
    recording_date: h.recording_date,
    royalty_rate: h.royalty_rate,
    term_length: h.term_length,
    document_type: h.document_type,
    owner: h.owner,
    buyer: h.buyer,
    acreage: h.acreage,
    mailing_address: h.mailing_address,
  };
}

function applyInference(
  p: ParsedLeaseResult,
  normalizedText: string,
  combinedText: string,
  docCounty: string | null | undefined,
  docState: string | null | undefined
): { next: ParsedLeaseResult; inferred: Record<string, unknown> } {
  const inferred: Record<string, unknown> = {};
  const next = { ...p };
  const scan = combinedText.trim().length >= normalizedText.trim().length ? combinedText : normalizedText;

  if (!next.owner?.trim() && next.grantor?.trim()) {
    next.owner = next.grantor;
    inferred.owner = "grantor";
  }
  if (!next.owner?.trim() && next.lessor?.trim() && !next.grantor?.trim()) {
    next.owner = next.lessor;
    inferred.owner = "lessor";
  }

  if (!next.buyer?.trim() && next.grantee?.trim()) {
    next.buyer = next.grantee;
    inferred.buyer = "grantee";
  }
  if (!next.buyer?.trim() && next.lessee?.trim()) {
    next.buyer = next.lessee;
    inferred.buyer = "lessee";
  }

  if (!next.county?.trim()) {
    const fromLegal = extractCountyFromLegalFragment(next.legal_description ?? normalizedText);
    if (fromLegal) {
      next.county = fromLegal;
      inferred.county = "legal_description";
    } else {
      const fromLegalCombined = extractCountyFromLegalFragment(scan);
      if (fromLegalCombined) {
        next.county = fromLegalCombined;
        inferred.county = "legal_body";
      } else if (docCounty?.trim()) {
        next.county = docCounty.trim();
        inferred.county = "document_metadata";
        logExtract("FALLBACK_COUNTY_USED", { source: "document_metadata" });
      }
    }
  }

  if (!next.county?.trim()) {
    const fromCity = inferCountyFromTxCityLine(scan);
    if (fromCity) {
      next.county = fromCity;
      inferred.county = "tx_city_line";
      logExtract("FALLBACK_COUNTY_USED", { source: "tx_city_line" });
    }
  }

  if (!next.state?.trim()) {
    const txFromText = extractStateFromText(scan);
    if (txFromText) {
      next.state = txFromText;
      inferred.state = "texas_text";
      logExtract("FALLBACK_STATE_USED", { source: "tx_or_texas_in_text" });
    } else if (detectTexasContext(scan) || (next.county && detectTexasContext(`${next.county} Texas`))) {
      next.state = "TX";
      inferred.state = "texas_context";
      logExtract("FALLBACK_STATE_USED", { source: "texas_context" });
    } else if (docState?.trim()) {
      next.state = docState.trim();
      inferred.state = "document_metadata";
    }
  }

  if (!next.document_type?.trim()) {
    const kw = classifyDocumentFromKeywords(scan);
    if (kw !== "unknown") {
      next.document_type = documentClassToDisplayLabel(kw);
      inferred.document_type = kw;
    }
  }

  if (next.acreage == null) {
    const fromLegal =
      parseAcreageFromLegalDescription(next.legal_description) ??
      parseAcreageFromLegalDescription(normalizedText) ??
      parseAcreageFromLegalDescription(scan);
    if (fromLegal !== undefined) {
      next.acreage = fromLegal;
      inferred.acreage = "legal_description";
    } else {
      const fromBody = extractAcreageFromText(scan);
      if (fromBody != null) {
        next.acreage = fromBody;
        inferred.acreage = "body_scan";
      } else {
        inferred.acreage_status = "unknown";
        logExtract("LOW_CONFIDENCE_INFERENCE", { field: "acreage", detail: "no_numeric_acreage_found" });
      }
    }
  }

  return { next, inferred };
}

function fieldConfidence(
  value: string | null | undefined,
  source: "llm" | "heuristic" | "metadata" | "inferred" | "none"
): number {
  if (!value?.trim()) return source === "none" ? 0 : 0.05;
  switch (source) {
    case "llm":
      return 0.88;
    case "heuristic":
      return 0.62;
    case "metadata":
      return 0.72;
    case "inferred":
      return 0.4;
    default:
      return 0.15;
  }
}

function computePartyConfidence(p: ParsedLeaseResult): number {
  const has =
    (p.grantor?.trim() ? 1 : 0) +
    (p.grantee?.trim() ? 1 : 0) +
    (p.lessor?.trim() ? 1 : 0) +
    (p.lessee?.trim() ? 1 : 0) +
    (p.owner?.trim() ? 1 : 0) +
    (p.buyer?.trim() ? 1 : 0);
  if (has >= 2) return 0.78;
  if (has === 1) return 0.52;
  return 0.12;
}

function deriveExtractionStatus(args: {
  textLen: number;
  overallConf: number;
  criticalFilled: number;
  inferredSignalCount: number;
}): ExtractionStatus {
  if (args.textLen < 15) return "failed";
  if (args.overallConf < 0.22 && args.criticalFilled < 2) return "failed";
  if (args.overallConf < 0.38) return "low_confidence";
  const wouldComplete = args.criticalFilled >= 5 && args.overallConf >= 0.55;
  if (wouldComplete) {
    if (args.inferredSignalCount >= 2) return "low_confidence";
    return "complete";
  }
  return "partial";
}

function applyStructuredFailsafe(
  p: ParsedLeaseResult,
  combinedText: string,
  usableTextLen: number,
  detected_class: ExtractionDocumentClass
): { next: ParsedLeaseResult; fallback: Record<string, boolean> } {
  const fallback: Record<string, boolean> = {};
  if (usableTextLen < 15) return { next: p, fallback };
  const next = { ...p };
  const noOwnerSide = !next.owner?.trim() && !next.grantor?.trim() && !next.lessor?.trim();
  if (noOwnerSide) {
    const o =
      inferOwnerFromNameAddressBlock(combinedText) ?? inferOwnerFromCapitalizedNameBlock(combinedText);
    if (o) {
      next.owner = o;
      if (detected_class === "tax_mineral_ownership_record" && !next.lessor?.trim()) {
        next.lessor = o;
      }
      fallback.owner = true;
      logExtract("FALLBACK_OWNER_USED", { source: "name_address_or_cap_block" });
    }
  }
  if (!next.state?.trim()) {
    const st = extractStateFromText(combinedText);
    if (st) {
      next.state = st;
      fallback.state = true;
      logExtract("FALLBACK_STATE_USED", { source: "failsafe_tx_scan" });
    } else if (detectTexasContext(combinedText)) {
      next.state = "TX";
      fallback.state = true;
      logExtract("FALLBACK_STATE_USED", { source: "failsafe_texas_context" });
    }
  }
  if (!next.document_type?.trim()) {
    const kw = classifyDocumentFromKeywords(combinedText);
    if (kw !== "unknown") {
      next.document_type = documentClassToDisplayLabel(kw);
      fallback.document_type = true;
    }
  }
  return { next, fallback };
}

function applyEmergencyStructuredFallback(
  p: ParsedLeaseResult,
  combinedText: string,
  usableTextLen: number
): { next: ParsedLeaseResult; emergency: Record<string, boolean> } {
  const emergency: Record<string, boolean> = {};
  if (usableTextLen < 15) return { next: p, emergency };
  if (!allCriticalStructuredBlank(p)) return { next: p, emergency };

  logExtract("LOW_CONFIDENCE_INFERENCE", { reason: "emergency_structured_fallback" });
  const next = { ...p };
  const kw = classifyDocumentFromKeywords(combinedText);

  if (!next.document_type?.trim() && kw !== "unknown") {
    next.document_type = documentClassToDisplayLabel(kw);
    emergency.document_type = true;
  }

  if (!next.owner?.trim() && !next.grantor?.trim() && !next.lessor?.trim()) {
    const o =
      inferOwnerFromNameAddressBlock(combinedText) ??
      inferOwnerFromCapitalizedNameBlock(combinedText) ??
      inferOwnerFromCapitalizedNameLine(combinedText);
    if (o) {
      next.owner = o;
      emergency.owner = true;
      logExtract("FALLBACK_OWNER_USED", { source: "emergency_owner_scan" });
    }
  }

  if (
    !next.grantor?.trim() &&
    next.owner?.trim() &&
    (kw === "mineral_deed" || kw === "royalty_deed" || kw === "assignment")
  ) {
    next.grantor = next.owner;
    emergency.grantor_from_owner = true;
  }

  if (!next.state?.trim()) {
    const st = extractStateFromText(combinedText);
    if (st) {
      next.state = st;
      emergency.state = true;
      logExtract("FALLBACK_STATE_USED", { source: "emergency" });
    } else if (detectTexasContext(combinedText)) {
      next.state = "TX";
      emergency.state = true;
      logExtract("FALLBACK_STATE_USED", { source: "emergency_texas_context" });
    }
  }

  if (!next.county?.trim()) {
    const c = extractCountyFromLegalFragment(combinedText) ?? inferCountyFromTxCityLine(combinedText);
    if (c) {
      next.county = c;
      emergency.county = true;
      logExtract("FALLBACK_COUNTY_USED", { source: "emergency" });
    }
  }

  if (!next.legal_description?.trim()) {
    const leg = extractLegalDescriptionHeuristic(combinedText) ?? legalSnippetFromBody(combinedText);
    if (leg) {
      next.legal_description = leg;
      emergency.legal_description = true;
    }
  }

  emergency.forced_low_confidence_status = true;
  return { next, emergency };
}

/** Owner-side critical empty: no owner, grantor, or lessor. */
function finalCriticalOwnerSideBlank(p: ParsedLeaseResult): boolean {
  return !p.owner?.trim() && !p.grantor?.trim() && !p.lessor?.trim();
}

/** Document-type / geo / owner-side all blank — triggers terminal failsafe (stricter than emergency `allCriticalStructuredBlank`). */
function finalCriticalQuadrupleBlank(p: ParsedLeaseResult): boolean {
  return (
    finalCriticalOwnerSideBlank(p) &&
    !p.county?.trim() &&
    !p.state?.trim() &&
    !p.document_type?.trim()
  );
}

/**
 * 2–3 ALL CAPS word name line + address + CITY, TX ZIP (terminal failsafe; stricter than heuristic name/address).
 */
function extractFinalFallbackOwnerAllCapsBlock(text: string): string | null {
  const slice = text.slice(0, 24_000);
  const lines = slice.split(/\r?\n/).map((l) => l.replace(/\u00A0/g, " ").trim());
  const allCapsNameRe = /^[A-Z][A-Z.'-]+(?:\s+[A-Z][A-Z.'-]+){1,2}$/;
  for (let i = 0; i < lines.length - 2; i++) {
    const nameLine = lines[i];
    const addrLine = lines[i + 1];
    const cityLine = lines[i + 2];
    if (!nameLine || !addrLine || !cityLine) continue;
    if (!allCapsNameRe.test(nameLine)) continue;
    const addrOk = /\d/.test(addrLine) || /\bp\.?\s*o\.?\s*box\b/i.test(addrLine);
    if (!addrOk || addrLine.length > 200) continue;
    const cityOk =
      /^[A-Za-z][A-Za-z\s.'-]{1,42},\s*(?:TX|Texas)\s+\d{5}(?:-\d{4})?\s*$/i.test(cityLine) ||
      /^[A-Za-z][A-Za-z\s.'-]{1,42}\s+(?:TX|Texas)\s+\d{5}(?:-\d{4})?\s*$/i.test(cityLine);
    if (!cityOk) continue;
    const n = normalizePartyName(nameLine);
    if (n && !/^(unknown|owner|name)\b/i.test(n)) return n;
  }
  return null;
}

function extractCountyFinalFailsafeRegex(text: string): string | null {
  const m1 = text.match(/([A-Za-z]+)\s+County/i);
  if (m1?.[1]?.trim()) {
    const w = m1[1].trim();
    return w[0].toUpperCase() + w.slice(1).toLowerCase();
  }
  const m2 = text.match(/County of\s+([A-Za-z]+)/i);
  if (m2?.[1]?.trim()) {
    const w = m2[1].trim();
    return w[0].toUpperCase() + w.slice(1).toLowerCase();
  }
  return null;
}

function inferFinalFallbackDocumentType(text: string): string {
  const t = text.toLowerCase();
  if (/\btax\b/.test(t) || /\bproperty\b/.test(t) || /\brecord\b/.test(t) || /\bassessment\b/.test(t)) {
    return "Tax / Mineral Ownership";
  }
  if (/\bdeed\b/.test(t) || /\bgrantor\b/.test(t) || /\bgrantee\b/.test(t)) {
    return "Mineral / Royalty Deed";
  }
  return "Unknown Document";
}

/**
 * Last-resort structured fill after heuristics, LLM, inference, merging, and earlier failsafes.
 * Does not run `normalizeParsedLeaseResult` afterward so values cannot be cleared by later normalization.
 */
function applyFinalStructuredFailsafe(
  p: ParsedLeaseResult,
  combinedText: string
): { next: ParsedLeaseResult; flags: Record<string, boolean> } {
  const flags: Record<string, boolean> = {};
  const trimmedCombined = combinedText.trim();
  if (trimmedCombined.length < 20 || !finalCriticalQuadrupleBlank(p)) {
    return { next: p, flags };
  }

  const next = { ...p };
  const scan = trimmedCombined;

  if (finalCriticalOwnerSideBlank(next)) {
    const o =
      extractFinalFallbackOwnerAllCapsBlock(scan) ??
      inferOwnerFromNameAddressBlock(scan) ??
      inferOwnerFromCapitalizedNameBlock(scan);
    if (o) {
      next.owner = o;
      flags.owner = true;
      logExtract("FALLBACK_OWNER_USED", { source: "final_failsafe_all_caps_or_address" });
    }
  }

  if (!next.county?.trim()) {
    const fromRe = extractCountyFinalFailsafeRegex(scan);
    if (fromRe) {
      next.county = fromRe;
      flags.county = true;
      logExtract("FALLBACK_COUNTY_USED", { source: "final_failsafe_regex" });
    } else {
      const fromCity = inferCountyFromTxCityLine(scan);
      if (fromCity) {
        next.county = fromCity;
        flags.county = true;
        logExtract("FALLBACK_COUNTY_USED", { source: "final_failsafe_tx_city" });
      }
    }
  }

  if (!next.state?.trim() && (/\bTX\b/.test(scan) || /\bTexas\b/i.test(scan))) {
    next.state = "TX";
    flags.state = true;
    logExtract("FALLBACK_STATE_USED", { source: "final_failsafe_tx_texas" });
  }

  if (!next.document_type?.trim()) {
    next.document_type = inferFinalFallbackDocumentType(scan);
    flags.document_type = true;
  }

  if (Object.keys(flags).length > 0) {
    flags.final_failsafe_applied = true;
  }

  return { next, flags };
}

function snapshotFinalFields(p: ParsedLeaseResult): Record<string, unknown> {
  return {
    document_type: p.document_type,
    owner: p.owner,
    buyer: p.buyer,
    grantor: p.grantor,
    grantee: p.grantee,
    lessor: p.lessor,
    lessee: p.lessee,
    county: p.county,
    state: p.state,
    legal_description: p.legal_description?.slice(0, 600) ?? p.legal_description,
    recording_date: p.recording_date,
    effective_date: p.effective_date,
    acreage: p.acreage,
    royalty_rate: p.royalty_rate,
    term_length: p.term_length,
    mailing_address: p.mailing_address,
    parties: p.parties,
    extraction_status: p.extraction_status,
    confidence_score: p.confidence_score,
  };
}

/**
 * Full structured extraction: merge heuristics + optional LLM, inference pass, confidence + debug JSON.
 */
export async function runStructuredExtraction(args: RunStructuredExtractionArgs): Promise<StructuredExtractionResult> {
  const extraction_errors: string[] = [];
  const normalizedText = args.normalizedText ?? "";
  const rawPdfText = args.rawPdfText?.trim() ?? "";
  const ocrText = args.ocrText?.trim() ? args.ocrText.trim() : null;
  const combinedText = buildCombinedText(normalizedText, ocrText, rawPdfText);
  const usableTextLen = computeUsableTextLength(normalizedText, ocrText, rawPdfText);

  logExtract("RAW_TEXT_LENGTH", {
    normalizedLen: normalizedText.trim().length,
    rawPdfLen: rawPdfText.length,
    ocrLen: (ocrText ?? "").length,
    combinedLen: combinedText.length,
    usableTextLen,
  });
  if (rawPdfText.length > 0) logExtract("PDF_TEXT_SUCCESS", { stage: "pipeline_meta", rawPdfLen: rawPdfText.length });
  if ((ocrText ?? "").length > 0) logExtract("OCR_TEXT_LENGTH", { ocrLen: (ocrText ?? "").length });

  const text_quality_confidence = estimateExtractedTextConfidence(normalizedText, {
    numpages: args.pdfNumPages ?? 0,
  });
  const ocr_confidence =
    args.ocrMeanConfidence0to100 != null && Number.isFinite(args.ocrMeanConfidence0to100)
      ? Math.max(0.03, Math.min(1, args.ocrMeanConfidence0to100 / 100))
      : ocrText && ocrText.length >= 15
        ? 0.35
        : null;

  logExtract("HEURISTIC_FIELDS", { textLen: normalizedText.length, combinedLen: combinedText.length });
  const heur = extractHeuristicFields(normalizedText, { ocrText, rawPdfText: rawPdfText || null });
  const detected_class: ExtractionDocumentClass = heur.detected_class;

  const llmInputRaw = selectTextForLlm(normalizedText, ocrText, rawPdfText);
  const llmInput =
    llmInputRaw.trim().length === 0
      ? ""
      : (() => {
          const cleaned = cleanExtractedDocumentText(llmInputRaw);
          return cleaned.length > 0 ? cleaned : llmInputRaw.trim();
        })();

  let llm: ParsedLeaseResult | null = null;
  if (!args.skipOpenAi && process.env.OPENAI_API_KEY) {
    logExtract("LLM_NORMALIZATION_START", { textLen: llmInput.length, source: "combined_priority" });
    try {
      llm = await parseLeaseFieldsWithOpenAi(llmInput, { model: args.openAiModel });
      logExtract("LLM_NORMALIZATION_SUCCESS", { model: args.openAiModel ?? "gpt-4o-mini" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      extraction_errors.push(msg);
      logExtract("LLM_NORMALIZATION_START", { error: msg });
    }
  } else if (!args.skipOpenAi) {
    extraction_errors.push("OPENAI_API_KEY missing — heuristic + inference only.");
  }

  const hBase = heuristicToPartialParsed(heur);
  const headingScan = combinedText.trim().length > 0 ? combinedText : normalizedText;

  const docTypeMerged =
    detected_class === "tax_mineral_ownership_record"
      ? documentClassToDisplayLabel(detected_class)
      : mergeStr(llm?.document_type, hBase.document_type);

  let mergedPre: ParsedLeaseResult = normalizeParsedLeaseResult(
    {
      lessor: mergeStr(llm?.lessor, hBase.lessor),
      lessee: mergeStr(llm?.lessee, hBase.lessee),
      grantor: mergeStr(llm?.grantor, hBase.grantor),
      grantee: mergeStr(llm?.grantee, hBase.grantee),
      county: mergeStr(llm?.county, hBase.county),
      state: mergeStr(llm?.state, hBase.state),
      legal_description: mergeStr(llm?.legal_description, hBase.legal_description),
      effective_date: mergeStr(llm?.effective_date, hBase.effective_date),
      recording_date: mergeStr(llm?.recording_date, hBase.recording_date),
      royalty_rate: mergeStr(llm?.royalty_rate, hBase.royalty_rate),
      term_length: mergeStr(llm?.term_length, hBase.term_length),
      mailing_address: mergeStr(llm?.mailing_address, hBase.mailing_address),
      document_type: docTypeMerged,
      confidence_score: llm?.confidence_score ?? 0.35,
      parties: withPartyKinds(llm?.parties ?? null),
      owner: hBase.owner ?? null,
      buyer: hBase.buyer ?? null,
      acreage: hBase.acreage ?? null,
    },
    headingScan
  );

  const { next: afterInference, inferred } = applyInference(
    mergedPre,
    normalizedText,
    combinedText,
    args.docCounty,
    args.docState
  );
  let parsed = normalizeParsedLeaseResult(afterInference, headingScan);

  const { next: afterFailsafe, fallback: failsafeFlags } = applyStructuredFailsafe(
    parsed,
    combinedText,
    usableTextLen,
    detected_class
  );
  parsed = normalizeParsedLeaseResult(afterFailsafe, headingScan);

  const { next: afterEmergency, emergency: emergencyFlags } = applyEmergencyStructuredFallback(
    parsed,
    combinedText,
    usableTextLen
  );
  parsed = normalizeParsedLeaseResult(afterEmergency, headingScan);

  parsed.parties = withPartyKinds(parsed.parties);

  const { next: afterFinalFailsafe, flags: finalFailsafeFlags } = applyFinalStructuredFailsafe(
    parsed,
    combinedText
  );
  parsed = afterFinalFailsafe;

  const inferred_fields: Record<string, unknown> = { ...inferred };
  if (Object.keys(failsafeFlags).length > 0) {
    inferred_fields.failsafe = failsafeFlags;
    logExtract("LOW_CONFIDENCE_INFERENCE", { failsafe_flags: failsafeFlags });
  }
  if (Object.keys(emergencyFlags).length > 0) {
    inferred_fields.emergency = emergencyFlags;
  }
  if (Object.keys(finalFailsafeFlags).length > 0) {
    inferred_fields.final_failsafe = finalFailsafeFlags;
  }

  const extracted_fields: Record<string, unknown> = {
    ...hBase,
    detected_class,
  };

  const fallback_extracted_fields: Record<string, unknown> = {
    failsafe: failsafeFlags,
    emergency: emergencyFlags,
    final: finalFailsafeFlags,
  };

  const confidence_by_field: Record<string, number> = {
    lessor: fieldConfidence(parsed.lessor, llm?.lessor ? "llm" : parsed.lessor ? "heuristic" : "none"),
    lessee: fieldConfidence(parsed.lessee, llm?.lessee ? "llm" : parsed.lessee ? "heuristic" : "none"),
    grantor: fieldConfidence(parsed.grantor, llm?.grantor ? "llm" : parsed.grantor ? "heuristic" : "none"),
    grantee: fieldConfidence(parsed.grantee, llm?.grantee ? "llm" : parsed.grantee ? "heuristic" : "none"),
    county: fieldConfidence(
      parsed.county,
      llm?.county
        ? "llm"
        : heur.county
          ? "heuristic"
          : inferred.county || finalFailsafeFlags.county
            ? "inferred"
            : "none"
    ),
    state: fieldConfidence(
      parsed.state,
      llm?.state
        ? "llm"
        : heur.state
          ? "heuristic"
          : inferred.state || failsafeFlags.state || emergencyFlags.state || finalFailsafeFlags.state
            ? "inferred"
            : "none"
    ),
    legal_description: fieldConfidence(
      parsed.legal_description,
      llm?.legal_description ? "llm" : heur.legal_description ? "heuristic" : emergencyFlags.legal_description ? "inferred" : "none"
    ),
    document_type: fieldConfidence(
      parsed.document_type,
      llm?.document_type && detected_class !== "tax_mineral_ownership_record"
        ? "llm"
        : heur.document_type || detected_class === "tax_mineral_ownership_record"
          ? "heuristic"
          : inferred.document_type ||
              failsafeFlags.document_type ||
              emergencyFlags.document_type ||
              finalFailsafeFlags.document_type
            ? "inferred"
            : "none"
    ),
    owner: fieldConfidence(
      parsed.owner,
      !parsed.owner?.trim()
        ? "none"
        : failsafeFlags.owner ||
            inferred.owner ||
            emergencyFlags.owner ||
            finalFailsafeFlags.owner
          ? "inferred"
          : "heuristic"
    ),
    buyer: fieldConfidence(
      parsed.buyer,
      !parsed.buyer?.trim() ? "none" : inferred.buyer ? "inferred" : "heuristic"
    ),
    effective_date: fieldConfidence(parsed.effective_date, llm?.effective_date ? "llm" : "heuristic"),
    recording_date: fieldConfidence(parsed.recording_date, llm?.recording_date ? "llm" : "heuristic"),
    royalty_rate: fieldConfidence(parsed.royalty_rate, llm?.royalty_rate ? "llm" : "heuristic"),
    term_length: fieldConfidence(parsed.term_length, llm?.term_length ? "llm" : "heuristic"),
    mailing_address: fieldConfidence(
      parsed.mailing_address,
      llm?.mailing_address ? "llm" : heur.mailing_address ? "heuristic" : "none"
    ),
    acreage:
      parsed.acreage != null && parsed.acreage > 0
        ? inferred.acreage
          ? 0.45
          : heur.acreage
            ? 0.55
            : 0.5
        : inferred.acreage_status === "unknown"
          ? 0.08
          : 0.12,
  };

  const party_confidence = computePartyConfidence(parsed);
  let county_confidence = confidence_by_field.county ?? 0;
  if (!parsed.county?.trim() && detectTexasContext(combinedText)) {
    county_confidence = Math.min(county_confidence, 0.15);
    logExtract("FALLBACK_COUNTY_USED", { source: "texas_strong_no_county", county_confidence });
  }
  const acreage_confidence =
    parsed.acreage != null && parsed.acreage > 0
      ? inferred.acreage
        ? 0.45
        : heur.acreage
          ? 0.55
          : 0.5
      : inferred.acreage_status === "unknown"
        ? 0.08
        : 0.12;
  const document_type_confidence =
    detected_class !== "unknown" ? 0.72 : llm?.document_type ? 0.55 : 0.28;
  const legal_description_confidence = confidence_by_field.legal_description ?? 0;

  const weights = {
    party: 0.22,
    county: 0.18,
    state: 0.08,
    legal: 0.12,
    docType: 0.12,
    acreage: 0.08,
    text: 0.2,
  };
  const legalC = legal_description_confidence;
  let extraction_confidence =
    party_confidence * weights.party +
    county_confidence * weights.county +
    (confidence_by_field.state ?? 0) * weights.state +
    legalC * weights.legal +
    document_type_confidence * weights.docType +
    acreage_confidence * weights.acreage +
    text_quality_confidence * weights.text;

  if (ocr_confidence != null) {
    extraction_confidence = extraction_confidence * 0.85 + ocr_confidence * 0.15;
  }

  extraction_confidence = Math.max(0, Math.min(1, extraction_confidence));

  const textLen = usableTextLen;
  if (textLen >= 15) {
    extraction_confidence = Math.max(0.08, extraction_confidence);
  }

  let criticalFilled = 0;
  if (parsed.document_type?.trim()) criticalFilled++;
  if (parsed.county?.trim()) criticalFilled++;
  if (parsed.state?.trim()) criticalFilled++;
  if (parsed.grantor?.trim() || parsed.lessor?.trim() || parsed.owner?.trim()) criticalFilled++;
  if (parsed.grantee?.trim() || parsed.lessee?.trim() || parsed.buyer?.trim()) criticalFilled++;
  if (parsed.legal_description?.trim()) criticalFilled++;

  const inferredSignalCount =
    Object.keys(inferred).length +
    Object.values(failsafeFlags).filter(Boolean).length +
    Object.values(emergencyFlags).filter(Boolean).length +
    Object.entries(finalFailsafeFlags).filter(([k, v]) => k !== "final_failsafe_applied" && v === true).length;

  let extraction_status = deriveExtractionStatus({
    textLen,
    overallConf: extraction_confidence,
    criticalFilled,
    inferredSignalCount,
  });

  if (emergencyFlags.forced_low_confidence_status) {
    extraction_status = extraction_status === "failed" ? "low_confidence" : extraction_status;
    if (extraction_status === "complete") extraction_status = "low_confidence";
  }

  if (extraction_status === "partial" && inferredSignalCount >= 5) {
    extraction_status = "low_confidence";
    logExtract("LOW_CONFIDENCE_INFERENCE", {
      reason: "mostly_inferred_partial_upgrade",
      inferredSignalCount,
    });
  }

  if (finalFailsafeFlags.final_failsafe_applied) {
    extraction_status = "low_confidence";
    logExtract("LOW_CONFIDENCE_INFERENCE", { reason: "final_structured_failsafe" });
  }

  logExtract("INFERENCE_APPLIED", { inferred_keys: Object.keys(inferred_fields), extraction_status });

  const combinedLenForFloor = combinedText.trim().length;
  const extraction_confidence_reported =
    combinedLenForFloor >= 20 ? Math.max(extraction_confidence, 0.25) : extraction_confidence;
  parsed.confidence_score = extraction_confidence_reported;
  parsed.extraction_status = extraction_status;

  const final_extracted_fields = snapshotFinalFields(parsed);

  logExtract("FINAL_EXTRACTED_FIELDS", {
    owner: parsed.owner,
    county: parsed.county,
    state: parsed.state,
    document_type: parsed.document_type,
  });
  logExtract("FINAL_EXTRACTION_STATUS", {
    extraction_status,
    extraction_confidence: extraction_confidence_reported,
    criticalFilled,
  });
  logExtract("CONFIDENCE_SUMMARY", {
    text_quality_confidence,
    ocr_quality_confidence: ocr_confidence,
    party_confidence,
    county_confidence,
    acreage_confidence,
    document_type_confidence,
    legal_description_confidence,
    extraction_confidence: extraction_confidence_reported,
  });

  const artifacts: ExtractionArtifacts = {
    raw_text: rawPdfText,
    raw_pdf_text: rawPdfText,
    ocr_text: ocrText,
    combined_text: combinedText,
    normalized_text: normalizedText,
    detected_document_type: detected_class,
    extracted_fields,
    inferred_fields,
    fallback_extracted_fields,
    final_extracted_fields,
    confidence_by_field,
    extraction_status,
    extraction_errors,
    text_quality_confidence,
    ocr_confidence,
    ocr_quality_confidence: ocr_confidence,
    party_confidence,
    county_confidence,
    acreage_confidence,
    document_type_confidence,
    legal_description_confidence,
    extraction_confidence: extraction_confidence_reported,
  };

  return { parsed, artifacts };
}
