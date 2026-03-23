import { NextResponse } from "next/server";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";
import {
  processDocumentContent,
  parseLeaseFieldsFromText,
  calculateDealScore,
  parseAcreageFromLegalDescription,
  calendarMonthsSince,
  parseDocumentDate,
  type DealScoreResult,
} from "@/lib/document-processing";
import type { SupabaseClient } from "@supabase/supabase-js";
import { logAlertIfDealMatches } from "@/lib/alerts/check-on-deal-processed";

const LOG_PREFIX = "[process-document]";
const BUCKET_NAME = "documents";

export const runtime = "nodejs";

export const dynamic = "force-dynamic";

/** Allow PDF extract + OCR + OpenAI to finish on hosts that honor this (e.g. Vercel). */
export const maxDuration = 300;

const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";

function getFileExtension(fileName: string | null): string {
  if (!fileName || !fileName.includes(".")) return "unknown";
  const parts = fileName.trim().toLowerCase().split(".");
  return parts[parts.length - 1] ?? "unknown";
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertPlainObject(value: unknown, stepName: string): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new Error(`${stepName}: expected a plain object but got ${describeValue(value)}.`);
  }
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

/** Matches deal-score `readNonEmptyString` for lease_status — values the scorer will actually use. */
function hasUsableLeaseStatusForDealScore(input: Record<string, unknown>): boolean {
  const v = input.lease_status;
  if (v == null) return false;
  if (typeof v === "string" && v.trim() !== "") return true;
  return false;
}

/** True when the label clearly refers to a mineral deed (substring, case-insensitive). */
function documentTypeIncludesMineralDeed(documentType: string | null | undefined): boolean {
  if (typeof documentType !== "string") return false;
  return documentType.toLowerCase().includes("mineral deed");
}

/** Phrase search on raw extracted text as specified for scoring fallback. */
function extractedTextContainsMineralDeedPhrase(extractedText: string): boolean {
  return extractedText.includes("MINERAL DEED");
}

function readNonEmptyStringForRecencyPreview(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") {
    const t = value.trim();
    if (t) return t;
  }
  return undefined;
}

function readFiniteNumberForRecencyPreview(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = parseFloat(value.trim());
    if (!Number.isNaN(n) && Number.isFinite(n)) return n;
  }
  return undefined;
}

/** Mirrors deal-score recency derivation for debug logging only. */
function previewRecencyMonthsForDealScoreInput(input: Record<string, unknown>): number | null {
  const recordingDateStr = readNonEmptyStringForRecencyPreview(input.recording_date);
  const effectiveDateStr = readNonEmptyStringForRecencyPreview(input.effective_date);
  let recencyMonths = readFiniteNumberForRecencyPreview(input.recency_months);
  const refDate =
    (recordingDateStr && parseDocumentDate(recordingDateStr)) ??
    (effectiveDateStr && parseDocumentDate(effectiveDateStr)) ??
    null;
  if (refDate) {
    recencyMonths = calendarMonthsSince(refDate, new Date());
  }
  if (recencyMonths === undefined) return null;
  return recencyMonths;
}

function mineralDeedSignalsForLeaseFallback(args: {
  metadataDocumentType: string | null | undefined;
  extractedText: string;
  parsedDocumentType: string | null | undefined;
}): string[] {
  const signals: string[] = [];
  if (documentTypeIncludesMineralDeed(args.metadataDocumentType)) {
    const raw = typeof args.metadataDocumentType === "string" ? args.metadataDocumentType.trim() : "";
    signals.push(raw ? `metadata_document_type:${raw}` : "metadata_document_type");
  }
  if (extractedTextContainsMineralDeedPhrase(args.extractedText)) {
    signals.push("extracted_text:MINERAL DEED");
  }
  if (documentTypeIncludesMineralDeed(args.parsedDocumentType)) {
    const raw = typeof args.parsedDocumentType === "string" ? args.parsedDocumentType.trim() : "";
    signals.push(raw ? `parsed_document_type:${raw}` : "parsed_document_type");
  }
  return signals;
}

function isMissingColumnError(message: string, columnName: string): boolean {
  const escaped = columnName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const appearsInMessage = new RegExp(`\\b${escaped}\\b`, "i").test(message);
  if (!appearsInMessage) return false;

  // Postgres errors look like: `column "...“ of relation ... does not exist`
  if (/does not exist/i.test(message)) return true;

  // Supabase schema cache errors look like:
  // "Could not find the 'confidence' column of 'document_extractions' in the schema cache"
  if (/schema cache/i.test(message) && /could not find/i.test(message)) return true;

  return /could not find/i.test(message) && /column/i.test(message);
}

function isMissingOnConflictUniqueConstraintError(message: string): boolean {
  // Postgres error when doing `ON CONFLICT (some_column)` without a matching unique index/constraint.
  return /no unique or exclusion constraint matching the ON CONFLICT specification/i.test(message);
}

