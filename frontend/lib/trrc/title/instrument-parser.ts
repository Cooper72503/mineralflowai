/**
 * Deterministic instrument parser — regex/keyword extraction from document
 * text into the validated ExtractedDocument shape. Always runs; the Claude
 * extractor (claude-extractor.ts) is an optional enrichment layered on top
 * when a key is configured. Nothing here calls a model.
 *
 * Discipline: unknown -> null. Two plausible readings -> both recorded in
 * `alternatives`. Verbatim excerpts preserved for every material field.
 * Confidence is capped at 0.7 because pattern matching over OCR'd deed
 * text cannot verify legal effect — a reviewer can.
 *
 * Page tracking: document-text.ts joins pages with a form-feed (\f). Every
 * excerpt records the 1-based page it was found on.
 *
 * Untrusted input: the text is data. No token in it is ever interpreted as
 * an instruction to this parser (there is no instruction channel here).
 */

import { parseTexasLegalDescription, normalizeAbstractNumber } from "../offset-analytics/legal-description";
import type {
  ExtractedDocument, ExtractedInstrument, ExtractedParty, ExtractedTract, ExtractedReference, ExtractedDate,
} from "./instrument-schema";
import { Fraction } from "./fraction";

type InstrumentType = ExtractedInstrument["instrumentType"];
type PartyRole = ExtractedParty["role"];
type PartyCapacity = ExtractedParty["capacity"];

// ─── Page helpers ────────────────────────────────────────────────────────────

interface Located { page: number; index: number }

function pageOf(text: string, index: number): number {
  let page = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 12) page++;
  return page;
}

function excerptAround(text: string, index: number, radius = 160): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + radius);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

/** matchAll replacement that works under the project's ES5 target (no iterator downleveling). */
function allMatches(text: string, re: RegExp): RegExpExecArray[] {
  const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
  const rx = new RegExp(re.source, flags);
  const out: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = rx.exec(text)) !== null) {
    out.push(m);
    if (m[0].length === 0) rx.lastIndex++;
  }
  return out;
}

function firstMatch(text: string, re: RegExp): (RegExpMatchArray & Located) | null {
  const m = text.match(re);
  if (!m || m.index === undefined) return null;
  return Object.assign(m, { page: pageOf(text, m.index), index: m.index });
}

// ─── Document kind ───────────────────────────────────────────────────────────

export function classifyDocumentKind(text: string): ExtractedDocument["documentKind"] {
  const t = text.toLowerCase();
  if (/application for permit to drill|form w-1\b|drilling permit application/.test(t)) return "w1_application";
  if (/completion report|form w-2\b|form g-1\b|well completion/.test(t)) return "completion_report";
  if (/\bplat\b/.test(t) && /surveyor|registered professional land surveyor|r\.p\.l\.s/.test(t)) return "location_plat";
  if (/grantor|grantee|lessor|lessee|assignor|assignee|convey|hereby grant|affidavit of heirship|last will|letters testamentary|deed of trust|release of lien/.test(t)) return "instrument";
  if (/instrument\s*(no|#)|recording date|doc(ument)?\s*(no|#)/.test(t) && /grantor[\s\S]*grantee/.test(t)) return "index_listing";
  return "other";
}

// ─── Instrument type ─────────────────────────────────────────────────────────

const TYPE_PATTERNS: Array<[RegExp, InstrumentType]> = [
  [/correction\s+(warranty\s+)?deed|corrective\s+deed/i, "correction_deed"],
  [/deed\s+of\s+trust/i, "deed_of_trust"],
  [/release\s+of\s+(lien|deed\s+of\s+trust|oil\s+and\s+gas\s+lease|mortgage)|\brelease\b(?!.*reserv)/i, "release"],
  [/affidavit\s+of\s+heirship/i, "affidavit_of_heirship"],
  [/last\s+will\s+and\s+testament|letters\s+testamentary|order\s+admitting\s+will|probate|letters\s+of\s+administration|judgment\s+declaring\s+heirship/i, "probate"],
  [/mineral\s+deed/i, "mineral_deed"],
  [/royalty\s+deed|royalty\s+conveyance/i, "royalty_deed"],
  [/assignment(\s+and\s+bill\s+of\s+sale)?(\s+of\s+(oil\s+and\s+gas\s+lease|overriding\s+royalty|interest))?/i, "assignment"],
  [/oil,?\s+gas\s+(and|&)\s+(other\s+)?mineral\s+lease|oil\s+(and|&)\s+gas\s+lease|\bpaid[- ]up\s+lease/i, "lease"],
  [/unit\s+(designation|agreement)|declaration\s+of\s+pool(ing|ed)\s+unit/i, "unit_agreement"],
  [/mechanic'?s\s+lien|judgment\s+lien|abstract\s+of\s+judgment|tax\s+lien|\blien\b/i, "lien"],
  [/reservation\s+of\s+(mineral|royalty)/i, "reservation"],
  [/(general|special)\s+warranty\s+deed|warranty\s+deed|quitclaim\s+deed|\bdeed\b/i, "deed"],
];

export function classifyInstrumentType(text: string): { type: InstrumentType; verbatim: string | null } {
  const head = text.slice(0, 4000);
  for (const [re, type] of TYPE_PATTERNS) {
    const m = head.match(re) ?? text.match(re);
    if (m) return { type, verbatim: m[0].replace(/\s+/g, " ").trim() };
  }
  return { type: "other", verbatim: null };
}

// ─── Dates ───────────────────────────────────────────────────────────────────

const MONTHS: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04", may: "05", june: "06", july: "07", august: "08",
  september: "09", october: "10", november: "11", december: "12",
  jan: "01", feb: "02", mar: "03", apr: "04", jun: "06", jul: "07", aug: "08", sep: "09", sept: "09", oct: "10", nov: "11", dec: "12",
};

const ORDINAL_DATE = /(\d{1,2})(?:st|nd|rd|th)?\s+day\s+of\s+([A-Za-z]+),?\s+(?:A\.?D\.?\s+)?(\d{4})/i;
const LONG_DATE = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/;
const NUMERIC_DATE = /\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})\b/;

