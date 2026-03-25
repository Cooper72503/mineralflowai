import { NextResponse } from "next/server";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";
import {
  processDocumentContent,
  runStructuredExtraction,
  calculateDealScore,
  calendarMonthsSince,
  dealGradeFullLabelFromScore,
  getGradeFromScore,
  parseDocumentDate,
  type DealScoreResult,
} from "@/lib/document-processing";
import type { SupabaseClient } from "@supabase/supabase-js";
import { logAlertIfDealMatches } from "@/lib/alerts/check-on-deal-processed";
import {
  buildDealScoreInput,
  mineralDeedSignalsForLeaseFallback,
} from "@/lib/deals/build-deal-score-input";
import {
  coerceDealScoreResult,
  dealScoreFromExtractionColumns,
} from "@/lib/deals/dashboard-normalize";
import {
  drillSnapshotFromDealInput,
  enrichDealScoreInputWithDrillDifficulty,
} from "@/lib/scoring/drillDifficultyEngine";

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

function assertPlainObject(
  value: unknown,
  stepName: string,
): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new Error(
      `${stepName}: expected a plain object but got ${describeValue(value)}.`,
    );
  }
}

function assertString(
  value: unknown,
  stepName: string,
): asserts value is string {
  if (typeof value !== "string") {
    throw new Error(
      `${stepName}: expected a string but got ${describeValue(value)}.`,
    );
  }
}

function assertBuffer(
  value: unknown,
  stepName: string,
): asserts value is Buffer {
  if (!Buffer.isBuffer(value)) {
    throw new Error(
      `${stepName}: expected a Buffer but got ${describeValue(value)}.`,
    );
  }
}

