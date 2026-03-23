/**
 * Multi-stage structured extraction: heuristics (C), OpenAI (D), inference (E), confidence + artifacts.
 */

import { estimateExtractedTextConfidence } from "./extracted-text-quality";
import { type ExtractionDocumentClass, documentClassToDisplayLabel } from "./extraction-normalize";
import {
  classifyDocumentFromKeywords,
  detectTexasContext,
  extractCountyFromLegalFragment,
  extractHeuristicFields,
  type HeuristicFieldResult,
} from "./heuristic-field-extraction";
import { parseLeaseFieldsWithOpenAi } from "./lease-fields-openai";
import { parseAcreageFromLegalDescription } from "./parse-acreage-from-legal";
import { type ParsedLeaseResult, normalizeParsedLeaseResult } from "./parsed-lease-result";

const EXTRACT_LOG = "[extract]";

export type ExtractionStatus = "complete" | "partial" | "low_confidence" | "failed";

export type ExtractionArtifacts = {
  raw_text: string;
  ocr_text: string | null;
  normalized_text: string;
  detected_document_type: string;
  extracted_fields: Record<string, unknown>;
  inferred_fields: Record<string, unknown>;
  confidence_by_field: Record<string, number>;
  extraction_status: ExtractionStatus;
  extraction_errors: string[];
  text_quality_confidence: number;
  ocr_confidence: number | null;
  party_confidence: number;
  county_confidence: number;
  acreage_confidence: number;
  document_type_confidence: number;
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
  };
}