export function normalizeDateText(raw: string): string | null {
  const ord = raw.match(ORDINAL_DATE);
  if (ord) {
    const mm = MONTHS[ord[2].toLowerCase()];
    if (mm) return `${ord[3]}-${mm}-${ord[1].padStart(2, "0")}`;
  }
  const lng = raw.match(LONG_DATE);
  if (lng) {
    const mm = MONTHS[lng[1].toLowerCase()];
    if (mm) return `${lng[3]}-${mm}-${lng[2].padStart(2, "0")}`;
  }
  const num = raw.match(NUMERIC_DATE);
  if (num) {
    const year = num[3].length === 2 ? (Number(num[3]) > 30 ? `19${num[3]}` : `20${num[3]}`) : num[3];
    return `${year}-${num[1].padStart(2, "0")}-${num[2].padStart(2, "0")}`;
  }
  const yearOnly = raw.match(/\b(18|19|20)\d{2}\b/);
  return yearOnly ? yearOnly[0] : null;
}

/**
 * Scans EVERY anchor occurrence, not just the first, and returns the first
 * one whose following window actually contains a date.
 *
 * Real bug this fixes: the recording anchor's bare `recorded` alternative
 * matches the habendum reference ("...conveyed to Grantor by deed recorded
 * in Volume 210, Page 44...") long before the filing stamp at the foot of
 * the instrument. Taking only the first hit scanned a dateless window and
 * left recordedDate null on a deed that plainly states one. Dropping the
 * bare alternative is NOT an option — real instruments do stamp "Recorded
 * on ..." as the filing wording — so the ambiguity is resolved by position
 * instead: preferLast walks the matches in reverse, which is where a
 * recording stamp lives, while body references sit earlier.
 */
function findDate(text: string, anchors: RegExp, opts: { preferLast?: boolean } = {}): ExtractedDate {
  const matches = allMatches(text, anchors);
  const ordered = opts.preferLast ? matches.slice().reverse() : matches;
  for (const m of ordered) {
    const index = m.index ?? 0;
    const window = text.slice(index, index + 160);
    const iso = normalizeDateText(window);
    if (!iso) continue;   // a dateless anchor hit is skipped, not treated as "no date anywhere"
    const verbatim = window.match(ORDINAL_DATE)?.[0] ?? window.match(LONG_DATE)?.[0] ?? window.match(NUMERIC_DATE)?.[0] ?? null;
    return { iso, verbatim };
  }
  return { iso: null, verbatim: null };
}

// ─── Recording references ────────────────────────────────────────────────────

