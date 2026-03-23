/**
 * Document processing pipeline.
 * Extracts text from PDF (pdf-parse) and CSV (raw text) and returns it for storage in document_extractions.
 * When extracted_text exists, AI parsing can fill structured lease fields.
 */

import {
  cleanExtractedDocumentText,
  estimateExtractedTextConfidence,
} from "./extracted-text-quality";
import { ocrPdfWithPopplerAndTesseract } from "./pdf-ocr";

/** Below this text-layer heuristic, run Poppler + Tesseract and prefer OCR output when substantial. */
const TEXT_LAYER_CONFIDENCE_OCR_THRESHOLD = 0.7;
/** When replacing low-confidence text layer, require at least this many OCR chars. */
const MIN_OCR_CHARS_TO_ADOPT = 25;
/** When the PDF text layer is empty, accept shorter OCR output as the only source. */
const MIN_OCR_CHARS_WHEN_PRIMARY_EMPTY = 8;

export {
  calculateDealScore,
  calculateIntelScore,
  calculateLeadScore,
  calendarMonthsSince,
  classifyDealScoreType,
  dealGradeFullLabelFromScore,
  dealLetterGradeFromScore,
  getGradeFromScore,
  isTexasDealContext,
  monthsSinceDate,
  parseDocumentDate,
  type DealScoreKind,
  type DealScoreResult,
  type DealScoreInput,
} from "./deal-score";

export { parseAcreageFromLegalDescription } from "./parse-acreage-from-legal";

export {
  normalizeDocumentTypeLabel,
  normalizePartyName,
  normalizeToDocumentClass,
  documentClassToDisplayLabel,
  type ExtractionDocumentClass,
} from "./extraction-normalize";

export {
  type NormalizedPartyEntry,
  type ParsedLeaseResult,
  normalizeParsedLeaseResult,
  buildNormalizedPartiesForDealScoreInput,
} from "./parsed-lease-result";

import { parseLeaseFieldsWithOpenAi, safeParseJsonObject } from "./lease-fields-openai";
import type { ParsedLeaseResult } from "./parsed-lease-result";
export { parseLeaseFieldsWithOpenAi, safeParseJsonObject };

export {
  runStructuredExtraction,
  type StructuredExtractionResult,
  type ExtractionArtifacts,
  type ExtractionStatus,
  type RunStructuredExtractionArgs,
} from "./extraction-pipeline";

export {
  extractHeuristicFields,
  extractGrantorGranteeFromHeadings,
  extractLessorLesseeFromHeadings,
  classifyDocumentFromKeywords,
} from "./heuristic-field-extraction";

export type DocumentProcessingResult =
  | { success: true; extractedText: string; extractionMeta?: Record<string, unknown> }
  | { success: false; error: string; extractionMeta?: Record<string, unknown> };

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertString(value: unknown, stepName: string): asserts value is string {
  if (typeof value !== "string") {
    throw new Error(`${stepName}: expected a string but got ${describeValue(value)}.`);
  }
}

function assertBuffer(value: unknown, stepName: string): asserts value is Buffer {
  if (!Buffer.isBuffer(value)) {
    throw new Error(`${stepName}: expected a Buffer but got ${describeValue(value)}.`);
  }
}

function assertPlainObject(value: unknown, stepName: string): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new Error(`${stepName}: expected a plain object but got ${describeValue(value)}.`);
  }
}

/** Shape of extracted data; real OCR/AI parser can fill more fields on the extraction row. */
export type ExtractionFields = {
  extracted_text?: string | null;
  lessor?: string | null;
  lessee?: string | null;
  county?: string | null;
  state?: string | null;
  legal_description?: string | null;
  effective_date?: string | null;
  recording_date?: string | null;
  royalty_rate?: string | null;
  term_length?: string | null;
  confidence_score?: number | null;
};

export type ProcessDocumentParams = {
  /** File contents from Supabase Storage. */
  fileBuffer: Buffer;
  /** Original file name (used to detect type by extension). */
  fileName: string | null;
};

function getExtension(fileName: string | null): string {
  if (!fileName || !fileName.includes(".")) return "";
  const parts = fileName.trim().toLowerCase().split(".");
  return parts[parts.length - 1] ?? "";
}

/**
 * Extracts text from the file buffer.
 * - PDF: pdf-parse v1 (embedded pdf.js 1.x, Node-safe) then OCR fallback (Poppler + tesseract.js).
 * - CSV: reads buffer as UTF-8 text.
 * - Other types: returns error.
 */