function applyInference(
  p: ParsedLeaseResult,
  normalizedText: string,
  docCounty: string | null | undefined,
  docState: string | null | undefined
): { next: ParsedLeaseResult; inferred: Record<string, unknown> } {
  const inferred: Record<string, unknown> = {};
  const next = { ...p };

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
    } else if (docCounty?.trim()) {
      next.county = docCounty.trim();
      inferred.county = "document_metadata";
    }
  }

  if (!next.state?.trim()) {
    if (detectTexasContext(normalizedText) || (next.county && detectTexasContext(`${next.county} Texas`))) {
      next.state = "TX";
      inferred.state = "texas_context";
    } else if (docState?.trim()) {
      next.state = docState.trim();
      inferred.state = "document_metadata";
    }
  }

  if (!next.document_type?.trim()) {
    const kw = classifyDocumentFromKeywords(normalizedText);
    if (kw !== "unknown") {
      next.document_type = documentClassToDisplayLabel(kw);
      inferred.document_type = kw;
    }
  }

  if (next.acreage == null) {
    const fromLegal = parseAcreageFromLegalDescription(next.legal_description);
    if (fromLegal !== undefined) {
      next.acreage = fromLegal;
      inferred.acreage = "legal_description";
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
    (p.owner?.trim() ? 1 : 0);
  if (has >= 2) return 0.78;
  if (has === 1) return 0.52;
  return 0.12;
}

function deriveExtractionStatus(args: {
  textLen: number;
  overallConf: number;
  criticalFilled: number;
}): ExtractionStatus {
  if (args.textLen < 15) return "failed";
  if (args.overallConf < 0.28 && args.criticalFilled < 2) return "failed";
  if (args.overallConf < 0.38) return "low_confidence";
  if (args.criticalFilled >= 5 && args.overallConf >= 0.55) return "complete";
  return "partial";
}

/**
 * Full structured extraction: merge heuristics + optional LLM, inference pass, confidence + debug JSON.
 */
export async function runStructuredExtraction(args: RunStructuredExtractionArgs): Promise<StructuredExtractionResult> {
  const extraction_errors: string[] = [];
  const normalizedText = args.normalizedText ?? "";
  const rawPdfText = args.rawPdfText?.trim() ?? "";
  const ocrText = args.ocrText?.trim() ? args.ocrText.trim() : null;

  const text_quality_confidence = estimateExtractedTextConfidence(normalizedText, {
    numpages: args.pdfNumPages ?? 0,
  });
  const ocr_confidence =
    args.ocrMeanConfidence0to100 != null && Number.isFinite(args.ocrMeanConfidence0to100)
      ? Math.max(0, Math.min(1, args.ocrMeanConfidence0to100 / 100))
      : null;

  logExtract("HEURISTIC_FIELDS", { textLen: normalizedText.length });
  const heur = extractHeuristicFields(normalizedText, { ocrText, rawPdfText: rawPdfText || null });
  const detected_class: ExtractionDocumentClass = heur.detected_class;

  let llm: ParsedLeaseResult | null = null;
  if (!args.skipOpenAi && process.env.OPENAI_API_KEY) {
    logExtract("LLM_NORMALIZATION_START", { textLen: normalizedText.length });
    try {
      llm = await parseLeaseFieldsWithOpenAi(normalizedText, { model: args.openAiModel });
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
  const mergedPre: ParsedLeaseResult = normalizeParsedLeaseResult(
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
      document_type: mergeStr(llm?.document_type, hBase.document_type),
      confidence_score: llm?.confidence_score ?? 0.35,
      parties: llm?.parties ?? null,
      owner: hBase.owner ?? null,
      buyer: hBase.buyer ?? null,
      acreage: hBase.acreage ?? null,
    },
    normalizedText
  );

  const { next: afterInference, inferred } = applyInference(
    mergedPre,
    normalizedText,
    args.docCounty,
    args.docState
  );
  const parsed = normalizeParsedLeaseResult(afterInference, normalizedText);

  const extracted_fields: Record<string, unknown> = {
    ...hBase,
    detected_class,
  };

  const confidence_by_field: Record<string, number> = {
    lessor: fieldConfidence(parsed.lessor, llm?.lessor ? "llm" : parsed.lessor ? "heuristic" : "none"),
    lessee: fieldConfidence(parsed.lessee, llm?.lessee ? "llm" : parsed.lessee ? "heuristic" : "none"),
    grantor: fieldConfidence(parsed.grantor, llm?.grantor ? "llm" : parsed.grantor ? "heuristic" : "none"),
    grantee: fieldConfidence(parsed.grantee, llm?.grantee ? "llm" : parsed.grantee ? "heuristic" : "none"),
    county: fieldConfidence(
      parsed.county,
      llm?.county ? "llm" : heur.county ? "heuristic" : inferred.county ? "inferred" : "none"
    ),
    state: fieldConfidence(
      parsed.state,
      llm?.state ? "llm" : heur.state ? "heuristic" : inferred.state ? "inferred" : "none"
    ),
    legal_description: fieldConfidence(
      parsed.legal_description,
      llm?.legal_description ? "llm" : heur.legal_description ? "heuristic" : "none"
    ),
    document_type: fieldConfidence(
      parsed.document_type,
      llm?.document_type ? "llm" : heur.document_type ? "heuristic" : inferred.document_type ? "inferred" : "none"
    ),
    owner: fieldConfidence(parsed.owner, parsed.owner ? "inferred" : "none"),
    effective_date: fieldConfidence(parsed.effective_date, llm?.effective_date ? "llm" : "heuristic"),
    recording_date: fieldConfidence(parsed.recording_date, llm?.recording_date ? "llm" : "heuristic"),
    royalty_rate: fieldConfidence(parsed.royalty_rate, llm?.royalty_rate ? "llm" : "heuristic"),
    term_length: fieldConfidence(parsed.term_length, llm?.term_length ? "llm" : "heuristic"),
  };

  const party_confidence = computePartyConfidence(parsed);
  const county_confidence = confidence_by_field.county ?? 0;
  const acreage_confidence =
    parsed.acreage != null && parsed.acreage > 0
      ? inferred.acreage
        ? 0.45
        : heur.acreage
          ? 0.55
          : 0.5
      : 0.1;
  const document_type_confidence =
    detected_class !== "unknown" ? 0.72 : llm?.document_type ? 0.55 : 0.25;

  const weights = {
    party: 0.22,
    county: 0.18,
    state: 0.08,
    legal: 0.12,
    docType: 0.12,
    acreage: 0.08,
    text: 0.2,
  };
  const legalC = confidence_by_field.legal_description ?? 0;
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

  let criticalFilled = 0;
  if (parsed.document_type?.trim()) criticalFilled++;
  if (parsed.county?.trim()) criticalFilled++;
  if (parsed.state?.trim()) criticalFilled++;
  if (parsed.grantor?.trim() || parsed.lessor?.trim() || parsed.owner?.trim()) criticalFilled++;
  if (parsed.grantee?.trim() || parsed.lessee?.trim() || parsed.buyer?.trim()) criticalFilled++;
  if (parsed.legal_description?.trim()) criticalFilled++;

  const extraction_status = deriveExtractionStatus({
    textLen: normalizedText.trim().length,
    overallConf: extraction_confidence,
    criticalFilled,
  });

  logExtract("INFERENCE_APPLIED", { inferred_keys: Object.keys(inferred), extraction_status });

  logExtract("EXTRACTION_STATUS", { extraction_status, extraction_confidence, criticalFilled });
  logExtract("CONFIDENCE_SUMMARY", {
    text_quality_confidence,
    ocr_confidence,
    party_confidence,
    county_confidence,
    acreage_confidence,
    document_type_confidence,
    extraction_confidence,
  });

  const artifacts: ExtractionArtifacts = {
    raw_text: rawPdfText,
    ocr_text: ocrText,
    normalized_text: normalizedText,
    detected_document_type: detected_class,
    extracted_fields,
    inferred_fields: inferred,
    confidence_by_field,
    extraction_status,
    extraction_errors,
    text_quality_confidence,
    ocr_confidence,
    party_confidence,
    county_confidence,
    acreage_confidence,
    document_type_confidence,
    extraction_confidence,
  };

  parsed.confidence_score = extraction_confidence;
  parsed.extraction_status = extraction_status;

  return { parsed, artifacts };
}