function readNonEmptyStringForRecencyPreview(
  value: unknown,
): string | undefined {
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
function previewRecencyMonthsForDealScoreInput(
  input: Record<string, unknown>,
): number | null {
  const recordingDateStr = readNonEmptyStringForRecencyPreview(
    input.recording_date,
  );
  const effectiveDateStr = readNonEmptyStringForRecencyPreview(
    input.effective_date,
  );
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

function isMissingColumnError(message: string, columnName: string): boolean {
  const escaped = columnName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const appearsInMessage = new RegExp(`\\b${escaped}\\b`, "i").test(message);
  if (!appearsInMessage) return false;

  // Postgres errors look like: `column "...“ of relation ... does not exist`
  if (/does not exist/i.test(message)) return true;

  // Supabase schema cache errors look like:
  // "Could not find the 'confidence' column of 'document_extractions' in the schema cache"
  if (/schema cache/i.test(message) && /could not find/i.test(message))
    return true;

  return /could not find/i.test(message) && /column/i.test(message);
}

function isMissingOnConflictUniqueConstraintError(message: string): boolean {
  // Postgres error when doing `ON CONFLICT (some_column)` without a matching unique index/constraint.
  return /no unique or exclusion constraint matching the ON CONFLICT specification/i.test(
    message,
  );
}

async function updateDocumentFields(
  supabase: SupabaseClient,
  documentId: string,
  payload: Record<string, unknown>,
): Promise<{ error: any | null }> {
  let error: any | null = null;
  try {
    const res = await supabase
      .from("documents")
      .update(payload)
      .eq("id", documentId);
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
    const res = await supabase
      .from("documents")
      .update(reducedPayload)
      .eq("id", documentId);
    retryError = res.error;
  } catch (err) {
    retryError = err;
  }
  return { error: retryError ?? null };
}

async function markDocumentFailed(
  supabase: SupabaseClient,
  documentId: string,
  errorMessage: string,
): Promise<void> {
  const completedAt = new Date().toISOString();
  const { error } = await updateDocumentFields(supabase, documentId, {
    status: "failed",
    error_message: errorMessage,
    completed_at: completedAt,
    processed_at: completedAt,
  });
  if (error) {
    console.error(
      `${LOG_PREFIX} Failed to update document status to failed:`,
      error.message,
    );
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
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
      console.log("[process-document] COMPLETED_SAFE");
      if (isDev && (payload as any).ok === false) {
        return NextResponse.json(
          {
            ok: false,
            step: (payload as any).step ?? failureStep,
            error: (payload as any).error ?? "Unknown error",
            step_failed:
              (payload as any).step_failed ??
              (payload as any).step ??
              failureStep,
            error_message:
              (payload as any).error_message ??
              (payload as any).error ??
              "Unknown error",
            stack: (payload as any).stack ?? null,
            debug,
          },
          { status },
        );
      }
      if (isDev) return NextResponse.json({ ...payload, debug }, { status });
      return NextResponse.json(payload, { status });
    };

    const okFalse = (
      step_failed: string,
      error_message: string,
      extra?: Record<string, unknown>,
    ) => {
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
      /** Set after enrichment; used for client fallback payload drill snapshot. */
      let dealScoreInputForPipeline: Record<string, unknown> | null = null;
      let dealScoreResult: DealScoreResult | null = null;
      let dealAcreageForAlerts: number | null | undefined = undefined;
      try {
        const contentType = request.headers.get("content-type") ?? "";
        if (contentType.includes("application/json")) {
          const body: unknown = await request.json();
          if (
            isPlainObject(body) &&
            body.deal_score_input != null &&
            isPlainObject(body.deal_score_input)
          ) {
            optionalDealScoreInput = body.deal_score_input as Record<
              string,
              unknown
            >;
          }
        }
      } catch {
        // No JSON body or invalid JSON — scoring uses parsed dates / defaults only.
      }

      if (!documentId) {
        console.error(`${LOG_PREFIX} Step 0: Missing document ID`);
        return respond(400, {
          ok: false,
          step: "params",
          error: "Document ID is required.",
        });
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
        return okFalse(failureStep, msg, {
          stack: err instanceof Error ? err.stack : undefined,
        });
      }

      const {
        data: { user },
        error: authError,
      } = await supabase.auth.getUser();
      if (authError || !user) {
        const errMsg = authError?.message ?? "Not authenticated.";
        console.error(`${LOG_PREFIX} fetch_document failed (auth):`, {
          documentId,
          error: errMsg,
        });
        debug.error = errMsg;
        return respond(401, {
          ok: false,
          step: "fetch_document",
          error: errMsg,
        });
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
          .select(
            "id, user_id, file_path, storage_path, file_name, status, county, state, document_type",
          )
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
          return okFalse(
            failureStep,
            fetchError.message ?? "Failed to load document.",
          );
        }
        doc = data;
        if (!doc) {
          console.error(
            `${LOG_PREFIX} fetch_document failed: document not found`,
            { documentId },
          );
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
          console.error(`${LOG_PREFIX} fetch_document failed: no file path`, {
            documentId,
          });
          await markDocumentFailed(
            supabase,
            documentId,
            "Document has no file path; cannot process.",
          );
          debug.error = "Document has no file path; cannot process.";
          return okFalse(
            "DOCUMENT_FETCHED",
            "Document has no file path; cannot process.",
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logCatchBlock(err, failureStep);
        debug.error = msg;
        return okFalse(failureStep, msg, {
          stack: err instanceof Error ? err.stack : undefined,
        });
      }

      if (!doc) {
        debug.error = "Document not found.";
        return respond(404, {
          ok: false,
          step: failureStep,
          error: "Document not found.",
        });
      }

      try {
        failureStep = "queue_document";
        debug.failureStep = failureStep;
        log("QUEUE_DOCUMENT_START");

        const currentStatus = (doc.status ?? "").toLowerCase();
        if (currentStatus === "queued" || currentStatus === "processing") {
          debug.error = "Document is already queued/processing.";
          return okFalse(
            "QUEUE_DOCUMENT",
            "Document is already queued/processing.",
          );
        }

        const { error: updateQueuedError } = await updateDocumentFields(
          supabase,
          documentId,
          {
            status: "queued",
            error_message: null,
          },
        );
        if (updateQueuedError) {
          console.error(`${LOG_PREFIX} queue_document failed (set queued):`, {
            documentId,
            error: updateQueuedError.message,
          });
          debug.error =
            updateQueuedError.message ?? "Failed to start processing.";
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
        const { data: downloaded, error: downloadError } =
          await supabase.storage.from(BUCKET_NAME).download(filePath);

        if (downloadError || !downloaded) {
          const msg =
            downloadError?.message ?? "Failed to download file from storage.";
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
          hasArrayBufferFn:
            !!downloaded &&
            typeof (downloaded as any).arrayBuffer === "function",
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
        return okFalse(failureStep, msg, {
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
        } else if (
          downloadedFile &&
          typeof (downloadedFile as any).arrayBuffer === "function"
        ) {
          const rawArrayBuffer = await (downloadedFile as any).arrayBuffer();
          if (!(rawArrayBuffer instanceof ArrayBuffer)) {
            throw new Error(
              `${failureStep}: expected ArrayBuffer from storage download but got ${describeValue(rawArrayBuffer)}.`,
            );
          }
          fileBuffer = Buffer.from(rawArrayBuffer);
        } else {
          throw new Error(
            `${failureStep}: expected a Buffer/ArrayBuffer/Uint8Array from storage download but got ${describeValue(downloadedFile)}.`,
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

        log("FILE_BUFFER_DEBUG", {
          sizeBytes: fileBuffer.length,
          header4Ascii,
          first10Hex,
          first10Ascii,
        });
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
        const { error: updateProcessingError } = await updateDocumentFields(
          supabase,
          documentId,
          {
            status: "processing",
            error_message: null,
          },
        );
        if (updateProcessingError) {
          console.error(`${LOG_PREFIX} set_processing failed:`, {
            documentId,
            error: updateProcessingError.message,
          });
          const msg =
            updateProcessingError.message ?? "Failed to set processing status.";
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

        if (
          result.extractionMeta &&
          typeof result.extractionMeta === "object"
        ) {
          debug.extractionMeta = result.extractionMeta;
        }

        if (!result.success) {
          const extractionError = result.error ?? "Text extraction failed.";
          console.error(`${LOG_PREFIX} extract_text failed:`, {
            documentId,
            error: extractionError,
          });
          await markDocumentFailed(supabase, documentId, extractionError);
          debug.error = extractionError;
          extractedText = "";
          log("PROCESS_FAILED", {
            step_failed: "TEXT_EXTRACTION_START",
            error_message: extractionError,
          });
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
        return okFalse("TEXT_EXTRACTION_START", msg, {
          stack: err instanceof Error ? err.stack : undefined,
        });
      }

      let parsed = {
        lessor: null as string | null,
        lessee: null as string | null,
        grantor: null as string | null,
        grantee: null as string | null,
        parties: null as unknown,
        county: doc.county ?? null,
        state: doc.state ?? null,
        legal_description: null as string | null,
        effective_date: null as string | null,
        recording_date: null as string | null,
        royalty_rate: null as string | null,
        term_length: null as string | null,
        document_type: null as string | null,
        confidence_score: null as number | null,
        owner: null as string | null,
        buyer: null as string | null,
        acreage: null as number | null,
        mailing_address: null as string | null,
        extraction_status: null as string | null,
      };

      const hasUsableText = (() => {
        const trimmed = (extractedText ?? "").trim();
        if (trimmed && !/^\(empty (csv|txt)\.\)$/i.test(trimmed)) return true;
        const meta =
          (debug.extractionMeta as Record<string, unknown> | undefined) ?? {};
        const raw =
          typeof meta.raw_pdf_text === "string" ? meta.raw_pdf_text.trim() : "";
        const ocr =
          typeof meta.ocr_text === "string" ? meta.ocr_text.trim() : "";
        return raw.length >= 15 || ocr.length >= 15;
      })();

      let openAiModelUsed: string | null = null;
      let openAiError: string | null = null;

      try {
        failureStep = "STRUCTURED_EXTRACTION";
        debug.failureStep = failureStep;

        const meta =
          (debug.extractionMeta as Record<string, unknown> | undefined) ?? {};
        const rawPdfText =
          typeof meta.raw_pdf_text === "string" ? meta.raw_pdf_text : "";
        const ocrText =
          typeof meta.ocr_text === "string" &&
          (meta.ocr_text as string).length > 0
            ? (meta.ocr_text as string)
            : null;
        const pdfNumPages =
          typeof meta.numpages === "number" ? meta.numpages : 0;
        const ocrMeanConfidence0to100 =
          typeof meta.ocrMeanConfidence === "number"
            ? meta.ocrMeanConfidence
            : null;
        const failedNoOcr = meta.failed_no_ocr === true;

        if (debug.error) {
          log("STRUCTURED_EXTRACTION_SKIP_TEXT", {
            error_message: String(debug.error),
          });
        }

        const skipOpenAi = !process.env.OPENAI_API_KEY || !hasUsableText;
        if (!skipOpenAi) {
          openAiModelUsed = DEFAULT_OPENAI_MODEL;
        }

        const extractionOutcome = await runStructuredExtraction({
          normalizedText: extractedText ?? "",
          rawPdfText,
          ocrText,
          pdfNumPages,
          ocrMeanConfidence0to100,
          docCounty: doc.county,
          docState: doc.state,
          openAiModel: DEFAULT_OPENAI_MODEL,
          skipOpenAi,
          failedNoOcr,
        });

        const pipelineParsed = extractionOutcome?.parsed;
        const artifacts = extractionOutcome?.artifacts;

        if (artifacts) {
          const dbgRawPdf =
            typeof artifacts.raw_pdf_text === "string" ? artifacts.raw_pdf_text : "";
          const dbgOcr =
            artifacts.ocr_text != null && typeof artifacts.ocr_text === "string"
              ? artifacts.ocr_text
              : "";
          const dbgCombined =
            typeof artifacts.combined_text === "string" ? artifacts.combined_text : "";
          console.log(`${LOG_PREFIX} [doc-pipeline-debug] STAGE_SNAPSHOT process_route`, {
            documentId,
            RAW_PDF_TEXT_LENGTH: dbgRawPdf.length,
            OCR_TEXT_LENGTH: dbgOcr.length,
            COMBINED_TEXT_LENGTH: dbgCombined.length,
            FINAL_EXTRACTED_FIELDS: artifacts.final_extracted_fields,
            FINAL_EXTRACTION_STATUS: artifacts.extraction_status,
            RAW_PDF_TEXT_FIRST_500: dbgRawPdf.slice(0, 500),
            OCR_TEXT_FIRST_500: dbgOcr.slice(0, 500),
            COMBINED_TEXT_FIRST_500: dbgCombined.slice(0, 500),
          });
        }

        debug.extraction_artifacts = artifacts;
        debug.parsed = pipelineParsed;

        const extractionErrs = artifacts?.extraction_errors;
        if (Array.isArray(extractionErrs) && extractionErrs.length > 0) {
          openAiError = extractionErrs.join("; ");
        }

        parsed = {
          lessor: pipelineParsed?.lessor ?? null,
          lessee: pipelineParsed?.lessee ?? null,
          grantor: pipelineParsed?.grantor ?? null,
          grantee: pipelineParsed?.grantee ?? null,
          parties: pipelineParsed?.parties ?? null,
          county: pipelineParsed?.county ?? doc.county ?? null,
          state: pipelineParsed?.state ?? doc.state ?? null,
          legal_description: pipelineParsed?.legal_description ?? null,
          effective_date: pipelineParsed?.effective_date ?? null,
          recording_date: pipelineParsed?.recording_date ?? null,
          royalty_rate: pipelineParsed?.royalty_rate ?? null,
          term_length: pipelineParsed?.term_length ?? null,
          document_type: pipelineParsed?.document_type ?? null,
          confidence_score: pipelineParsed?.confidence_score ?? null,
          owner: pipelineParsed?.owner ?? null,
          buyer: pipelineParsed?.buyer ?? null,
          acreage: pipelineParsed?.acreage ?? null,
          mailing_address: pipelineParsed?.mailing_address ?? null,
          extraction_status:
            pipelineParsed?.extraction_status ??
            artifacts?.extraction_status ??
            null,
        };

        if (
          typeof parsed.confidence_score !== "number" ||
          !Number.isFinite(parsed.confidence_score)
        ) {
          parsed.confidence_score = hasUsableText ? 0.25 : 0;
        } else if (hasUsableText && parsed.confidence_score < 0.25) {
          parsed.confidence_score = 0.25;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logCatchBlock(err, failureStep);
        openAiError = msg;
        debug.structured_extraction_throw = msg;
        log("STRUCTURED_EXTRACTION_ERROR", { error_message: msg });
      }

      try {
        failureStep = "DB_INSERT_START";
        debug.failureStep = failureStep;
        assertString(extractedText, "DB_INSERT_START");
        log("EXTRACTION_INSERT_START");

        const mineralDeedSignals = mineralDeedSignalsForLeaseFallback({
          metadataDocumentType: doc.document_type,
          extractedText,
          parsedDocumentType: parsed.document_type,
        });
        const dealScoreInput = buildDealScoreInput({
          optionalBaseline: optionalDealScoreInput,
          parsed,
          doc: {
            county: doc.county,
            state: doc.state,
            document_type: doc.document_type,
          },
          extractedText,
          documentProcessedAtIso: new Date().toISOString(),
        });

        try {
          enrichDealScoreInputWithDrillDifficulty(dealScoreInput);
        } catch {
          // Non-fatal: enrichment uses safe defaults internally; this is defense in depth.
        }
        dealScoreInputForPipeline = dealScoreInput;

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

        const dealScoreCalculated = calculateDealScore(dealScoreInput);
        const dealScore =
          coerceDealScoreResult(dealScoreCalculated) ?? dealScoreCalculated;
        dealScoreResult = dealScore;
        console.log(`${LOG_PREFIX} SCORE CALCULATED`, {
          documentId,
          score: dealScore.score,
          grade: dealGradeFullLabelFromScore(dealScore.score),
          grade_letter: getGradeFromScore(dealScore.score),
          type: dealScore.type,
        });

        const rawAcreageForAlerts = dealScoreInput.acreage;
        if (
          typeof rawAcreageForAlerts === "number" &&
          Number.isFinite(rawAcreageForAlerts)
        ) {
          dealAcreageForAlerts = rawAcreageForAlerts;
        } else if (typeof rawAcreageForAlerts === "string") {
          const n = parseFloat(rawAcreageForAlerts.trim());
          dealAcreageForAlerts =
            !Number.isNaN(n) && Number.isFinite(n) ? n : undefined;
        } else {
          dealAcreageForAlerts = undefined;
        }

        const extractionArtifacts = debug.extraction_artifacts as
          | Record<string, unknown>
          | undefined;
        const drillSnap = drillSnapshotFromDealInput(dealScoreInput);
        const structuredExtraction = {
          lessor: parsed.lessor,
          lessee: parsed.lessee,
          grantor: parsed.grantor,
          grantee: parsed.grantee,
          parties: parsed.parties,
          county: parsed.county,
          state: parsed.state,
          legal_description: parsed.legal_description,
          effective_date: parsed.effective_date,
          recording_date: parsed.recording_date,
          royalty_rate: parsed.royalty_rate,
          term_length: parsed.term_length,
          document_type: parsed.document_type,
          confidence_score: parsed.confidence_score,
          owner: parsed.owner,
          buyer: parsed.buyer,
          acreage: parsed.acreage,
          mailing_address: parsed.mailing_address,
          extraction_status: parsed.extraction_status,
          extraction_confidence: extractionArtifacts?.extraction_confidence,
          confidence_by_field: extractionArtifacts?.confidence_by_field,
          text_quality_confidence: extractionArtifacts?.text_quality_confidence,
          ocr_confidence: extractionArtifacts?.ocr_confidence,
          party_confidence: extractionArtifacts?.party_confidence,
          county_confidence: extractionArtifacts?.county_confidence,
          acreage_confidence: extractionArtifacts?.acreage_confidence,
          document_type_confidence:
            extractionArtifacts?.document_type_confidence,
          extraction_artifacts: extractionArtifacts ?? null,
          estimated_formation: drillSnap.estimated_formation,
          estimated_depth_min: drillSnap.estimated_depth_min,
          estimated_depth_max: drillSnap.estimated_depth_max,
          drill_difficulty: drillSnap.drill_difficulty,
          drill_difficulty_score: drillSnap.drill_difficulty_score,
          drill_difficulty_reason: drillSnap.drill_difficulty_reason,
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
          confidence_score: parsed.confidence_score ?? 0,
          confidence: parsed.confidence_score ?? 0,
          model: openAiModelUsed ?? DEFAULT_OPENAI_MODEL,
          error_message: openAiError ?? debug.error ?? null,
          estimated_formation: drillSnap.estimated_formation,
          estimated_depth_min: drillSnap.estimated_depth_min,
          estimated_depth_max: drillSnap.estimated_depth_max,
          drill_difficulty: drillSnap.drill_difficulty,
          drill_difficulty_score: drillSnap.drill_difficulty_score,
          drill_difficulty_reason: drillSnap.drill_difficulty_reason,
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
          confidence_score: parsed.confidence_score ?? 0,
          estimated_formation: drillSnap.estimated_formation,
          estimated_depth_min: drillSnap.estimated_depth_min,
          estimated_depth_max: drillSnap.estimated_depth_max,
          drill_difficulty: drillSnap.drill_difficulty,
          drill_difficulty_score: drillSnap.drill_difficulty_score,
          drill_difficulty_reason: drillSnap.drill_difficulty_reason,
        };

        assertPlainObject(basePayloadFull, "DB_INSERT_START");
        assertPlainObject(basePayloadNoMeta, "DB_INSERT_START");

        console.log("DRILL OUTPUT:", drillSnap);

        const isMissingColumnError = (message: string, columnName: string) => {
          const escaped = columnName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const appearsInMessage = new RegExp(`\\b${escaped}\\b`, "i").test(
            message,
          );
          if (!appearsInMessage) return false;

          // Postgres errors look like: `column "...“ of relation ... does not exist`
          if (/does not exist/i.test(message)) return true;

          // Supabase schema cache errors look like:
          // "Could not find the 'confidence' column of 'document_extractions' in the schema cache"
          if (/schema cache/i.test(message) && /could not find/i.test(message))
            return true;

          return /could not find/i.test(message) && /column/i.test(message);
        };

        // Try to persist the structured extraction payload, but keep the pipeline operational if
        // the schema hasn't been migrated yet.
        log("EXTRACTION_INSERT_START", { documentId });
        let saveSucceeded = false;
        let lastErrorMessage: string | null = null;
        let successfulAttempt: string | null = null;
        let stripMetadata = false;

        for (const attempt of [
          "structured_data",
          "structured_json",
          "none",
        ] as const) {
          const basePayload = stripMetadata
            ? basePayloadNoMeta
            : basePayloadFull;
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
            if (attempt === "structured_data")
              debug.structured_data_saved = true;
            if (attempt === "structured_json")
              debug.structured_json_saved = true;
            break;
          }

          const msg =
            upsertError?.message ??
            (typeof upsertError === "string"
              ? upsertError
              : upsertError
                ? String(upsertError)
                : "Failed to save extraction.");
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
                const updatedCount = Array.isArray(updatedRows)
                  ? updatedRows.length
                  : 0;
                if (updatedCount > 0) {
                  saveSucceeded = true;
                  successfulAttempt = attempt;
                  if (attempt === "structured_data")
                    debug.structured_data_saved = true;
                  if (attempt === "structured_json")
                    debug.structured_json_saved = true;
                  break;
                }

                const { error: insertError } = await supabase
                  .from("document_extractions")
                  .insert(payload);
                upsertError = insertError;
                if (!insertError) {
                  saveSucceeded = true;
                  successfulAttempt = attempt;
                  if (attempt === "structured_data")
                    debug.structured_data_saved = true;
                  if (attempt === "structured_json")
                    debug.structured_json_saved = true;
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
            (typeof upsertError === "string"
              ? upsertError
              : upsertError
                ? String(upsertError)
                : (lastErrorMessage ?? "Failed to save extraction."));

          const structuredDataMissing =
            attempt === "structured_data" &&
            isMissingColumnError(fallbackMsg, "structured_data");
          const structuredJsonMissing =
            attempt === "structured_json" &&
            isMissingColumnError(fallbackMsg, "structured_json");
          const modelMissing = isMissingColumnError(fallbackMsg, "model");
          const confidenceMissing = isMissingColumnError(
            fallbackMsg,
            "confidence",
          );
          const errorMessageMissing = isMissingColumnError(
            fallbackMsg,
            "error_message",
          );

          if (structuredDataMissing) {
            // Schema out of date; log clearly and continue with a fallback.
            console.error(
              `${LOG_PREFIX} save_extraction: missing 'structured_data' column; continuing without it.`,
              {
                documentId,
                error: fallbackMsg,
              },
            );
            debug.structured_data_retry_used = true;
            continue;
          }

          if (structuredJsonMissing) {
            console.warn(
              `${LOG_PREFIX} save_extraction: missing 'structured_json' column; continuing without it.`,
              {
                documentId,
                error: fallbackMsg,
              },
            );
            debug.structured_json_retry_used = true;
            continue;
          }

          if (modelMissing || confidenceMissing || errorMessageMissing) {
            console.warn(
              `${LOG_PREFIX} save_extraction: missing metadata column(s); retrying without them.`,
              {
                documentId,
                error: fallbackMsg,
                modelMissing,
                confidenceMissing,
                errorMessageMissing,
              },
            );
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
          console.error(
            `${LOG_PREFIX} save_extraction failed (all structured attempts):`,
            { documentId, error: msg },
          );
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
          if (
            dealScoreResult &&
            successfulAttempt &&
            successfulAttempt !== "none"
          ) {
            console.log("SCORE SAVED", dealScoreResult.score);
            console.log(`${LOG_PREFIX} SCORE SAVED`, {
              documentId,
              score: dealScoreResult.score,
              grade: dealGradeFullLabelFromScore(dealScoreResult.score),
              structured_column: successfulAttempt,
            });
            const mirrorPayload =
              successfulAttempt === "structured_data"
                ? { structured_json: structuredExtraction }
                : { structured_data: structuredExtraction };
            const { error: mirrorErr } = await supabase
              .from("document_extractions")
              .update(mirrorPayload)
              .eq("document_id", documentId);
            if (mirrorErr) {
              const m = mirrorErr.message ?? String(mirrorErr);
              if (
                !isMissingColumnError(m, "structured_data") &&
                !isMissingColumnError(m, "structured_json")
              ) {
                console.warn(
                  `${LOG_PREFIX} mirror structured sibling column failed`,
                  {
                    documentId,
                    error: m,
                  },
                );
              }
            }
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logCatchBlock(err, failureStep);
        await markDocumentFailed(supabase, documentId, msg);
        debug.error = msg;
        return okFalse("EXTRACTION_INSERT_START", msg, {
          stack: err instanceof Error ? err.stack : undefined,
        });
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
        estimated_formation?: string | null;
        estimated_depth_min?: number | null;
        estimated_depth_max?: number | null;
        drill_difficulty?: string | null;
        drill_difficulty_score?: number | null;
        drill_difficulty_reason?: string | null;
      };
      let savedExtraction: SavedExtraction | null = null;

      try {
        failureStep = "fetch_saved_extraction";
        debug.failureStep = failureStep;
        log("FETCH_SAVED_EXTRACTION_START");
        const { data, error } = await supabase
          .from("document_extractions")
          .select(
            "id, document_id, extracted_text, lessor, lessee, county, state, legal_description, effective_date, recording_date, royalty_rate, term_length, confidence_score, created_at, structured_data, structured_json, estimated_formation, estimated_depth_min, estimated_depth_max, drill_difficulty, drill_difficulty_score, drill_difficulty_reason",
          )
          .eq("document_id", documentId)
          .maybeSingle();
        if (error) {
          console.error(`${LOG_PREFIX} fetch_saved_extraction failed:`, {
            documentId,
            error: error.message,
          });
          debug.fetch_saved_extraction_error = error.message;
        } else {
          savedExtraction = data as SavedExtraction;
        }
        if (savedExtraction) {
          const structuredJsonCol =
            savedExtraction && "structured_json" in savedExtraction
              ? savedExtraction.structured_json
              : undefined;
          const loaded = dealScoreFromExtractionColumns(
            savedExtraction.structured_data,
            structuredJsonCol,
          );
          console.log("SCORE LOADED", loaded?.score ?? null);
          console.log("GRADE LOADED", loaded?.grade ?? null);
          console.log(
            "GRADE FROM SCORE",
            loaded != null ? getGradeFromScore(loaded.score) : null,
          );
          console.log(`${LOG_PREFIX} SCORE LOADED`, {
            documentId,
            score: loaded?.score ?? null,
            grade:
              loaded != null ? dealGradeFullLabelFromScore(loaded.score) : null,
            source: "document_extractions after save",
          });
        }
        log("FETCH_SAVED_EXTRACTION_SUCCESS", { found: !!savedExtraction });
      } catch (err) {
        logCatchBlock(err, failureStep);
        debug.fetch_saved_extraction_throw =
          err instanceof Error ? err.message : String(err);
      }

      let completedAt = new Date().toISOString();

      try {
        failureStep = "update_status_completed";
        debug.failureStep = failureStep;
        if (debug.error || openAiError) {
          const msg = String(
            openAiError ?? debug.error ?? "Processing failed.",
          );
          await markDocumentFailed(supabase, documentId, msg);
          log("DOCUMENT_STATUS_UPDATED", {
            status: "failed",
            completed_at: completedAt,
          });
          return okFalse("PROCESS_FAILED", msg, {
            status: "failed",
            extraction: savedExtraction,
            document: {
              id: documentId as string,
              status: "failed",
              completed_at: completedAt,
            },
          });
        }

        const { error: updateCompletedError } = await updateDocumentFields(
          supabase,
          documentId,
          {
            status: "completed",
            completed_at: completedAt,
            processed_at: completedAt,
            error_message: null,
          },
        );

        if (updateCompletedError) {
          const msg =
            updateCompletedError.message ??
            "Failed to update completed status.";
          debug.error = msg;
          await markDocumentFailed(supabase, documentId, msg);
          return okFalse("DOCUMENT_STATUS_UPDATED", msg);
        }
        log("DOCUMENT_STATUS_UPDATED", {
          status: "completed",
          completed_at: completedAt,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logCatchBlock(err, failureStep);
        debug.error = msg;
        await markDocumentFailed(supabase, documentId, msg);
        return okFalse("DOCUMENT_STATUS_UPDATED", msg, {
          stack: err instanceof Error ? err.stack : undefined,
        });
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
                structured_json:
                  "structured_json" in savedExtraction
                    ? savedExtraction.structured_json
                    : undefined,
              }
            : null,
        });
      }

      log("PROCESS_COMPLETE");
      const drillForClient = drillSnapshotFromDealInput(
        dealScoreInputForPipeline ?? {},
      );
      const fallbackStructuredForClient = {
        lessor: parsed.lessor,
        lessee: parsed.lessee,
        grantor: parsed.grantor,
        grantee: parsed.grantee,
        parties: parsed.parties,
        county: parsed.county,
        state: parsed.state,
        legal_description: parsed.legal_description,
        effective_date: parsed.effective_date,
        recording_date: parsed.recording_date,
        royalty_rate: parsed.royalty_rate,
        term_length: parsed.term_length,
        document_type: parsed.document_type,
        confidence_score: parsed.confidence_score ?? 0,
        owner: parsed.owner,
        buyer: parsed.buyer,
        acreage: parsed.acreage,
        mailing_address: parsed.mailing_address,
        extraction_status: parsed.extraction_status,
        estimated_formation: drillForClient.estimated_formation,
        estimated_depth_min: drillForClient.estimated_depth_min,
        estimated_depth_max: drillForClient.estimated_depth_max,
        drill_difficulty: drillForClient.drill_difficulty,
        drill_difficulty_score: drillForClient.drill_difficulty_score,
        drill_difficulty_reason: drillForClient.drill_difficulty_reason,
        deal_score:
          dealScoreResult ??
          ({
            score: 0,
            grade: dealGradeFullLabelFromScore(0),
            type: "lead" as const,
            reasons: [] as string[],
          } satisfies DealScoreResult),
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
      const extractionResponse: SavedExtraction =
        savedExtraction ?? fallbackExtractionResponse;

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
        document: {
          id: documentId as string,
          status: "completed",
          completed_at: completedAt,
          processed_at: completedAt,
        },
        extraction: extractionResponse,
        deal_score:
          dealScoreResult ??
          ({
            score: 0,
            grade: dealGradeFullLabelFromScore(0),
            type: "lead" as const,
            reasons: [],
          } satisfies DealScoreResult),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logCatchBlock(err, failureStep);
      if (supabase && documentId) {
        await markDocumentFailed(supabase, documentId, message);
      }
      debug.error = message;
      if (err instanceof Error) debug.stack = err.stack;
      return okFalse(failureStep, message, {
        stack: err instanceof Error ? err.stack : undefined,
      });
    }
  } catch (err) {
    console.error("[process-document] HARD_FAIL", err);
    const message = err instanceof Error ? err.message : String(err);
    console.log("[process-document] COMPLETED_SAFE");
    return NextResponse.json(
      {
        success: false,
        error: "PROCESS_FAILED",
        message: message || "unknown error",
      },
      { status: 200 },
    );
  }
}
