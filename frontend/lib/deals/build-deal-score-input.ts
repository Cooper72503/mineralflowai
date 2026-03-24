import {
  buildNormalizedPartiesForDealScoreInput,
  normalizeDocumentTypeLabel,
} from "@/lib/document-processing";
import { parseAcreageFromLegalDescription } from "@/lib/document-processing/parse-acreage-from-legal";

/** Below this, lease-parse columns and matching structured fields are ignored for deal scoring. */
const LOW_CONFIDENCE_DEAL_SCORE_THRESHOLD = 0.6;

function isLowLeaseParseConfidence(confidence: number | null | undefined): boolean {
  if (confidence == null) return false;
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return false;
  return confidence < LOW_CONFIDENCE_DEAL_SCORE_THRESHOLD;
}

/** Matches deal-score `readNonEmptyString` for lease_status — values the scorer will actually use. */
export function hasUsableLeaseStatusForDealScore(input: Record<string, unknown>): boolean {
  const v = input.lease_status;
  if (v == null) return false;
  if (typeof v === "string" && v.trim() !== "") return true;
  return false;
}

function documentTypeIncludesMineralDeed(documentType: string | null | undefined): boolean {
  if (typeof documentType !== "string") return false;
  return documentType.toLowerCase().includes("mineral deed");
}

function extractedTextContainsMineralDeedPhrase(extractedText: string): boolean {
  return extractedText.includes("MINERAL DEED");
}