export async function processDocumentContent(
  params: ProcessDocumentParams
): Promise<DocumentProcessingResult> {
  if (!params || typeof params !== "object") {
    return { success: false, error: "PROCESS_DOCUMENT_CONTENT: params must be an object." };
  }
  const { fileBuffer, fileName } = params as ProcessDocumentParams;
  assertBuffer(fileBuffer, "FILE_BUFFER_READY");
  if (!(fileName === null || typeof fileName === "string")) {
    return {
      success: false,
      error: `PROCESS_DOCUMENT_CONTENT: fileName must be a string or null, got ${describeValue(fileName)}.`,
    };
  }
  const ext = getExtension(fileName);

  if (ext === "pdf") {
    return extractTextFromPdf(fileBuffer);
  }

  if (ext === "csv") {
    return extractTextFromCsv(fileBuffer);
  }

  if (ext === "txt") {
    return extractTextFromTxt(fileBuffer);
  }

  return {
    success: false,
    error: `Unsupported file type: ${ext || "unknown"}. Only PDF, CSV, and TXT are supported.`,
  };
}

async function extractTextFromPdf(buffer: Buffer): Promise<DocumentProcessingResult> {
  assertBuffer(buffer, "PDF_TEXT_EXTRACT_START");

  const header4Ascii = buffer.slice(0, 4).toString("ascii");
  const first10Hex = buffer.slice(0, 10).toString("hex");
  const sizeBytes = buffer.length;
  const isPdfHeaderValid = header4Ascii === "%PDF";
  if (header4Ascii !== "%PDF") {
    console.error("[extractTextFromPdf] Invalid PDF header; refusing to parse", {
      header4Ascii,
      sizeBytes,
      first10Hex,
    });
    return {
      success: false,
      error: `PDF_TEXT_EXTRACT_START: File does not start with %PDF (header='${header4Ascii}'). sizeBytes=${sizeBytes} first10Hex=${first10Hex}`,
    };
  }

  const input: unknown = buffer;
  const inputByteLength = Buffer.isBuffer(input) ? input.byteLength : (input as { byteLength?: number })?.byteLength;
  const inputLength = Buffer.isBuffer(input) ? undefined : (input as { length?: number })?.length;
  console.log("[extract] PDF_TEXT_START", {
    typeofInput: typeof input,
    Buffer_isBuffer: Buffer.isBuffer(input),
    byteLength: inputByteLength,
    length: inputLength,
  });

  let primaryText = "";
  let primaryParseError: string | null = null;
  let numpages = 0;

  try {
    const pdfParseModule = await import("pdf-parse");
    const pdfParseUnknown: unknown =
      (pdfParseModule as { default?: unknown }).default ?? pdfParseModule;
    if (typeof pdfParseUnknown !== "function") {
      throw new Error("pdf-parse: expected a function export (v1 API).");
    }
    const pdfParse = pdfParseUnknown as (
      data: Buffer,
      options?: { max?: number }
    ) => Promise<{ text?: string; numpages?: number }>;
    const data = await pdfParse(buffer, { max: 0 });
    primaryText = typeof data?.text === "string" ? data.text.trim() : "";
    numpages = typeof data?.numpages === "number" && data.numpages >= 0 ? data.numpages : 0;
    console.log("[extract] PDF_TEXT_SUCCESS", { primaryTextLength: primaryText.length, numpages });
  } catch (err) {
    primaryParseError = err instanceof Error ? err.message : String(err);
    console.warn("[extract] PDF_TEXT_START", {
      message: primaryParseError,
      sizeBytes,
      note: "pdf-parse failed; OCR will run if applicable",
    });
  }

  const textLayerConfidence = estimateExtractedTextConfidence(primaryText, { numpages });
  const lowTextLayerQuality =
    primaryText.length > 0 && textLayerConfidence < TEXT_LAYER_CONFIDENCE_OCR_THRESHOLD;
  const primaryEmpty = !primaryText;
  const shouldRunOcr = primaryEmpty || lowTextLayerQuality || !!primaryParseError;

  let finalText = "";
  let ocrUsed = false;
  let ocrMeta: Awaited<ReturnType<typeof ocrPdfWithPopplerAndTesseract>> | null = null;
  let ocrAdopted = false;
  let ocrRawFull = "";
  /** Why OCR ran: empty embedded text, low text-layer confidence, or PDF parse error. */
  let ocrTriggerReason: "none" | "empty_primary" | "low_text_layer_confidence" | "primary_parse_error" =
    "none";
  if (primaryParseError) ocrTriggerReason = "primary_parse_error";
  else if (primaryEmpty) ocrTriggerReason = "empty_primary";
  else if (lowTextLayerQuality) ocrTriggerReason = "low_text_layer_confidence";

  if (shouldRunOcr) {
    console.log("[extract] OCR_START", {
      sizeBytes,
      primaryEmpty,
      primaryParseError: !!primaryParseError,
      textLayerConfidence,
      numpages,
      threshold: TEXT_LAYER_CONFIDENCE_OCR_THRESHOLD,
    });
    ocrMeta = await ocrPdfWithPopplerAndTesseract(buffer);
    const ocrRaw = (ocrMeta.text ?? "").trim();
    ocrRawFull = ocrRaw;
    console.log("[extract] OCR_SUCCESS", {
      ocrRawLength: ocrRaw.length,
      ocrPageCount: ocrMeta.pageCountRasterized,
      ocrMeanConfidence: ocrMeta.meanConfidence ?? null,
      ocrSkippedReason: ocrMeta.skippedReason ?? null,
    });
    const ocrMean = ocrMeta.meanConfidence;
    const preferOcrOverLowQualityPrimary =
      ocrRaw.length >= MIN_OCR_CHARS_TO_ADOPT &&
      !(
        ocrMean != null &&
        ocrMean < 12 &&
        primaryText.length > ocrRaw.length * 2.5
      );

    if (ocrRaw.length > 0) {
      if (primaryEmpty) {
        if (ocrRaw.length >= MIN_OCR_CHARS_WHEN_PRIMARY_EMPTY) {
          finalText = cleanExtractedDocumentText(ocrRaw);
          ocrUsed = true;
          ocrAdopted = true;
        } else {
          finalText = "";
        }
      } else if (preferOcrOverLowQualityPrimary) {
        finalText = cleanExtractedDocumentText(ocrRaw);
        ocrUsed = true;
        ocrAdopted = true;
      } else {
        finalText = cleanExtractedDocumentText(primaryText);
      }
    } else if (primaryText) {
      finalText = cleanExtractedDocumentText(primaryText);
    } else {
      finalText = "";
    }

    console.log("[extractTextFromPdf] OCR_FALLBACK_RESULT", {
      ocrUsed,
      ocrAdopted,
      ocrTriggerReason,
      ocrPageCount: ocrMeta.pageCountRasterized,
      ocrMeanConfidence: ocrMeta.meanConfidence ?? null,
      ocrSkippedReason: ocrMeta.skippedReason,
      ocrErrorMessage: ocrMeta.errorMessage,
      ocrRawLength: ocrRaw.length,
      finalTextLength: finalText.length,
    });
  } else {
    finalText = cleanExtractedDocumentText(primaryText);
  }

  const extractionMeta: Record<string, unknown> = {
    pdfParser: "pdf-parse-v1",
    numpages,
    primaryTextLength: primaryText.length,
    raw_pdf_text: primaryText,
    ocr_text: ocrRawFull || null,
    textLayerConfidence,
    textLayerConfidenceOcrThreshold: TEXT_LAYER_CONFIDENCE_OCR_THRESHOLD,
    primaryParseError,
    ocrUsed,
    ocrAdopted,
    ocrTriggerReason: shouldRunOcr ? ocrTriggerReason : "none",
    ocrEngine: ocrMeta?.engine ?? null,
    ocrPageCount: ocrMeta?.pageCountRasterized ?? 0,
    ocrMeanConfidence: ocrMeta?.meanConfidence ?? null,
    ocrSkippedReason: ocrMeta?.skippedReason ?? null,
    ocrErrorMessage: ocrMeta?.errorMessage ?? null,
  };

  console.log("[extractTextFromPdf] RAW_EXTRACTED_TEXT", {
    sizeBytes,
    finalTextLength: finalText.length,
    preview: finalText.slice(0, 500),
    ocrUsed,
    primaryParseError,
  });

  if (!finalText && primaryParseError) {
    return {
      success: false,
      error: `PDF_TEXT_EXTRACT_START: text extraction failed and OCR did not yield text. primaryError=${primaryParseError}${
        ocrMeta?.skippedReason ? ` ocrSkipped=${ocrMeta.skippedReason}` : ""
      }${ocrMeta?.errorMessage ? ` ocrError=${ocrMeta.errorMessage}` : ""} sizeBytes=${sizeBytes} first10Hex=${first10Hex}`,
      extractionMeta,
    };
  }

  console.log("[extractTextFromPdf] PDF_TEXT_EXTRACT_SUCCESS", {
    sizeBytes,
    textLength: finalText.length,
    ocrUsed,
    isPdfHeaderValid,
  });

  return { success: true, extractedText: finalText, extractionMeta };
}

function extractTextFromCsv(buffer: Buffer): DocumentProcessingResult {
  try {
    const text = buffer.toString("utf-8").trim();
    return { success: true, extractedText: text || "(Empty CSV.)" };
  } catch (err) {
    const message = err instanceof Error ? err.message : "CSV read failed.";
    return { success: false, error: message };
  }
}

function extractTextFromTxt(buffer: Buffer): DocumentProcessingResult {
  try {
    const text = buffer.toString("utf-8").trim();
    return { success: true, extractedText: text || "(Empty TXT.)" };
  } catch (err) {
    const message = err instanceof Error ? err.message : "TXT read failed.";
    return { success: false, error: message };
  }
}

/**
 * Back-compat: OpenAI-only structuring (throws without `OPENAI_API_KEY`).
 * The document route uses {@link runStructuredExtraction} for the full multi-stage pipeline.
 */
export async function parseLeaseFieldsFromText(extractedText: string): Promise<ParsedLeaseResult> {
  assertString(extractedText, "OPENAI_CALL_START");
  return parseLeaseFieldsWithOpenAi(extractedText);
}