const VOL_PAGE = /(?:vol(?:ume)?\.?|book|bk\.?)\s*(\d+)[,\s]+(?:page|pg\.?|p\.)\s*(\d+)/gi;
const DOC_NO = /(?:document|doc\.?|instrument|inst\.?|clerk'?s\s+file|file|recording)\s*(?:no\.?|#|number)\s*[:\s]*([0-9][0-9-]{3,})/gi;

export function findRecordingReferences(text: string): Array<{ kind: "vol_page" | "doc_no"; value: string; index: number; page: number }> {
  const out: Array<{ kind: "vol_page" | "doc_no"; value: string; index: number; page: number }> = [];
  for (const m of allMatches(text, VOL_PAGE)) out.push({ kind: "vol_page", value: `Vol. ${m[1]}, Pg. ${m[2]}`, index: m.index ?? 0, page: pageOf(text, m.index ?? 0) });
  for (const m of allMatches(text, DOC_NO)) out.push({ kind: "doc_no", value: m[1].replace(/-$/, ""), index: m.index ?? 0, page: pageOf(text, m.index ?? 0) });
  return out.sort((a, b) => a.index - b.index);
}

// ─── Parties ─────────────────────────────────────────────────────────────────

const ROLE_LABELS: Array<[RegExp, PartyRole]> = [
  [/\bgrantors?\b/i, "grantor"], [/\bgrantees?\b/i, "grantee"],
  [/\blessors?\b/i, "lessor"], [/\blessees?\b/i, "lessee"],
  [/\bassignors?\b/i, "assignor"], [/\bassignees?\b/i, "assignee"],
  [/\bmortgagor|\bborrower/i, "borrower"], [/\bmortgagee|\blender|\bbeneficiary/i, "lender"],
  [/\bdecedent|\bdeceased/i, "decedent"], [/\bheirs?\b/i, "heir"], [/\bdevisees?\b/i, "devisee"],
  [/\bexecut(or|rix)|\badministrat(or|rix)/i, "executor"],
];

export function inferCapacity(nameChunk: string): { capacity: PartyCapacity; detail: string | null } {
  const s = nameChunk;
  if (/\btrustee\b/i.test(s)) return { capacity: "trustee", detail: s.match(/trustee[^,.;]*/i)?.[0] ?? "Trustee" };
  if (/independent\s+(executor|executrix|administrator|administratrix)|\bexecut(or|rix)\s+of|\badministrat(or|rix)\s+of/i.test(s)) return { capacity: "executor_administrator", detail: s.match(/(independent\s+)?(execut(or|rix)|administrat(or|rix))[^,.;]*/i)?.[0] ?? null };
  if (/attorney[- ]in[- ]fact|by\s+and\s+through\s+(his|her|its)\s+agent/i.test(s)) return { capacity: "attorney_in_fact", detail: s.match(/attorney[- ]in[- ]fact[^,.;]*/i)?.[0] ?? null };
  if (/\bheir\b|\bdevisee\b|sole\s+heir/i.test(s)) return { capacity: "heir_devisee", detail: null };
  if (/successor(\s+in\s+interest|\s+by\s+merger)?/i.test(s)) return { capacity: "successor", detail: s.match(/successor[^,.;]*/i)?.[0] ?? null };
  if (/\b(llc|l\.l\.c\.|inc\.?|incorporated|corporation|corp\.?|company|co\.|lp|l\.p\.|ltd\.?|limited partnership|trust\b|bank|partners(hip)?)\b/i.test(s)) return { capacity: "entity", detail: null };
  if (/husband\s+and\s+wife|\bet\s+ux\b|\bet\s+vir\b|\bwife\b|\bhusband\b/i.test(s)) return { capacity: "spouse", detail: "Spousal joinder language present" };
  if (/^[A-Z][A-Za-z.'-]+(\s+[A-Z][A-Za-z.'-]+){1,3}$/.test(s.trim())) return { capacity: "individual", detail: null };
  return { capacity: "unknown", detail: null };
}

const MARITAL_OR_STATUS = /,?\s*(?:husband\s+and\s+wife|wife\s+and\s+husband|a\s+single\s+(?:man|woman|person)|a\s+married\s+(?:man|woman)|(?:each\s+)?dealing\s+(?:in|with)\s+(?:his|her|their)\s+sole\s+and\s+separate\s+property|individually(?:\s+and\s+as\s+[^,;]+)?|joined\s+(?:herein\s+)?by\s+(?:his|her)\s+(?:wife|husband))/gi;

function cleanName(raw: string): string {
  return raw
    .replace(/^\s*(?:that\s+)?(?:we|i)\s*,\s*/i, "")
    .replace(/^.*\b(?:unto|to|from|by)\s+(?=[A-Z])/, "")
    .replace(/\(\s*"?(grantor|grantee|lessor|lessee|assignor|assignee|borrower|lender|beneficiary)s?"?\s*\)/gi, "")
    .replace(/\b(hereinafter|herein)\s+(called|referred\s+to\s+as)\b.*$/i, "")
    .replace(/\s+whose\s+(mailing\s+)?address\b.*$/i, "")
    .replace(/,?\s*of\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s+County,?\s+Texas.*$/i, "")
    .replace(MARITAL_OR_STATUS, "")
    .replace(/\s+/g, " ")
    .replace(/^[,\s]+|[,\s]+$/g, "")
    .trim();
}

function splitNames(chunk: string): string[] {
  const prepared = chunk.replace(MARITAL_OR_STATUS, "").replace(/^\s*(?:that\s+)?(?:we|i)\s*,\s*/i, "");
  return prepared
    .split(/\s*(?:,\s*and|\band\b|&|;)\s*/i)
    .map(s => cleanName(s))
    .filter(s => s.length >= 3 && s.length <= 120 && !/^(a|an|the|wife|husband|for\s+value)\b/i.test(s) && /[A-Za-z]{2,}/.test(s));
}

