/**
 * Normalizes LLM + heuristic lease/deed fields: heading recovery, party list, document type label.
 */

import { normalizeDocumentTypeLabel } from "./extraction-normalize";
import {
  extractGrantorGranteeFromHeadings,
  extractLessorLesseeFromHeadings,
} from "./heuristic-field-extraction";

/** Single normalized party for scoring / structured storage. */
export type NormalizedPartyEntry = { role: string; name: string; kind?: string };

/** Result of AI + heuristic parsing: structured lease fields and a confidence score (0–1). */
export type ParsedLeaseResult = {
  lessor: string | null;
  lessee: string | null;
  grantor: string | null;
  grantee: string | null;
  /** Deduped roles + names derived from instrument parties (see {@link normalizeParsedLeaseResult}). */
  parties: NormalizedPartyEntry[] | null;
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
  /** Owner-side display (tax rolls, inferred). */
  owner?: string | null;
  /** Buyer / grantee side display. */
  buyer?: string | null;
  /** Net mineral acres when extracted or inferred. */
  acreage?: number | null;
  /** Mailing / postal block when present (tax rolls, notices). */
  mailing_address?: string | null;
  /** Set by structured extraction pipeline: complete | partial | low_confidence | failed */
  extraction_status?: string | null;
};

export function isConveyanceInstrumentHint(documentType: string | null, extractedText: string): boolean {
  const dt = (documentType ?? "").trim();
  if (/\b(deed|assignment|conveyance|mineral\s+deed|warranty\s+deed|quitclaim)\b/i.test(dt)) return true;
  const head = extractedText.slice(0, 6000);
  return /\bMINERAL\s+DEED\b/i.test(head) || /\b(WARRANTY|QUIT\s*CLAIM)\s+DEED\b/i.test(head);
}

export function inferPartyKind(name: string): string {
  if (/\b(LLC|L\.L\.C\.|L\.P\.|LP|Inc\.?|Corp\.?|Corporation|Company|Co\.|Trust|Partners|Ltd\.?|PLC)\b/i.test(name)) {
    return "entity";
  }
  return "person";
}

/** Adds `kind` to LLM-supplied party rows when missing. */
export function withPartyKinds(parties: NormalizedPartyEntry[] | null | undefined): NormalizedPartyEntry[] | null {
  if (!parties?.length) return null;
  return parties.map((p) => ({
    ...p,
    kind: p.kind ?? inferPartyKind(p.name),
  }));
}

function appendPartyUnique(out: NormalizedPartyEntry[], role: string, name: string | null | undefined): void {
  if (name == null || typeof name !== "string") return;
  const n = name.trim();
  if (!n) return;
  if (out.some((p) => p.role === role && p.name === n)) return;
  out.push({ role, name: n, kind: inferPartyKind(n) });
}

/** Builds a deduped role/name list for deal scoring when `parties` is not already persisted. */
export function buildNormalizedPartiesForDealScoreInput(args: {
  grantor: string | null;
  grantee: string | null;
  lessor: string | null;
  lessee: string | null;
  document_type: string | null;
  extractedText: string;
}): NormalizedPartyEntry[] | null {
  const deedLike = isConveyanceInstrumentHint(args.document_type, args.extractedText);
  let g = args.grantor?.trim() ? args.grantor.trim() : null;
  let r = args.grantee?.trim() ? args.grantee.trim() : null;
  const lessor = args.lessor?.trim() ? args.lessor.trim() : null;
  const lessee = args.lessee?.trim() ? args.lessee.trim() : null;

  if (deedLike) {
    if (!g && lessor) g = lessor;
    if (!r && lessee) r = lessee;
  }

  const out: NormalizedPartyEntry[] = [];
  if (g) appendPartyUnique(out, "grantor", g);
  if (r) appendPartyUnique(out, "grantee", r);
  if (lessor && lessor !== g) appendPartyUnique(out, "lessor", lessor);
  if (lessee && lessee !== r) appendPartyUnique(out, "lessee", lessee);

  if (out.length === 0 && (lessor || lessee)) {
    if (lessor) appendPartyUnique(out, "lessor", lessor);
    if (lessee) appendPartyUnique(out, "lessee", lessee);
  }

  return out.length > 0 ? out : null;
}

/**
 * Fills grantor/grantee/lessor/lessee from headings when missing, aligns lessor/lessee for conveyances,
 * normalizes `document_type`, and builds `parties`.
 *
 * @param fullTextForHeadingRecovery Native + OCR + raw combined when available so labels on any layer apply.
 */
export function normalizeParsedLeaseResult(
  parsed: {
    lessor: string | null;
    lessee: string | null;
    grantor: string | null;
    grantee: string | null;
    county: string | null;
    state: string | null;
    legal_description: string | null;
    effective_date: string | null;
    recording_date: string | null;
    royalty_rate: string | null;
    term_length: string | null;
    document_type: string | null;
    confidence_score: number;
    parties?: NormalizedPartyEntry[] | null;
    owner?: string | null;
    buyer?: string | null;
    acreage?: number | null;
    mailing_address?: string | null;
  },
  fullTextForHeadingRecovery: string
): ParsedLeaseResult {
  let grantor = parsed.grantor ?? null;
  let grantee = parsed.grantee ?? null;
  let lessor = parsed.lessor ?? null;
  let lessee = parsed.lessee ?? null;
  let document_type = parsed.document_type ?? null;

  const scan = fullTextForHeadingRecovery?.trim() ? fullTextForHeadingRecovery : "";
  const fromGg = extractGrantorGranteeFromHeadings(scan);
  if (!grantor && fromGg.grantor) grantor = fromGg.grantor;
  if (!grantee && fromGg.grantee) grantee = fromGg.grantee;

  const fromLl = extractLessorLesseeFromHeadings(scan);
  if (!lessor && fromLl.lessor) lessor = fromLl.lessor;
  if (!lessee && fromLl.lessee) lessee = fromLl.lessee;

  document_type = normalizeDocumentTypeLabel(document_type);

  const deedLike = isConveyanceInstrumentHint(document_type, scan);
  if (deedLike) {
    if (!lessor && grantor) lessor = grantor;
    if (!lessee && grantee) lessee = grantee;
  }

  const parties =
    Array.isArray(parsed.parties) && parsed.parties.length > 0
      ? parsed.parties
      : buildNormalizedPartiesForDealScoreInput({
          grantor,
          grantee,
          lessor,
          lessee,
          document_type,
          extractedText: scan,
        });

  return {
    ...parsed,
    lessor,
    lessee,
    grantor,
    grantee,
    parties,
    document_type,
    owner: parsed.owner ?? null,
    buyer: parsed.buyer ?? null,
    acreage: parsed.acreage ?? null,
    mailing_address: parsed.mailing_address ?? null,
  };
}