async function updateDocumentFields(
  supabase: SupabaseClient,
  documentId: string,
  payload: Record<string, unknown>
): Promise<{ error: any | null }> {
  let error: any | null = null;
  try {
    const res = await supabase.from("documents").update(payload).eq("id", documentId);
    error = res.error;
  } catch (err) {
    error = err;
  }
  if (!error) return { error: null };

  const msg = error.message ?? String(error);

  // Retry by stripping only the fields that are reported missing.
  const candidates = ["error_message", "completed_at", "processed_at"];
  const missingKeys = candidates.filter((k) => isMissingColumnError(msg, k));
  if (missingKeys.length === 0) return { error };

  const reducedPayload: Record<string, unknown> = { ...payload };
  for (const k of missingKeys) {
    delete reducedPayload[k];
  }

  let retryError: any | null = null;
  try {
    const res = await supabase.from("documents").update(reducedPayload).eq("id", documentId);
    retryError = res.error;
  } catch (err) {
    retryError = err;
  }
  return { error: retryError ?? null };
}

async function markDocumentFailed(
  supabase: SupabaseClient,
  documentId: string,
  errorMessage: string
): Promise<void> {
  const completedAt = new Date().toISOString();
  const { error } = await updateDocumentFields(supabase, documentId, {
    status: "failed",
    error_message: errorMessage,
    completed_at: completedAt,
    processed_at: completedAt,
  });
  if (error) {
    console.error(`${LOG_PREFIX} Failed to update document status to failed:`, error.message);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  let documentId: string | null = null;
  let supabase: SupabaseClient | null = null;
  let failureStep = "PROCESS_START";
  let fileNameForLogs: string | null = null;
  let fileExtensionForLogs: string | null = null;
  const isDev = process.env.NODE_ENV !== "production";
  const debug: Record<string, unknown> = {
    bucket: BUCKET_NAME,
    failureStep,
  };
  const respond = (status: number, payload: Record<string, unknown>) => {
    if (isDev && (payload as any).ok === false) {
      return NextResponse.json(
        {
          ok: false,
          step: (payload as any).step ?? failureStep,
          error: (payload as any).error ?? "Unknown error",
          step_failed: (payload as any).step_failed ?? (payload as any).step ?? failureStep,
          error_message: (payload as any).error_message ?? (payload as any).error ?? "Unknown error",
          stack: (payload as any).stack ?? null,
          debug,
        },
        { status }
      );
    }
    if (isDev) return NextResponse.json({ ...payload, debug }, { status });
    return NextResponse.json(payload, { status });
  };

  const okFalse = (step_failed: string, error_message: string, extra?: Record<string, unknown>) => {
    return respond(200, {
      ok: false,
      step_failed,
      error_message,
      ...(extra ?? {}),
    });
  };

  const log = (event: string, payload?: Record<string, unknown>) => {
    console.log(`${LOG_PREFIX} ${event}`, {
      documentId,
      fileName: fileNameForLogs,
      fileExtension: fileExtensionForLogs,
      ...(payload ?? {}),
    });
  };

  const logCatchBlock = (err: unknown, stepForLog: string) => {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    console.error(`${LOG_PREFIX} ${stepForLog}`, {
      documentId,
      fileName: fileNameForLogs,
      fileExtension: fileExtensionForLogs,
      step_failed: stepForLog,
      error_message: errorMessage,
      stack,
    });
  };

  try {
    const resolvedParams = await params;
    documentId = resolvedParams.id ?? null;
    debug.documentId = documentId;

    log("PROCESS_START");

    let optionalDealScoreInput: Record<string, unknown> = {};
    let dealScoreResult: DealScoreResult | null = null;
    let dealAcreageForAlerts: number | null | undefined = undefined;
    try {
      const contentType = request.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        const body: unknown = await request.json();
        if (isPlainObject(body) && body.deal_score_input != null && isPlainObject(body.deal_score_input)) {
          optionalDealScoreInput = body.deal_score_input as Record<string, unknown>;
        }
      }
    } catch {
      // No JSON body or invalid JSON — scoring uses parsed dates / defaults only.
    }

    if (!documentId) {
      console.error(`${LOG_PREFIX} Step 0: Missing document ID`);
      return respond(400, { ok: false, step: "params", error: "Document ID is required." });
    }

    try {
      failureStep = "create_supabase_client";
      debug.failureStep = failureStep;
      log("CREATE_SUPABASE_CLIENT_START");
      supabase = await createSupabaseFromRouteRequest(request);
      log("CREATE_SUPABASE_CLIENT_SUCCESS");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logCatchBlock(err, failureStep);
      debug.error = msg;
      return respond(500, {
        ok: false,
        step: failureStep,
        error: msg,
        stack: err instanceof Error ? err.stack : undefined,
      });
    }

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) {
      const errMsg = authError?.message ?? "Not authenticated.";
      console.error(`${LOG_PREFIX} fetch_document failed (auth):`, { documentId, error: errMsg });
      debug.error = errMsg;
      return respond(401, { ok: false, step: "fetch_document", error: errMsg });
    }

    let doc: {
      id: string;
      user_id: string;
      file_path: string | null;
      storage_path: string | null;
      file_name: string | null;
      status: string | null;
      county: string | null;
      state: string | null;
      document_type: string | null;
    } | null = null;
    let filePath: string = "";

    try {
      failureStep = "DOCUMENT_FETCHED";
      debug.failureStep = failureStep;
      log("DOCUMENT_FETCHED_START");
      const { data, error: fetchError } = await supabase
        .from("documents")
        .select("id, user_id, file_path, storage_path, file_name, status, county, state, document_type")
        .eq("id", documentId)
        .maybeSingle();

      if (fetchError) {
        console.error(`${LOG_PREFIX} fetch_document failed:`, {
          documentId,
          error: fetchError.message,
          code: fetchError.code,
        });
        console.error(`${LOG_PREFIX} DOCUMENT_FETCHED`, {
          documentId,
          error: fetchError.message,
          code: fetchError.code,
        });
        debug.error = fetchError.message ?? "Failed to load document.";
        return respond(500, {
          ok: false,
          step: failureStep,
          error: fetchError.message ?? "Failed to load document.",
        });
      }
      doc = data;
      if (!doc) {
        console.error(`${LOG_PREFIX} fetch_document failed: document not found`, { documentId });
        console.error(`${LOG_PREFIX} DOCUMENT_FETCHED`, {
          documentId,
          error: "Document not found or access denied.",
        });
        debug.error = "Document not found or access denied.";
        return respond(404, {
          ok: false,
          step: failureStep,
          error: "Document not found or access denied.",
        });
      }

      assertPlainObject(doc, "DOCUMENT_FETCHED");
      filePath = doc.file_path ?? doc.storage_path ?? "";
      fileNameForLogs = doc.file_name ?? null;
      fileExtensionForLogs = getFileExtension(doc.file_name ?? null);
      log("DOCUMENT_FETCHED", {
        documentId,
        file_name: fileNameForLogs,
        file_extension: fileExtensionForLogs,
        file_path: doc.file_path,
        storage_path: doc.storage_path,
        resolved_path: filePath,
      });

      if (!filePath) {
        console.error(`${LOG_PREFIX} fetch_document failed: no file path`, { documentId });
        await markDocumentFailed(supabase, documentId, "Document has no file path; cannot process.");
        debug.error = "Document has no file path; cannot process.";
        return okFalse("DOCUMENT_FETCHED", "Document has no file path; cannot process.");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logCatchBlock(err, failureStep);
      debug.error = msg;
      return respond(500, {
        ok: false,
        step: failureStep,
        error: msg,
        stack: err instanceof Error ? err.stack : undefined,
      });
    }

    if (!doc) {
      debug.error = "Document not found.";
      return respond(404, { ok: false, step: failureStep, error: "Document not found." });
    }

    try {
      failureStep = "queue_document";
      debug.failureStep = failureStep;
      log("QUEUE_DOCUMENT_START");

      const currentStatus = (doc.status ?? "").toLowerCase();
      if (currentStatus === "queued" || currentStatus === "processing") {
        debug.error = "Document is already queued/processing.";
        return okFalse("QUEUE_DOCUMENT", "Document is already queued/processing.");
      }

      const { error: updateQueuedError } = await updateDocumentFields(supabase, documentId, {
        status: "queued",
        error_message: null,
      });
      if (updateQueuedError) {
        console.error(`${LOG_PREFIX} queue_document failed (set queued):`, {
          documentId,
          error: updateQueuedError.message,
        });
        debug.error = updateQueuedError.message ?? "Failed to start processing.";
        await markDocumentFailed(supabase, documentId, debug.error as string);
        return okFalse("QUEUE_DOCUMENT", debug.error as string);
      }
      log("QUEUE_DOCUMENT_SUCCESS");
    } catch (err) {
      logCatchBlock(err, failureStep);
      // ignore: queueing is best-effort, extraction can still fail later with clearer logs.
    }

    failureStep = "STORAGE_DOWNLOAD_SUCCESS";
    debug.failureStep = failureStep;

    let downloadedFile: unknown;
    try {
      log("STORAGE_DOWNLOAD_START", { bucket: BUCKET_NAME, filePath });
      const { data: downloaded, error: downloadError } = await supabase.storage
        .from(BUCKET_NAME)
        .download(filePath);

      if (downloadError || !downloaded) {
        const msg = downloadError?.message ?? "Failed to download file from storage.";
        console.error(`${LOG_PREFIX} download_file failed:`, {
          documentId,
          bucket: BUCKET_NAME,
          filePath,
          error: msg,
        });
        console.error(`${LOG_PREFIX} STORAGE_DOWNLOAD_SUCCESS`, {
          documentId,
          error: msg,
          bucket: BUCKET_NAME,
          filePath,
        });
        await markDocumentFailed(supabase, documentId, msg);
        return okFalse("STORAGE_DOWNLOAD_START", msg);
      }
      downloadedFile = downloaded;

      // Helpful diagnostics: supabase storage download should return binary-ish data.
      // If it returns something else (string/object/json), pdf parsing will crash later.
      log("STORAGE_DOWNLOAD_RETURN_TYPE", {
        documentId,
        isBuffer: Buffer.isBuffer(downloaded),
        isArrayBuffer: downloaded instanceof ArrayBuffer,
        isUint8Array: downloaded instanceof Uint8Array,
        hasArrayBufferFn: !!downloaded && typeof (downloaded as any).arrayBuffer === "function",
        downloadedType: downloaded == null ? "nullish" : typeof downloaded,
      });

      const maybeSizeBytes =
        typeof (downloaded as any)?.size === "number"
          ? (downloaded as any).size
          : typeof (downloaded as any)?.byteLength === "number"
            ? (downloaded as any).byteLength
            : undefined;
      log("STORAGE_DOWNLOAD_SUCCESS", { sizeBytes: maybeSizeBytes });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logCatchBlock(err, failureStep);
      await markDocumentFailed(supabase, documentId, msg);
      return respond(500, {
        ok: false,
        step: failureStep,
        error: msg,
        stack: err instanceof Error ? err.stack : undefined,
      });
    }

    let fileBuffer: Buffer;
    try {
      failureStep = "FILE_BUFFER_READY";
      debug.failureStep = failureStep;

      if (Buffer.isBuffer(downloadedFile)) {
        fileBuffer = downloadedFile;
      } else if (downloadedFile instanceof ArrayBuffer) {
        fileBuffer = Buffer.from(downloadedFile);
      } else if (downloadedFile instanceof Uint8Array) {
        fileBuffer = Buffer.from(downloadedFile);
      } else if (downloadedFile && typeof (downloadedFile as any).arrayBuffer === "function") {
        const rawArrayBuffer = await (downloadedFile as any).arrayBuffer();
        if (!(rawArrayBuffer instanceof ArrayBuffer)) {
          throw new Error(
            `${failureStep}: expected ArrayBuffer from storage download but got ${describeValue(rawArrayBuffer)}.`
          );
        }
        fileBuffer = Buffer.from(rawArrayBuffer);
      } else {
        throw new Error(
          `${failureStep}: expected a Buffer/ArrayBuffer/Uint8Array from storage download but got ${describeValue(downloadedFile)}.`
        );
      }

      assertBuffer(fileBuffer, failureStep);

      const first10 = fileBuffer.slice(0, 10);
      const first10Hex = first10.toString("hex");
      const first10Ascii = first10
        .toString("ascii")
        // Replace non-printable bytes so logs stay readable.
        .replace(/[^\x20-\x7E]/g, ".");
      const header4Ascii = fileBuffer.slice(0, 4).toString("ascii");

      log("FILE_BUFFER_DEBUG", { sizeBytes: fileBuffer.length, header4Ascii, first10Hex, first10Ascii });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logCatchBlock(err, failureStep);
      await markDocumentFailed(supabase, documentId, msg);
      return okFalse("FILE_BUFFER_READY", msg);
    }
    const fileType = getFileExtension(doc.file_name ?? null);
    fileExtensionForLogs = fileType;
    log("FILE_TYPE_DETECTED", { file_extension: fileExtensionForLogs });

    let extractedText: string;
    try {
      failureStep = "set_processing";
      debug.failureStep = failureStep;
      log("DOCUMENT_STATUS_UPDATED", { status: "processing" });
      const { error: updateProcessingError } = await updateDocumentFields(supabase, documentId, {
        status: "processing",
        error_message: null,
      });
      if (updateProcessingError) {
        console.error(`${LOG_PREFIX} set_processing failed:`, {
          documentId,
          error: updateProcessingError.message,
        });
        const msg = updateProcessingError.message ?? "Failed to set processing status.";
        debug.error = msg;
        await markDocumentFailed(supabase, documentId, msg);
        return okFalse("DOCUMENT_STATUS_UPDATED", msg);
      }
      log("SET_PROCESSING_SUCCESS");

      failureStep = "extract_text";
      debug.failureStep = failureStep;
      log("TEXT_EXTRACTION_START", { fileType });

      const result = await processDocumentContent({
        fileBuffer,
        fileName: doc.file_name ?? null,
      });

      if (result.extractionMeta && typeof result.extractionMeta === "object") {
        debug.extractionMeta = result.extractionMeta;
      }

      if (!result.success) {
        const extractionError = result.error ?? "Text extraction failed.";
        console.error(`${LOG_PREFIX} extract_text failed:`, { documentId, error: extractionError });
        await markDocumentFailed(supabase, documentId, extractionError);
        debug.error = extractionError;
        extractedText = "";
        log("PROCESS_FAILED", { step_failed: "TEXT_EXTRACTION_START", error_message: extractionError });
        // Continue to DB insert so we persist an extraction row with the error.
      } else {
        extractedText = result.extractedText ?? "";
        assertString(extractedText, failureStep);
        log("TEXT_EXTRACTION_SUCCESS", { textLength: extractedText.length });
        debug.extractedTextLength = extractedText.length;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logCatchBlock(err, failureStep);
      await markDocumentFailed(supabase, documentId, msg);
      debug.error = msg;
      return okFalse("TEXT_EXTRACTION_START", msg, { stack: err instanceof Error ? err.stack : undefined });
    }

    let parsed = {
      lessor: null as string | null,
      lessee: null as string | null,
      county: doc.county ?? null,
      state: doc.state ?? null,
      legal_description: null as string | null,
      effective_date: null as string | null,
      recording_date: null as string | null,
      royalty_rate: null as string | null,
      term_length: null as string | null,
      document_type: null as string | null,
      confidence_score: null as number | null,
    };

    const hasUsableText = (() => {
      const trimmed = (extractedText ?? "").trim();
      if (!trimmed) return false;
      // Treat placeholder strings from the extractor as "no usable text" for AI.
      if (/^\(empty (csv|txt)\.\)$/i.test(trimmed)) return false;
      return true;
    })();

    let openAiModelUsed: string | null = null;
    let openAiError: string | null = null;

    try {
      failureStep = "OPENAI_CALL_START";
      debug.failureStep = failureStep;
      // If extraction already failed, keep the original failure reason and skip AI entirely.
      if (debug.error) {
        openAiError = String(debug.error);
        log("PROCESS_FAILED", { step_failed: "OPENAI_CALL_START", error_message: openAiError });
      } else if (!hasUsableText) {
        log("OPENAI_EMPTY_TEXT", {
          note: "No usable text after PDF extract and OCR fallback; running parseLeaseFieldsFromText without API (null fields, confidence 0).",
        });
        const parsedResult = await parseLeaseFieldsFromText(extractedText ?? "");
        assertPlainObject(parsedResult as unknown, "OPENAI_CALL_START");
        if (typeof (parsedResult as { confidence_score?: unknown }).confidence_score !== "number") {
          throw new Error(
            `OPENAI_CALL_START: expected confidence_score number but got ${describeValue((parsedResult as { confidence_score?: unknown }).confidence_score)}.`
          );
        }
        parsed = {
          lessor: parsedResult.lessor,
          lessee: parsedResult.lessee,
          county: parsedResult.county ?? doc.county ?? null,
          state: parsedResult.state ?? doc.state ?? null,
          legal_description: parsedResult.legal_description,
          effective_date: parsedResult.effective_date,
          recording_date: parsedResult.recording_date,
          royalty_rate: parsedResult.royalty_rate,
          term_length: parsedResult.term_length,
          document_type: parsedResult.document_type,
          confidence_score: parsedResult.confidence_score,
        };
        debug.parsed = parsed;
      } else if (!process.env.OPENAI_API_KEY) {
        const msg = "OPENAI_API_KEY is not set; cannot parse lease fields.";
        openAiError = msg;
        await markDocumentFailed(supabase, documentId, msg);
        log("PROCESS_FAILED", { step_failed: "OPENAI_CALL_START", error_message: msg });
      } else {
        log("OPENAI_CALL_START", { textLength: extractedText.length, model: DEFAULT_OPENAI_MODEL });
        openAiModelUsed = DEFAULT_OPENAI_MODEL;

        const parsedResult = await parseLeaseFieldsFromText(extractedText);
        assertPlainObject(parsedResult as unknown, "OPENAI_CALL_START");
        if (typeof (parsedResult as any).confidence_score !== "number") {
          throw new Error(
            `OPENAI_CALL_START: expected confidence_score number but got ${describeValue((parsedResult as any).confidence_score)}.`
          );
        }
        log("OPENAI_CALL_SUCCESS", { confidence_score: parsedResult.confidence_score, model: DEFAULT_OPENAI_MODEL });

        parsed = {
          lessor: parsedResult.lessor,
          lessee: parsedResult.lessee,
          county: parsedResult.county ?? doc.county ?? null,
          state: parsedResult.state ?? doc.state ?? null,
          legal_description: parsedResult.legal_description,
          effective_date: parsedResult.effective_date,
          recording_date: parsedResult.recording_date,
          royalty_rate: parsedResult.royalty_rate,
          term_length: parsedResult.term_length,
          document_type: parsedResult.document_type,
          confidence_score: parsedResult.confidence_score,
        };
        debug.parsed = parsed;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logCatchBlock(err, failureStep);
      openAiError = msg;
      await markDocumentFailed(supabase, documentId, msg);
      debug.error = msg;
      log("PROCESS_FAILED", { step_failed: "OPENAI_CALL_START", error_message: msg });
    }

    try {
      failureStep = "DB_INSERT_START";
      debug.failureStep = failureStep;
      assertString(extractedText, "DB_INSERT_START");
      log("EXTRACTION_INSERT_START");

      const dealScoreInput: Record<string, unknown> = { ...optionalDealScoreInput };
      dealScoreInput.recording_date = dealScoreInput.recording_date ?? parsed.recording_date;
      dealScoreInput.effective_date = dealScoreInput.effective_date ?? parsed.effective_date;
      if (dealScoreInput.acreage === undefined || dealScoreInput.acreage === null) {
        const fromLegal = parseAcreageFromLegalDescription(parsed.legal_description);
        if (fromLegal !== undefined) {
          dealScoreInput.acreage = fromLegal;
        }
      }
      const mineralDeedSignals = mineralDeedSignalsForLeaseFallback({
        metadataDocumentType: doc.document_type,
        extractedText,
        parsedDocumentType: parsed.document_type,
      });
      if (!hasUsableLeaseStatusForDealScore(dealScoreInput) && mineralDeedSignals.length > 0) {
        dealScoreInput.lease_status = "none";
      }
      dealScoreInput.county = dealScoreInput.county ?? parsed.county ?? doc.county ?? null;

      const detectedDocumentTypeForLog =
        mineralDeedSignals.length > 0
          ? `mineral_deed (${mineralDeedSignals.join(" | ")})`
          : doc.document_type?.trim()
            ? doc.document_type.trim()
            : null;

      console.log(`${LOG_PREFIX} [deal-score-debug]`, {
        detected_document_type: detectedDocumentTypeForLog,
        lease_status: dealScoreInput.lease_status ?? null,
        acreage: dealScoreInput.acreage ?? null,
        recency_months: previewRecencyMonthsForDealScoreInput(dealScoreInput),
        county: dealScoreInput.county ?? null,
        final_deal_score_input: { ...dealScoreInput },
      });

      const dealScore = calculateDealScore(dealScoreInput);
      dealScoreResult = dealScore;

      const rawAcreageForAlerts = dealScoreInput.acreage;
      if (typeof rawAcreageForAlerts === "number" && Number.isFinite(rawAcreageForAlerts)) {
        dealAcreageForAlerts = rawAcreageForAlerts;
      } else if (typeof rawAcreageForAlerts === "string") {
        const n = parseFloat(rawAcreageForAlerts.trim());
        dealAcreageForAlerts = !Number.isNaN(n) && Number.isFinite(n) ? n : undefined;
      } else {
        dealAcreageForAlerts = undefined;
      }

      const structuredExtraction = {
        lessor: parsed.lessor,
        lessee: parsed.lessee,
        county: parsed.county,
        state: parsed.state,
        legal_description: parsed.legal_description,
        effective_date: parsed.effective_date,
        recording_date: parsed.recording_date,
        royalty_rate: parsed.royalty_rate,
        term_length: parsed.term_length,
        document_type: parsed.document_type,
        confidence_score: parsed.confidence_score,
        deal_score: dealScore,
      };

      assertPlainObject(structuredExtraction, "DB_INSERT_START");

      const basePayloadFull = {
        document_id: documentId,
        user_id: user.id,
        extracted_text: extractedText,
        lessor: parsed.lessor,
        lessee: parsed.lessee,
        county: parsed.county,
        state: parsed.state,
        legal_description: parsed.legal_description,
        effective_date: parsed.effective_date,
        recording_date: parsed.recording_date,
        royalty_rate: parsed.royalty_rate,
        term_length: parsed.term_length,
        confidence_score: parsed.confidence_score,
        confidence: parsed.confidence_score,
        model: openAiModelUsed ?? DEFAULT_OPENAI_MODEL,
        error_message: openAiError ?? debug.error ?? null,
      };

      const basePayloadNoMeta = {
        document_id: documentId,
        user_id: user.id,
        extracted_text: extractedText,
        lessor: parsed.lessor,
        lessee: parsed.lessee,
        county: parsed.county,
        state: parsed.state,
        legal_description: parsed.legal_description,
        effective_date: parsed.effective_date,
        recording_date: parsed.recording_date,
        royalty_rate: parsed.royalty_rate,
        term_length: parsed.term_length,
        confidence_score: parsed.confidence_score,
      };

      assertPlainObject(basePayloadFull, "DB_INSERT_START");
      assertPlainObject(basePayloadNoMeta, "DB_INSERT_START");

      const isMissingColumnError = (message: string, columnName: string) => {
        const escaped = columnName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const appearsInMessage = new RegExp(`\\b${escaped}\\b`, "i").test(message);
        if (!appearsInMessage) return false;

        // Postgres errors look like: `column "...“ of relation ... does not exist`
        if (/does not exist/i.test(message)) return true;

        // Supabase schema cache errors look like:
        // "Could not find the 'confidence' column of 'document_extractions' in the schema cache"
        if (/schema cache/i.test(message) && /could not find/i.test(message)) return true;

        return /could not find/i.test(message) && /column/i.test(message);
      };

      // Try to persist the structured extraction payload, but keep the pipeline operational if
      // the schema hasn't been migrated yet.
      log("EXTRACTION_INSERT_START", { documentId });
      let saveSucceeded = false;
      let lastErrorMessage: string | null = null;
      let successfulAttempt: string | null = null;
      let stripMetadata = false;

      for (const attempt of ["structured_data", "structured_json", "none"] as const) {
        const basePayload = stripMetadata ? basePayloadNoMeta : basePayloadFull;
        const payload =
          attempt === "structured_data"
            ? { ...basePayload, structured_data: structuredExtraction }
            : attempt === "structured_json"
              ? { ...basePayload, structured_json: structuredExtraction }
              : basePayload;

        let upsertError: any | null = null;
        try {
          const { error } = await supabase
            .from("document_extractions")
            .upsert(payload, { onConflict: "document_id" });
          upsertError = error;
        } catch (err) {
          upsertError = err;
        }

        if (!upsertError) {
          saveSucceeded = true;
          successfulAttempt = attempt;
          if (attempt === "structured_data") debug.structured_data_saved = true;
          if (attempt === "structured_json") debug.structured_json_saved = true;
          break;
        }

        const msg =
          upsertError?.message ??
          (typeof upsertError === "string" ? upsertError : upsertError ? String(upsertError) : "Failed to save extraction.");
        lastErrorMessage = msg;

        if (isMissingOnConflictUniqueConstraintError(msg)) {
          // Fallback when the DB schema is temporarily missing the required UNIQUE(document_id).
          // This keeps the "one extraction row per document" model without relying on `ON CONFLICT`.
          try {
            const { data: updatedRows, error: updateError } = await supabase
              .from("document_extractions")
              .update(payload)
              .eq("document_id", documentId)
              .select("id");

            if (updateError) {
              upsertError = updateError;
            } else {
              const updatedCount = Array.isArray(updatedRows) ? updatedRows.length : 0;
              if (updatedCount > 0) {
                saveSucceeded = true;
                successfulAttempt = attempt;
                if (attempt === "structured_data") debug.structured_data_saved = true;
                if (attempt === "structured_json") debug.structured_json_saved = true;
                break;
              }

              const { error: insertError } = await supabase.from("document_extractions").insert(payload);
              upsertError = insertError;
              if (!insertError) {
                saveSucceeded = true;
                successfulAttempt = attempt;
                if (attempt === "structured_data") debug.structured_data_saved = true;
                if (attempt === "structured_json") debug.structured_json_saved = true;
                break;
              }
            }
          } catch (fallbackErr) {
            upsertError = fallbackErr;
          }
        }

        if (saveSucceeded) break;

        const fallbackMsg =
          upsertError?.message ??
          (typeof upsertError === "string" ? upsertError : upsertError ? String(upsertError) : lastErrorMessage ?? "Failed to save extraction.");

        const structuredDataMissing =
          attempt === "structured_data" && isMissingColumnError(fallbackMsg, "structured_data");
        const structuredJsonMissing =
          attempt === "structured_json" && isMissingColumnError(fallbackMsg, "structured_json");
        const modelMissing = isMissingColumnError(fallbackMsg, "model");
        const confidenceMissing = isMissingColumnError(fallbackMsg, "confidence");
        const errorMessageMissing = isMissingColumnError(fallbackMsg, "error_message");

        if (structuredDataMissing) {
          // Schema out of date; log clearly and continue with a fallback.
          console.error(`${LOG_PREFIX} save_extraction: missing 'structured_data' column; continuing without it.`, {
            documentId,
            error: fallbackMsg,
          });
          debug.structured_data_retry_used = true;
          continue;
        }

        if (structuredJsonMissing) {
          console.warn(`${LOG_PREFIX} save_extraction: missing 'structured_json' column; continuing without it.`, {
            documentId,
            error: fallbackMsg,
          });
          debug.structured_json_retry_used = true;
          continue;
        }

        if (modelMissing || confidenceMissing || errorMessageMissing) {
          console.warn(`${LOG_PREFIX} save_extraction: missing metadata column(s); retrying without them.`, {
            documentId,
            error: fallbackMsg,
            modelMissing,
            confidenceMissing,
            errorMessageMissing,
          });
          stripMetadata = true;
          continue;
        }

        // Any other error is unexpected; fail fast so we don't hide permission/constraint issues.
        console.error(`${LOG_PREFIX} save_extraction failed:`, {
          documentId,
          error: fallbackMsg,
          code: upsertError.code,
          attempt,
        });
        await markDocumentFailed(supabase, documentId, fallbackMsg);
        debug.error = fallbackMsg;
        console.error(`${LOG_PREFIX} ${failureStep}`, {
          documentId,
          error: fallbackMsg,
          attempt,
        });
        return okFalse("EXTRACTION_INSERT_START", fallbackMsg);
      }

      if (!saveSucceeded) {
        const msg = lastErrorMessage ?? "Failed to save extraction.";
        console.error(`${LOG_PREFIX} save_extraction failed (all structured attempts):`, { documentId, error: msg });
        console.error(`${LOG_PREFIX} ${failureStep}`, {
          documentId,
          error: msg,
        });
        await markDocumentFailed(supabase, documentId, msg);
        debug.error = msg;
        return okFalse("EXTRACTION_INSERT_START", msg);
      }

      if (saveSucceeded) {
        log("EXTRACTION_INSERT_SUCCESS", { attempt: successfulAttempt });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logCatchBlock(err, failureStep);
      await markDocumentFailed(supabase, documentId, msg);
      debug.error = msg;
      return okFalse("EXTRACTION_INSERT_START", msg, { stack: err instanceof Error ? err.stack : undefined });
    }

    // Retrieve the persisted extraction row so the frontend can render exact saved fields.
    type SavedExtraction = {
      id: string;
      document_id: string;
      extracted_text: string | null;
      lessor: string | null;
      lessee: string | null;
      county: string | null;
      state: string | null;
      legal_description: string | null;
      effective_date: string | null;
      recording_date: string | null;
      royalty_rate: string | null;
      term_length: string | null;
      confidence_score: number | null;
      created_at: string;
      structured_data?: unknown;
      structured_json?: unknown;
    };
    let savedExtraction: SavedExtraction | null = null;

    try {
      failureStep = "fetch_saved_extraction";
      debug.failureStep = failureStep;
      log("FETCH_SAVED_EXTRACTION_START");
      const { data, error } = await supabase
        .from("document_extractions")
        .select(
          "id, document_id, extracted_text, lessor, lessee, county, state, legal_description, effective_date, recording_date, royalty_rate, term_length, confidence_score, created_at, structured_data, structured_json"
        )
        .eq("document_id", documentId)
        .maybeSingle();
      if (error) {
        console.error(`${LOG_PREFIX} fetch_saved_extraction failed:`, { documentId, error: error.message });
        debug.fetch_saved_extraction_error = error.message;
      } else {
        savedExtraction = data as SavedExtraction;
      }
      log("FETCH_SAVED_EXTRACTION_SUCCESS", { found: !!savedExtraction });
    } catch (err) {
      logCatchBlock(err, failureStep);
      debug.fetch_saved_extraction_throw = err instanceof Error ? err.message : String(err);
    }

    let completedAt = new Date().toISOString();

    try {
      failureStep = "update_status_completed";
      debug.failureStep = failureStep;
      if (debug.error || openAiError) {
        const msg = String(openAiError ?? debug.error ?? "Processing failed.");
        await markDocumentFailed(supabase, documentId, msg);
        log("DOCUMENT_STATUS_UPDATED", { status: "failed", completed_at: completedAt });
        return okFalse("PROCESS_FAILED", msg, {
          status: "failed",
          extraction: savedExtraction,
          document: { id: documentId as string, status: "failed", completed_at: completedAt },
        });
      }

      const { error: updateCompletedError } = await updateDocumentFields(supabase, documentId, {
        status: "completed",
        completed_at: completedAt,
        processed_at: completedAt,
        error_message: null,
      });

      if (updateCompletedError) {
        const msg = updateCompletedError.message ?? "Failed to update completed status.";
        debug.error = msg;
        await markDocumentFailed(supabase, documentId, msg);
        return okFalse("DOCUMENT_STATUS_UPDATED", msg);
      }
      log("DOCUMENT_STATUS_UPDATED", { status: "completed", completed_at: completedAt });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logCatchBlock(err, failureStep);
      debug.error = msg;
      await markDocumentFailed(supabase, documentId, msg);
      return okFalse("DOCUMENT_STATUS_UPDATED", msg, { stack: err instanceof Error ? err.stack : undefined });
    }

    if (supabase && dealScoreResult && documentId) {
      await logAlertIfDealMatches(supabase, {
        dealId: documentId,
        dealScore: dealScoreResult,
        county: parsed.county ?? doc.county ?? null,
        acreage: dealAcreageForAlerts,
        savedExtraction: savedExtraction
          ? {
              county: savedExtraction.county,
              structured_data: savedExtraction.structured_data,
              structured_json: savedExtraction.structured_json,
            }
          : null,
      });
    }

    log("PROCESS_COMPLETE");
    const fallbackStructuredForClient = {
      lessor: parsed.lessor,
      lessee: parsed.lessee,
      county: parsed.county,
      state: parsed.state,
      legal_description: parsed.legal_description,
      effective_date: parsed.effective_date,
      recording_date: parsed.recording_date,
      royalty_rate: parsed.royalty_rate,
      term_length: parsed.term_length,
      confidence_score: parsed.confidence_score,
      deal_score: dealScoreResult ?? { score: 0, grade: "C Deal" as const, reasons: [] as string[] },
    };
    const fallbackExtractionResponse: SavedExtraction = {
      id: documentId as string,
      document_id: documentId as string,
      extracted_text: extractedText,
      lessor: parsed.lessor,
      lessee: parsed.lessee,
      county: parsed.county,
      state: parsed.state,
      legal_description: parsed.legal_description,
      effective_date: parsed.effective_date,
      recording_date: parsed.recording_date,
      royalty_rate: parsed.royalty_rate,
      term_length: parsed.term_length,
      confidence_score: parsed.confidence_score,
      created_at: completedAt,
      structured_data: fallbackStructuredForClient,
    };
    const extractionResponse: SavedExtraction = savedExtraction ?? fallbackExtractionResponse;

    debug.completedAt = completedAt;

    debug.extractionFields = {
      lessor: extractionResponse.lessor,
      lessee: extractionResponse.lessee,
      county: extractionResponse.county,
      state: extractionResponse.state,
      legal_description: extractionResponse.legal_description,
      effective_date: extractionResponse.effective_date,
      recording_date: extractionResponse.recording_date,
      royalty_rate: extractionResponse.royalty_rate,
      term_length: extractionResponse.term_length,
      confidence_score: extractionResponse.confidence_score,
    };

    return respond(200, {
      ok: true,
      step: "completed",
      status: "completed",
      document: { id: documentId as string, status: "completed", completed_at: completedAt, processed_at: completedAt },
      extraction: extractionResponse,
      deal_score: dealScoreResult ?? { score: 0, grade: "C Deal", reasons: [] },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logCatchBlock(err, failureStep);
    if (supabase && documentId) {
      await markDocumentFailed(supabase, documentId, message);
    }
    debug.error = message;
    if (err instanceof Error) debug.stack = err.stack;
    return okFalse(failureStep, message, { stack: err instanceof Error ? err.stack : undefined });
  }
}