export function extractParties(text: string): ExtractedParty[] {
  const parties: ExtractedParty[] = [];
  const seen = new Set<string>();
  const push = (name: string, nameVerbatim: string, role: PartyRole, index: number) => {
    const key = `${role}|${name.toLowerCase()}`;
    if (seen.has(key) || !name) return;
    seen.add(key);
    const cap = inferCapacity(nameVerbatim);
    parties.push({ name, nameVerbatim, role, capacity: cap.capacity, capacityDetail: cap.detail, page: pageOf(text, index), excerpt: excerptAround(text, index, 120) });
  };

  // Pattern 1: "GRANTOR: John Smith" / "Lessor: ..." labels on their own line
  const LABELED = /\b(grantors?|grantees?|lessors?|lessees?|assignors?|assignees?|borrowers?|lenders?|beneficiary|decedent|mortgagors?|mortgagees?)\s*[:\-]\s*([^\n]{3,200})/gi;
  for (const m of allMatches(text, LABELED)) {
    const role = ROLE_LABELS.find(([re]) => re.test(m[1]))?.[1] ?? "other";
    for (const n of splitNames(m[2])) push(n, m[2].trim(), role, m.index ?? 0);
  }

  // Pattern 2: "... John Smith ("Grantor") ..." / "John Smith, hereinafter called Grantor"
  const INLINE = /([A-Z][A-Za-z.,'&\- ]{3,140}?)\s*(?:\(\s*"?|,\s*(?:hereinafter\s+)?(?:called|referred\s+to\s+as)\s+"?)(grantors?|grantees?|lessors?|lessees?|assignors?|assignees?|borrower|lender|beneficiary)"?\s*\)?/gi;
  for (const m of allMatches(text, INLINE)) {
    const role = ROLE_LABELS.find(([re]) => re.test(m[2]))?.[1] ?? "other";
    for (const n of splitNames(m[1])) push(n, m[1].trim(), role, m.index ?? 0);
  }

  // Pattern 3: "between A and B, as Grantor(s), and C, as Grantee(s)"
  const BETWEEN = /between\s+([\s\S]{3,220}?),?\s+as\s+(grantors?|lessors?|assignors?)\s*,?\s+and\s+([\s\S]{3,220}?),?\s+as\s+(grantees?|lessees?|assignees?)/i;
  const b = firstMatch(text, BETWEEN);
  if (b) {
    for (const n of splitNames(b[1])) push(n, b[1].trim(), ROLE_LABELS.find(([re]) => re.test(b[2]))?.[1] ?? "grantor", b.index);
    for (const n of splitNames(b[3])) push(n, b[3].trim(), ROLE_LABELS.find(([re]) => re.test(b[4]))?.[1] ?? "grantee", b.index);
  }

  // Heirship / probate: decedent + heirs
  const DECEDENT = /(?:estate\s+of|decedent,?\s+)([A-Z][A-Za-z.'\- ]{3,80}?)(?:,|\s+deceased|\s+who\s+died)/g;
  for (const m of allMatches(text, DECEDENT)) push(cleanName(m[1]), m[1].trim(), "decedent", m.index ?? 0);
  const HEIRS = /(?:surviv(?:ed|ing)\s+by|heirs?\s+(?:at\s+law\s+)?(?:are|were|is|being)|devised?\s+to|bequeath(?:ed)?\s+to)\s*[:\-]?\s*([^.]{3,300})/gi;
  for (const m of allMatches(text, HEIRS)) for (const n of splitNames(m[1])) push(n, m[1].trim(), /devis|bequeath/i.test(m[0]) ? "devisee" : "heir", m.index ?? 0);

  return parties;
}

// ─── Fractions / interests ───────────────────────────────────────────────────

// The `(?:\s*\(\s*\d+\s*\/\s*\d+\s*\))?` group is not cosmetic. Texas deeds
// conventionally state a fraction in words followed by the numeral in
// parentheses — "an undivided one-half (1/2) interest". Without it the
// parenthetical severs the fraction from its noun, the whole phrase fails to
// match, and the scan runs on to the NEXT candidate in the same sentence:
// "all of the oil, gas", which reports a full interest where the instrument
// reserves half. That is a silent doubling of a reserved mineral interest on
// a very common drafting pattern, so it must be matched, not worked around.
const FRACTION_TEXT = /(?:an?\s+)?(?:undivided\s+)?((?:\d+\s*\/\s*\d+(?:ths?|rds?|nds?)?(?:\s+of\s+\d+\s*\/\s*\d+(?:ths?|rds?|nds?)?)*)|(?:one|two|three)[- ](?:half|third|thirds|fourth|fourths|quarter|quarters|eighth|eighths|sixteenth|sixteenths|thirty[- ]second)|all|\d+(?:\.\d+)?\s*%)(?:\s*\(\s*\d+\s*\/\s*\d+\s*\))?\s*(?:of\s+)?(?:(?:the|our|my|his|her|their|grantor'?s?)\s+)?(?:undivided\s+)?(?:right,?\s+title,?\s+(?:and|&)\s+interest|interest|royalty|minerals?|oil,?\s+gas)/gi;

function fractionEntry(verbatim: string, index: number, text: string): ExtractedTract["fraction"] {
  const f = Fraction.parse(verbatim);
  const basis: NonNullable<ExtractedTract["fraction"]>["basis"] =
    /grantor'?s?\s+(?:undivided\s+)?(?:right|interest)|of\s+(?:the\s+)?interest\s+(?:owned|held)\s+by|all\s+of\s+(?:grantor'?s|our|my|his|her|their)/i.test(excerptAround(text, index, 80))
      ? "of_grantor_interest"
      : /undivided|of\s+(?:the\s+)?(?:oil,?\s+gas|minerals)|in\s+and\s+to\s+(?:all\s+)?(?:the\s+)?(?:oil|minerals)|of\s+8\s*\/\s*8/i.test(excerptAround(text, index, 80))
        ? "of_entire_estate"
        : "unknown";
  return { numerator: f ? Number(f.n) : null, denominator: f ? Number(f.d) : null, verbatim, basis };
}

function interestTypeFor(window: string): ExtractedTract["interestType"] {
  const w = window.toLowerCase();
  if (/non[- ]?participating\s+royalty|\bnpri\b/.test(w)) return "nonparticipating_royalty";
  if (/overriding\s+royalty|\borri\b/.test(w)) return "overriding_royalty";
  if (/executive\s+right/.test(w)) return "executive";
  if (/royalty/.test(w)) return "royalty";
  if (/working\s+interest|leasehold/.test(w)) return "working_interest";
  if (/mineral|oil,?\s+gas/.test(w)) return "mineral";
  if (/surface/.test(w)) return "surface";
  return "unknown";
}

// ─── Tracts ──────────────────────────────────────────────────────────────────

function baseTract(text: string, index: number): Omit<ExtractedTract, "interestType" | "effect" | "fraction"> {
  const around = text.slice(Math.max(0, index - 600), Math.min(text.length, index + 900));
  const legal = parseTexasLegalDescription(around);
  const legalSentence = around.match(/[^.;\n]*(?:survey|abstract|block|section|tract)[^.;\n]*/i)?.[0]?.replace(/\s+/g, " ").trim() ?? null;
  return {
    legalDescriptionVerbatim: legalSentence,
    county: legal?.county ?? around.match(/\b([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)?)\s+County,?\s+Texas/)?.[1] ?? null,
    abstractNumber: legal?.canonicalAbstractNumber ?? normalizeAbstractNumber(around) ?? null,
    surveyName: legal?.surveyName ?? null,
    blockNumber: legal?.block ?? null,
    sectionName: legal?.section ?? null,
    tractLabel: legal?.tractNumber ?? null,
    grossAcres: legal?.grossAcres ?? null,
    reservationText: null,
    exceptionsText: null,
    depthOrFormationLimit: around.match(/(?:limited\s+to|from\s+the\s+surface\s+(?:of\s+the\s+earth\s+)?(?:down\s+)?to|below\s+the\s+(?:base|top)\s+of|depths?\s+(?:below|above)|(?:the\s+)?(?:[A-Z][a-z]+\s+)?formation)[^.;]{0,120}/i)?.[0] ?? null,
    page: pageOf(text, index),
    excerpt: excerptAround(text, index, 220),
  };
}

function extractTracts(text: string, type: InstrumentType): { tracts: ExtractedTract[]; alternatives: ExtractedInstrument["alternatives"] } {
  const tracts: ExtractedTract[] = [];
  const alternatives: ExtractedInstrument["alternatives"] = [];
  const legalAnchor = firstMatch(text, /\b(?:abstract|survey|block\s+\d|section\s+\d|acres?)\b/i);
  const anchorIndex = legalAnchor?.index ?? Math.min(text.length, 400);

  const isConveyance = ["deed", "mineral_deed", "royalty_deed", "correction_deed", "assignment"].includes(type);
  const reservationMatch = firstMatch(text, /(?:there\s+is\s+)?(?:reserv(?:ed|es|ing)|except(?:ed|s|ing))\s+(?:unto|to|from|and\s+retain(?:ed|s|ing)\s+unto)?\s*(?:the\s+)?(?:grantors?|lessors?|assignors?|herein)?[^.]{0,260}?(?:mineral|royalty|oil,?\s+gas)[^.]{0,200}\./i);
  const grantsAll = /all\s+of\s+(?:grantor'?s|assignor'?s|our|my|his|her|their)\s+(?:undivided\s+)?right,?\s+title,?\s+(?:and|&)\s+interest/i.test(text);

  const fractionMatches = allMatches(text, FRACTION_TEXT).filter(m => {
    // Skip fractions that sit inside the reservation clause; those become the reservation entry.
    if (!reservationMatch) return true;
    const idx = m.index ?? 0;
    return idx < reservationMatch.index || idx > reservationMatch.index + reservationMatch[0].length;
  });

  if (type === "lease") {
    const royalty = firstMatch(text, /royalty[^.]{0,80}?((?:\d+\s*\/\s*\d+)|(?:one|three)[- ](?:eighth|sixteenth|sixteenths|fourth|fifth|eighths))/i);
    tracts.push({
      ...baseTract(text, anchorIndex), interestType: "leasehold", effect: "lease_grant", fraction: null,
      reservationText: royalty ? `Lessor royalty: ${royalty[1]}` : null,
    });
    return { tracts, alternatives };
  }

  if (type === "probate" || type === "affidavit_of_heirship") {
    const shares = allMatches(text, /(\d+\s*\/\s*\d+|one[- ]half|one[- ]third|one[- ]fourth|equal\s+shares?)\s*(?:each|interest|share|undivided)?/gi);
    const base = baseTract(text, anchorIndex);
    if (shares.length === 0) {
      tracts.push({ ...base, interestType: "unknown", effect: "succession", fraction: null });
    } else if (shares.length === 1) {
      const verbatim = shares[0][0];
      const f = /equal/i.test(verbatim) ? null : Fraction.parse(verbatim);
      tracts.push({ ...base, interestType: "unknown", effect: "succession", fraction: { numerator: f ? Number(f.n) : null, denominator: f ? Number(f.d) : null, verbatim, basis: "of_grantor_interest" } });
    } else {
      tracts.push({ ...base, interestType: "unknown", effect: "succession", fraction: null });
      alternatives.push({ field: "succession_shares", interpretations: shares.map(s => s[0]), reason: "Multiple share phrasings appear; allocation among heirs/devisees not resolved deterministically." });
    }
    return { tracts, alternatives };
  }

  if (type === "release") {
    tracts.push({ ...baseTract(text, anchorIndex), interestType: "unknown", effect: "release", fraction: fractionMatches[0] ? fractionEntry(fractionMatches[0][1], fractionMatches[0].index ?? 0, text) : null });
    return { tracts, alternatives };
  }

  if (type === "deed_of_trust" || type === "lien") {
    tracts.push({ ...baseTract(text, anchorIndex), interestType: "unknown", effect: "encumbrance", fraction: null });
    return { tracts, alternatives };
  }

  if (type === "unit_agreement" || type === "other") {
    tracts.push({ ...baseTract(text, anchorIndex), interestType: "unknown", effect: "other", fraction: null });
    return { tracts, alternatives };
  }

  // Conveyances: one entry per distinct (interest type, fraction) found; fee deeds
  // with no fraction language convey the grantor's interest (basis of_grantor_interest, all).
  const seen = new Set<string>();
  for (const m of fractionMatches) {
    const idx = m.index ?? 0;
    const window = excerptAround(text, idx, 140);
    const interestType = interestTypeFor(window);
    if (interestType === "unknown" && !/interest/i.test(window)) continue;
    const key = `${interestType}|${m[1].toLowerCase().replace(/\s+/g, "")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tracts.push({ ...baseTract(text, idx), interestType: interestType === "unknown" ? (type === "mineral_deed" ? "mineral" : type === "royalty_deed" ? "royalty" : type === "assignment" ? "working_interest" : "unknown") : interestType, effect: type === "assignment" ? "assignment" : "conveyance", fraction: fractionEntry(m[1], idx, text) });
  }

  if (tracts.length === 0 && isConveyance) {
    const defaultInterest: ExtractedTract["interestType"] = type === "mineral_deed" ? "mineral" : type === "royalty_deed" ? "royalty" : type === "assignment" ? "working_interest" : "surface";
    tracts.push({ ...baseTract(text, anchorIndex), interestType: defaultInterest, effect: type === "assignment" ? "assignment" : "conveyance", fraction: { numerator: 1, denominator: 1, verbatim: grantsAll ? "all of grantor's right, title and interest" : null, basis: "of_grantor_interest" } });
    if (type === "deed" || type === "correction_deed") {
      // A fee deed passes the grantor's mineral interest unless reserved — recorded as its own claim so the mineral branch sees it, flagged for review.
      tracts.push({ ...baseTract(text, anchorIndex), interestType: "mineral", effect: "conveyance", fraction: { numerator: 1, denominator: 1, verbatim: null, basis: "of_grantor_interest" }, exceptionsText: "Fee deed with no express mineral language; minerals pass with the fee unless reserved — confirm against instrument text." });
      alternatives.push({ field: "mineral_passthrough", interpretations: ["Deed conveys grantor's surface AND mineral interest (no reservation found)", "Deed conveys surface only (mineral language not captured by the parser)"], reason: "No express mineral clause was located; the fee-passes-minerals reading is recorded for review." });
    }
  }

  if (reservationMatch) {
    const idx = reservationMatch.index;
    const clause = reservationMatch[0].replace(/\s+/g, " ").trim();
    const frac = clause.match(FRACTION_TEXT);
    const interestType = interestTypeFor(clause);
    tracts.push({
      ...baseTract(text, idx),
      interestType: interestType === "unknown" ? "mineral" : interestType,
      effect: "reservation",
      fraction: frac ? fractionEntry(frac[0], idx, text) : null,
      reservationText: clause,
      page: pageOf(text, idx),
      excerpt: clause.slice(0, 400),
    });
    if (!frac) alternatives.push({ field: "reservation_fraction", interpretations: ["Reservation covers a stated fraction not captured by the parser", "Reservation covers all of the named interest"], reason: "Reservation clause located but no fraction was parsed from it." });
  }

  const exceptions = firstMatch(text, /(?:subject\s+to|save\s+and\s+except|less\s+and\s+except)[^.]{10,300}\./i);
  if (exceptions && tracts[0]) tracts[0].exceptionsText = [tracts[0].exceptionsText, exceptions[0].replace(/\s+/g, " ").trim()].filter(Boolean).join(" | ");

  return { tracts, alternatives };
}

// ─── References ──────────────────────────────────────────────────────────────

function extractReferences(text: string, ownRefs: { instrumentNumber: string | null; bookVolumePage: string | null }): ExtractedReference[] {
  const refs: ExtractedReference[] = [];
  for (const r of findRecordingReferences(text)) {
    const value = r.value;
    if ((ownRefs.instrumentNumber && value === ownRefs.instrumentNumber) || (ownRefs.bookVolumePage && value === ownRefs.bookVolumePage)) continue;
    const ctx = excerptAround(text, r.index, 200).toLowerCase();
    const relation: ExtractedReference["relation"] =
      /release|releas|satisf|paid\s+in\s+full/.test(ctx) ? "released_obligation"
      : /correct|corrective/.test(ctx) ? "corrected_instrument"
      : /lease/.test(ctx) && !/same\s+land|conveyed\s+to|acquired/.test(ctx) ? "prior_lease"
      : /same\s+(land|property)|conveyed\s+to|acquired\s+by|described\s+in|reference\s+is\s+(here\s+)?made/.test(ctx) ? "predecessor"
      : "other";
    refs.push({
      description: excerptAround(text, r.index, 90),
      instrumentNumber: r.kind === "doc_no" ? value : null,
      bookVolumePage: r.kind === "vol_page" ? value : null,
      county: ctx.match(/([a-z]+(?:\s+[a-z]+)?)\s+county/)?.[1]?.replace(/\b\w/g, c => c.toUpperCase()) ?? null,
      relation,
      page: r.page,
    });
  }
  return refs;
}

// ─── Signatures / acknowledgments ────────────────────────────────────────────

function extractSignatureObservations(text: string, parties: ExtractedParty[]) {
  const sigs: ExtractedInstrument["signatureObservations"] = [];
  const acks: ExtractedInstrument["acknowledgmentObservations"] = [];
  const ackSection = text.match(/(?:before\s+me|acknowledged\s+before\s+me|state\s+of\s+texas\s*(?:§|ss)?\s*county\s+of)[\s\S]{0,1200}/gi) ?? [];
  const ackText = ackSection.join("\n");
  const signatureLines = text.match(/(?:\/s\/|_{3,}|\bBy:)\s*[^\n]{0,120}/g) ?? [];

  for (const p of parties) {
    if (!["grantor", "lessor", "assignor", "releasor", "borrower", "executor"].includes(p.role)) continue;
    const lastName = p.name.split(/\s+/).filter(Boolean).pop() ?? p.name;
    const nameRe = new RegExp(lastName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const signed = signatureLines.some(l => nameRe.test(l));
    const acknowledged = nameRe.test(ackText);
    const ackIdx = acknowledged ? ackText.search(nameRe) : -1;
    sigs.push({
      party: p.name,
      observed: signed ? "signed" : (signatureLines.length > 0 || ackSection.length > 0) ? "unclear" : "unclear",
      note: signed ? "Name appears on a signature line" : "No signature line bearing this name was located in the text (image signatures are not visible to a text parser)",
      page: p.page,
    });
    acks.push({
      party: p.name,
      notaryPresent: ackSection.length > 0 ? acknowledged : null,
      date: acknowledged ? (normalizeDateText(ackText.slice(ackIdx, ackIdx + 300)) ?? null) : null,
      note: acknowledged ? "Named in an acknowledgment clause" : ackSection.length > 0 ? "Acknowledgment clause(s) present but this party not named in them" : "No acknowledgment clause located",
      page: null,
    });
  }
  return { sigs, acks };
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export function parseInstrumentText(text: string): ExtractedDocument {
  const kind = classifyDocumentKind(text);
  const notes: string[] = [];

  if (kind !== "instrument") {
    // Non-instrument documents contribute candidate legal descriptions only.
    const legalDescriptions: ExtractedTract[] = [];
    const anchor = firstMatch(text, /\b(?:abstract|survey|block\s+\d|section\s+\d)\b/i);
    if (anchor) legalDescriptions.push({ ...baseTract(text, anchor.index), interestType: "unknown", effect: "other", fraction: null });
    if (kind === "other") notes.push("No conveyance language detected; document treated as supporting material only.");
    return { documentKind: kind, instruments: [], legalDescriptions, notes };
  }

  const { type, verbatim: typeVerbatim } = classifyInstrumentType(text);
  const parties = extractParties(text);

  const executionDate = findDate(text, /(?:executed|dated|made\s+and\s+entered\s+into|signed|witness\s+(?:my|our)\s+hand)\s*(?:this|on|as\s+of)?/i);
  const effectiveDate = findDate(text, /effective\s+(?:as\s+of|date)/i);
  // preferLast: a filing stamp is at the foot of the instrument; a bare
  // "recorded" earlier in the body is a reference to a PRIOR instrument.
  const recordingDate = findDate(text, /(?:filed\s+for\s+record|recorded|recording\s+date|filed)\s*(?:on|:)?/i, { preferLast: true });

  const refs = findRecordingReferences(text);
  // Same first-match trap as findDate, with two further casualties: "recorded
  // in Volume 210, Page 44" in the body matched ahead of the filing stamp, so
  // the deed's OWN book/page resolved to its predecessor's reference — and
  // that predecessor was then excluded from `references` as if it were this
  // instrument's own recording data. Take the LAST occurrence instead.
  const recordingCtxMatches = allMatches(text, /(?:filed\s+for\s+record|recorded\s+(?:in|under)|recording\s+date|clerk'?s\s+file\s+no)/i);
  const recordingCtx = recordingCtxMatches.length > 0 ? recordingCtxMatches[recordingCtxMatches.length - 1] : null;
  const ownRef = recordingCtx ? refs.find(r => Math.abs(r.index - (recordingCtx.index ?? 0)) < 250) ?? null : null;
  const instrumentNumber = ownRef?.kind === "doc_no" ? ownRef.value : null;
  const bookVolumePage = ownRef?.kind === "vol_page" ? ownRef.value : null;

  const { tracts, alternatives } = extractTracts(text, type);
  const references = extractReferences(text, { instrumentNumber, bookVolumePage });
  const { sigs, acks } = extractSignatureObservations(text, parties);

  // Two different execution-date candidates in the first pages is a real ambiguity, not a pick.
  const dateCandidates = Array.from(new Set((text.slice(0, 6000).match(new RegExp(`${ORDINAL_DATE.source}|${LONG_DATE.source}`, "gi")) ?? []).map(d => normalizeDateText(d)).filter((d): d is string => !!d)));
  if (dateCandidates.length > 1 && executionDate.iso && recordingDate.iso === null) {
    alternatives.push({ field: "executionDate", interpretations: dateCandidates.slice(0, 4), reason: "Several dates appear near the head of the instrument; the anchored one was chosen but others are recorded." });
  }

  const county = tracts[0]?.county ?? text.match(/county\s+of\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)?)/i)?.[1] ?? null;

  let confidence = 0.3;
  if (type !== "other") confidence += 0.1;
  if (parties.some(p => ["grantor", "lessor", "assignor", "decedent", "borrower"].includes(p.role))) confidence += 0.1;
  if (parties.some(p => ["grantee", "lessee", "assignee", "heir", "devisee", "lender"].includes(p.role))) confidence += 0.1;
  if (executionDate.iso || recordingDate.iso) confidence += 0.05;
  if (tracts.some(t => t.abstractNumber || t.surveyName || t.legalDescriptionVerbatim)) confidence += 0.05;
  confidence = Math.min(0.7, confidence);

  const instrument: ExtractedInstrument = {
    instrumentType: type,
    instrumentTypeVerbatim: typeVerbatim,
    executionDate, effectiveDate, recordingDate,
    county,
    instrumentNumber,
    bookVolumePage,
    parties,
    tracts,
    references,
    signatureObservations: sigs,
    acknowledgmentObservations: acks,
    alternatives,
    confidence,
    verbatimExcerpts: [
      { label: "head", page: 1, text: text.slice(0, 600).replace(/\s+/g, " ").trim() },
      ...tracts.filter(t => t.excerpt).slice(0, 4).map(t => ({ label: `${t.effect}:${t.interestType}`, page: t.page, text: t.excerpt as string })),
    ],
  };

  if (parties.length === 0) notes.push("No parties could be identified deterministically; review required.");
  return { documentKind: "instrument", instruments: [instrument], legalDescriptions: [], notes };
}
