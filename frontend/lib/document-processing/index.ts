/**
 * Document processing pipeline.
 * Extracts text from PDF (pdf-parse) and CSV (raw text) and returns it for storage in document_extractions.
 * When extracted_text exists, AI parsing can fill structured lease fields.
 */

import OpenAI from "openai";
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
  calendarMonthsSince,
  dealGradeFullLabelFromScore,
  dealLetterGradeFromScore,
  getGradeFromScore,
  isTexasDealContext,
  monthsSinceDate,
  parseDocumentDate,
  type DealScoreResult,
  type DealScoreInput,
} from "./deal-score";

export { parseAcreageFromLegalDescription } from "./parse-acreage-from-legal";

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
  console.log("[extractTextFromPdf] PDF_PARSE_INPUT", {
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
  } catch (err) {
    primaryParseError = err instanceof Error ? err.message : String(err);
    console.warn("[extractTextFromPdf] pdf-parse (v1) failed; will try OCR if applicable", {
      message: primaryParseError,
      sizeBytes,
    });
  }

  const textLayerConfidence = estimateExtractedTextConfidence(primaryText, { numpages });
  const lowTextLayerQuality =
    primaryText.length > 0 && textLayerConfidence < TEXT_LAYER_CONFIDENCE_OCR_THRESHOLD;
  const primaryEmpty = !primaryText;
  const shouldRunOcr = primaryEmpty || lowTextLayerQuality;

  let finalText = "";
  let ocrUsed = false;
  let ocrMeta: Awaited<ReturnType<typeof ocrPdfWithPopplerAndTesseract>> | null = null;
  let ocrAdopted = false;
  /** Why OCR ran: empty embedded text or low heuristic text-layer confidence. */
  let ocrTriggerReason: "none" | "empty_primary" | "low_text_layer_confidence" = "none";
  if (primaryEmpty) ocrTriggerReason = "empty_primary";
  else if (lowTextLayerQuality) ocrTriggerReason = "low_text_layer_confidence";

  if (shouldRunOcr) {
    console.log("[extractTextFromPdf] Starting OCR (empty or low text-layer confidence)", {
      sizeBytes,
      primaryEmpty,
      textLayerConfidence,
      numpages,
      threshold: TEXT_LAYER_CONFIDENCE_OCR_THRESHOLD,
    });
    ocrMeta = await ocrPdfWithPopplerAndTesseract(buffer);
    const ocrRaw = (ocrMeta.text ?? "").trim();
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

/** Result of AI parsing: structured lease fields and a confidence score (0–1). */
export type ParsedLeaseResult = {
  lessor: string | null;
  lessee: string | null;
  county: string | null;
  state: string | null;
  legal_description: string | null;
  effective_date: string | null;
  recording_date: string | null;
  royalty_rate: string | null;
  term_length: string | null;
  /** Best-effort document kind from the text, e.g. "Mineral Deed", "Oil and Gas Lease". */
  document_type: string | null;
  confidence_score: number;
};

const LEASE_PARSE_SYSTEM = `You are a parser for mineral lease and deed documents. Given extracted text from a document, output a JSON object with exactly these keys (use null for any value you cannot find):
- lessor (string or null): party granting the lease/mineral rights
- lessee (string or null): party receiving the lease/mineral rights
- county (string or null): county name
- state (string or null): state name or abbreviation
- legal_description (string or null): legal land description
- effective_date (string or null): effective date of the lease (any clear date format)
- recording_date (string or null): date recorded
- royalty_rate (string or null): royalty percentage or fraction, e.g. "1/8" or "12.5%"
- term_length (string or null): primary term or duration
- document_type (string or null): the kind of instrument, e.g. "Mineral Deed", "Warranty Deed", "Oil and Gas Lease" — use null if unclear
- confidence_score (number): your confidence in the overall extraction, between 0 and 1 (e.g. 0.85).

The text may be from OCR or a weak PDF text layer: skip isolated garbage lines, infer words split across line breaks, and handle common OCR confusions (0 vs O, 1 vs l vs I, rn vs m) when resolving names, counties, states, and legal descriptions.

Return only valid JSON, no markdown or extra text.`;

function safeParseJsonObject(content: string, stepName: string): Record<string, unknown> {
  assertString(content, stepName);

  // OpenAI is prompted for pure JSON, but we defensively handle cases where the payload
  // includes leading/trailing text (e.g. code fences) so malformed AI output doesn't crash.
  try {
    const parsed = JSON.parse(content) as unknown;
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Parsed JSON was not an object.");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const sliced = content.slice(start, end + 1);
      const parsed2 = JSON.parse(sliced) as unknown;
      if (parsed2 == null || typeof parsed2 !== "object" || Array.isArray(parsed2)) {
        throw new Error("Sliced JSON was not an object.");
      }
      return parsed2 as Record<string, unknown>;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${stepName}: OpenAI response was not valid JSON: ${message}`);
  }
}

/**
 * Parses extracted text into structured lease fields using an AI model.
 * Throws if OPENAI_API_KEY is missing, API call fails, or response is empty/malformed.
 */
export async function parseLeaseFieldsFromText(
  extractedText: string
): Promise<ParsedLeaseResult> {
  assertString(extractedText, "OPENAI_CALL_START");
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const msg = "OPENAI_API_KEY is not set; cannot parse lease fields.";
    console.error("[parseLeaseFieldsFromText]", msg);
    throw new Error(`OPENAI_CALL_START: ${msg}`);
  }
  const trimmedInput = extractedText.trim();
  const normalizedForModel =
    trimmedInput.length === 0
      ? ""
      : (() => {
          const cleaned = cleanExtractedDocumentText(extractedText);
          return cleaned.length > 0 ? cleaned : trimmedInput;
        })();

  if (normalizedForModel === "") {
    console.warn("[parseLeaseFieldsFromText] Empty extracted text; returning nulls with confidence 0.");
    return {
      lessor: null,
      lessee: null,
      county: null,
      state: null,
      legal_description: null,
      effective_date: null,
      recording_date: null,
      royalty_rate: null,
      term_length: null,
      document_type: null,
      confidence_score: 0,
    };
  }

  const client = new OpenAI({ apiKey });

  let completion: unknown;
  try {
    completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: LEASE_PARSE_SYSTEM },
        {
          role: "user",
          content: `Extract lease fields from this document text:\n\n${normalizedForModel.slice(0, 12000)}`,
        },
      ],
      response_format: { type: "json_object" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`OPENAI_CALL_START: OpenAI request failed: ${msg}`);
  }

  assertPlainObject(completion, "OPENAI_CALL_START");

  const choices: unknown = (completion as any).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error(`OPENAI_CALL_START: OpenAI returned no choices (got ${describeValue(choices)}).`);
  }

  const firstChoice = choices[0] as unknown;
  assertPlainObject(firstChoice, "OPENAI_CALL_START");

  const message = (firstChoice as any).message;
  const contentValue = isPlainObject(message) ? (message as any).content : undefined;
  const content = typeof contentValue === "string" ? contentValue.trim() : undefined;
  if (!content) {
    const msg = "OpenAI returned no content in completion choices.";
    console.error("[parseLeaseFieldsFromText]", msg, {
      choicesLength: Array.isArray(choices) ? choices.length : 0,
      finishReason: isPlainObject(firstChoice) ? (firstChoice as any).finish_reason : undefined,
    });
    throw new Error(msg);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = safeParseJsonObject(content, "OPENAI_CALL_START");
  } catch (parseErr) {
    const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
    console.error("[parseLeaseFieldsFromText] Invalid/malformed JSON in OpenAI response", {
      error: msg,
      contentPreview: content.slice(0, 300),
    });
    throw parseErr instanceof Error ? parseErr : new Error(String(parseErr));
  }

  if (parsed == null || typeof parsed !== "object") {
    console.error("[parseLeaseFieldsFromText] Parsed result is not an object", { parsed });
    throw new Error("OpenAI response parsed to non-object.");
  }

  const num = (v: unknown): number => {
    if (typeof v === "number" && v >= 0 && v <= 1) return v;
    if (typeof v === "string") {
      const n = parseFloat(v);
      if (!Number.isNaN(n) && n >= 0 && n <= 1) return n;
    }
    return 0;
  };
  const str = (v: unknown): string | null =>
    v != null && typeof v === "string" && v.trim() !== "" ? v.trim() : null;

  return {
    lessor: str(parsed.lessor),
    lessee: str(parsed.lessee),
    county: str(parsed.county),
    state: str(parsed.state),
    legal_description: str(parsed.legal_description),
    effective_date: str(parsed.effective_date),
    recording_date: str(parsed.recording_date),
    royalty_rate: str(parsed.royalty_rate),
    term_length: str(parsed.term_length),
    document_type: str(parsed.document_type),
    confidence_score: num(parsed.confidence_score),
  };
}