export function mineralDeedSignalsForLeaseFallback(args: {
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

export type ParsedFieldsForDealScore = {
  lessor: string | null;
  lessee: string | null;
  grantor: string | null;
  grantee: string | null;
  /** Optional; rebuilt in {@link buildDealScoreInput} when missing. */
  parties?: unknown;
  county: string | null;
  state: string | null;
  legal_description: string | null;
  effective_date: string | null;
  recording_date: string | null;
  royalty_rate: string | null;
  term_length: string | null;
  document_type: string | null;
  confidence_score: number | null;
  owner?: string | null;
  buyer?: string | null;
  acreage?: number | null;
  mailing_address?: string | null;
  extraction_status?: string | null;
};

/** Structured / column fields produced by the lease extraction pass (same scope as ParsedFieldsForDealScore). */
const EXTRACTION_BACKED_DEAL_INPUT_KEYS = [
  "lessor",
  "lessee",
  "grantor",
  "grantee",
  "parties",
  "owner",
  "owner_name",
  "ownerName",
  "county",
  "state",
  "legal_description",
  "effective_date",
  "recording_date",
  "royalty_rate",
  "lease_status",
  "acreage",
  "net_acreage",
  "net_mineral_acres",
  "term_length",
  "document_type",
  "owner",
  "owner_name",
  "buyer",
] as const;

function parsedFieldsWithReducedTrust(parsed: ParsedFieldsForDealScore): ParsedFieldsForDealScore {
  return {
    ...parsed,
    lessor: null,
    lessee: null,
    grantor: null,
    grantee: null,
    parties: undefined,
    county: null,
    state: null,
    legal_description: null,
    effective_date: null,
    recording_date: null,
    royalty_rate: null,
    term_length: null,
    document_type: null,
    owner: null,
    buyer: null,
    acreage: null,
    extraction_status: parsed.extraction_status ?? null,
  };
}

function hasAnyParsedExtractionContent(parsed: ParsedFieldsForDealScore): boolean {
  const s = (v: string | null | undefined) => typeof v === "string" && v.trim() !== "";
  return (
    s(parsed.grantor) ||
    s(parsed.grantee) ||
    s(parsed.lessor) ||
    s(parsed.lessee) ||
    s(parsed.owner) ||
    s(parsed.buyer) ||
    s(parsed.county) ||
    s(parsed.state) ||
    s(parsed.legal_description) ||
    s(parsed.document_type)
  );
}

function stripExtractionBackedKeysFromDealInput(input: Record<string, unknown>): void {
  for (const k of EXTRACTION_BACKED_DEAL_INPUT_KEYS) {
    delete input[k];
  }
}

export type DocumentMetaForDealScore = {
  county: string | null;
  state: string | null;
  document_type: string | null;
};

/**
 * Builds the record passed into {@link calculateDealScore}, matching the process pipeline
 * (optional baseline from request or persisted structured blob, then parsed + document columns).
 */
export function buildDealScoreInput(args: {
  optionalBaseline?: Record<string, unknown> | null;
  parsed: ParsedFieldsForDealScore;
  doc: DocumentMetaForDealScore;
  extractedText: string;
  /** When the deal was processed (ISO); drives the “recent processed document” bonus. */
  documentProcessedAtIso?: string | null;
}): Record<string, unknown> {
  const dealScoreInput: Record<string, unknown> = { ...(args.optionalBaseline ?? {}) };
  delete dealScoreInput.deal_score;

  const extractionNeedsReview =
    args.parsed.extraction_status === "partial" ||
    args.parsed.extraction_status === "low_confidence";
  const lowTrust =
    isLowLeaseParseConfidence(args.parsed.confidence_score) &&
    !extractionNeedsReview &&
    !hasAnyParsedExtractionContent(args.parsed);
  if (lowTrust) {
    stripExtractionBackedKeysFromDealInput(dealScoreInput);
  }

  const parsed = lowTrust ? parsedFieldsWithReducedTrust(args.parsed) : args.parsed;

  dealScoreInput.recording_date = dealScoreInput.recording_date ?? parsed.recording_date;
  dealScoreInput.effective_date = dealScoreInput.effective_date ?? parsed.effective_date;
  dealScoreInput.document_type =
    normalizeDocumentTypeLabel(
      (typeof dealScoreInput.document_type === "string" && dealScoreInput.document_type.trim()
        ? dealScoreInput.document_type
        : null) ??
        parsed.document_type ??
        args.doc.document_type ??
        null
    );
  dealScoreInput.extraction_confidence =
    typeof dealScoreInput.extraction_confidence === "number" && Number.isFinite(dealScoreInput.extraction_confidence)
      ? dealScoreInput.extraction_confidence
      : typeof dealScoreInput.confidence_score === "number" && Number.isFinite(dealScoreInput.confidence_score)
        ? dealScoreInput.confidence_score
        : parsed.confidence_score;

  if (parsed.extraction_status != null) {
    dealScoreInput.extraction_status = parsed.extraction_status;
  }

  if (dealScoreInput.acreage === undefined || dealScoreInput.acreage === null) {
    const fromLegal = parseAcreageFromLegalDescription(parsed.legal_description);
    if (fromLegal !== undefined) {
      dealScoreInput.acreage = fromLegal;
    } else if (typeof parsed.acreage === "number" && Number.isFinite(parsed.acreage)) {
      dealScoreInput.acreage = parsed.acreage;
    }
  }

  const mineralDeedSignals = mineralDeedSignalsForLeaseFallback({
    metadataDocumentType: args.doc.document_type,
    extractedText: args.extractedText,
    parsedDocumentType: parsed.document_type,
  });
  if (!hasUsableLeaseStatusForDealScore(dealScoreInput) && mineralDeedSignals.length > 0) {
    dealScoreInput.lease_status = "none";
  }

  dealScoreInput.county =
    dealScoreInput.county ?? parsed.county ?? args.doc.county ?? null;
  dealScoreInput.state =
    dealScoreInput.state ?? parsed.state ?? args.doc.state ?? null;
  dealScoreInput.legal_description =
    (typeof dealScoreInput.legal_description === "string" && dealScoreInput.legal_description.trim()
      ? dealScoreInput.legal_description
      : null) ?? parsed.legal_description;

  const existingLessor = dealScoreInput.lessor;
  const lessorFromParsed = parsed.lessor;
  if (existingLessor == null || (typeof existingLessor === "string" && !existingLessor.trim())) {
    dealScoreInput.lessor = lessorFromParsed;
  }

  const existingLessee = dealScoreInput.lessee;
  if (existingLessee == null || (typeof existingLessee === "string" && !existingLessee.trim())) {
    dealScoreInput.lessee = parsed.lessee;
  }

  const existingGrantor = dealScoreInput.grantor;
  if (existingGrantor == null || (typeof existingGrantor === "string" && !existingGrantor.trim())) {
    dealScoreInput.grantor = parsed.grantor;
  }

  const existingGrantee = dealScoreInput.grantee;
  if (existingGrantee == null || (typeof existingGrantee === "string" && !existingGrantee.trim())) {
    dealScoreInput.grantee = parsed.grantee;
  }

  const own = dealScoreInput.owner ?? dealScoreInput.owner_name;
  if (own == null || (typeof own === "string" && !own.trim())) {
    if (parsed.owner?.trim()) {
      dealScoreInput.owner = parsed.owner.trim();
      dealScoreInput.owner_name = parsed.owner.trim();
    }
  }

  const mail = dealScoreInput.mailing_address;
  if (mail == null || (typeof mail === "string" && !mail.trim())) {
    if (parsed.mailing_address?.trim()) {
      dealScoreInput.mailing_address = parsed.mailing_address.trim();
    }
  }

  const ep = dealScoreInput.parties;
  const hasPartiesArray = Array.isArray(ep) && ep.length > 0;
  if (!hasPartiesArray) {
    const built = buildNormalizedPartiesForDealScoreInput({
      grantor: typeof dealScoreInput.grantor === "string" ? dealScoreInput.grantor : parsed.grantor,
      grantee: typeof dealScoreInput.grantee === "string" ? dealScoreInput.grantee : parsed.grantee,
      lessor: typeof dealScoreInput.lessor === "string" ? dealScoreInput.lessor : parsed.lessor,
      lessee: typeof dealScoreInput.lessee === "string" ? dealScoreInput.lessee : parsed.lessee,
      document_type:
        typeof dealScoreInput.document_type === "string" ? dealScoreInput.document_type : parsed.document_type,
      extractedText: args.extractedText ?? "",
    });
    if (built) dealScoreInput.parties = built;
  }

  const trimmedText = (args.extractedText ?? "").trim();
  dealScoreInput.extracted_text_length = trimmedText.length;

  const processedIso = args.documentProcessedAtIso?.trim();
  if (processedIso) {
    dealScoreInput.document_processed_at = processedIso;
  }

  const baseRoy = dealScoreInput.royalty_rate;
  if (typeof baseRoy !== "string" || !baseRoy.trim()) {
    dealScoreInput.royalty_rate = parsed.royalty_rate;
  }

  return dealScoreInput;
}
