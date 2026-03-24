/**
 * Stage C: regex / pattern-based field extraction from raw OCR or PDF text.
 */

import {
  type ExtractionDocumentClass,
  documentClassToDisplayLabel,
  normalizePartyName,
} from "./extraction-normalize";

export type HeuristicFieldResult = {
  grantor: string | null;
  grantee: string | null;
  lessor: string | null;
  lessee: string | null;
  county: string | null;
  state: string | null;
  legal_description: string | null;
  effective_date: string | null;
  recording_date: string | null;
  royalty_rate: string | null;
  term_length: string | null;
  document_type: string | null;
  owner: string | null;
  buyer: string | null;
  mailing_address: string | null;
  acreage: number | null;
  detected_class: ExtractionDocumentClass;
};

/** Common Texas place names (city or county) when followed by `, TX` — helps county inference. */
const TX_PLACE_HINTS = new Set(
  [
    "houston",
    "dallas",
    "austin",
    "san antonio",
    "fort worth",
    "el paso",
    "midland",
    "odessa",
    "reeves",
    "martin",
    "loving",
    "ward",
    "upton",
    "winkler",
    "pecos",
    "andrews",
    "ector",
    "howard",
    "mccamey",
    "big spring",
    "lamesa",
    "seminole",
    "denver city",
    "plains",
    "snyder",
    "colorado city",
    "sweetwater",
    "abilene",
    "lubbock",
    "amarillo",
    "corpus christi",
    "brownsville",
    "laredo",
    "tyler",
    "longview",
    "beaumont",
    "victoria",
    "san angelo",
    "wichita falls",
  ].map((s) => s.toLowerCase())
);

function sliceUpToNextHeading(line: string, maxLen = 220): string {
  let s = line.replace(/\s{2,}/g, " ").trim();
  if (s.length > maxLen) s = s.slice(0, maxLen).trim();
  return s;
}

/**
 * Extracts value after a label at line start (Grantor:, LESSOR, etc.).
 */
export function extractLabeledLineValue(
  text: string,
  labels: string[],
  sliceLen = 8000
): string | null {
  const slice = text.slice(0, sliceLen);
  const alt = labels
    .map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const re = new RegExp(
    `(?:^|[\\n\\r])\\s*(?:\\*\\s*)?(?:${alt})\\s*[:#\\.\\-–—]+\\s*(.+)`,
    "gim"
  );
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(slice)) !== null) {
    let line = m[1]?.trim() ?? "";
    line = sliceUpToNextHeading(line);
    if (line.length < 2) continue;
    if (/^(the|a|an)\s+(state|county|united)\b/i.test(line)) continue;
    last = normalizePartyName(line);
  }
  return last;
}

export function extractGrantorGranteeFromHeadings(text: string): { grantor: string | null; grantee: string | null } {
  return {
    grantor: extractLabeledLineValue(text, ["grantor", "GRANTOR", "Grantor"]),
    grantee: extractLabeledLineValue(text, ["grantee", "GRANTEE", "Grantee"]),
  };
}

export function extractLessorLesseeFromHeadings(text: string): { lessor: string | null; lessee: string | null } {
  return {
    lessor: extractLabeledLineValue(text, ["lessor", "LESSOR", "Lessor"]),
    lessee: extractLabeledLineValue(text, ["lessee", "LESSEE", "Lessee"]),
  };
}

/** Owner / name blocks for tax rolls and similar. */
export function extractOwnerFromHeadings(text: string): string | null {
  const fromOwner = extractLabeledLineValue(text, [
    "owner",
    "OWNER",
    "Owner",
    "property owner",
    "taxpayer",
    "name of owner",
    "mineral owner",
  ]);
  if (fromOwner) return fromOwner;
  return extractLabeledLineValue(text, ["name", "NAME"], 4000);
}

const NAME_TOKEN = "[A-Za-z][A-Za-z.'\\-]{0,35}";
/** 2–4 word person / entity line (allows ALL CAPS or Title Case). */
const LINE_LOOKS_LIKE_NAME = new RegExp(
  `^${NAME_TOKEN}(?:\\s+${NAME_TOKEN}){1,3}$`
);

/**
 * OCR-friendly: line is mostly letters/spaces (no long digit runs), 2–4 tokens.
 */
function lineLooksLikePersonOrEntityName(line: string): boolean {
  const t = line.replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();
  if (t.length < 4 || t.length > 90) return false;
  if (/\d{3,}/.test(t)) return false;
  if (/^[^A-Za-z]+$/.test(t)) return false;
  if (!LINE_LOOKS_LIKE_NAME.test(t)) return false;
  const lower = t.toLowerCase();
  if (
    /^(the|and|or|for|page|state|county|section|abstract|legal|description|property|owner|name)\b/.test(
      lower
    )
  ) {
    return false;
  }
  return true;
}

/**
 * Detects stacked blocks: NAME / address line with digit or P.O. Box / "CITY, TX ZIP".
 */
export function inferOwnerFromNameAddressBlock(text: string): string | null {
  const slice = text.slice(0, 16000);
  const lines = slice.split(/\r?\n/).map((l) => l.replace(/\u00A0/g, " ").trim());
  for (let i = 0; i < lines.length - 2; i++) {
    const nameLine = lines[i];
    const addrLine = lines[i + 1];
    const cityLine = lines[i + 2];
    if (!nameLine || !addrLine || !cityLine) continue;
    if (!lineLooksLikePersonOrEntityName(nameLine)) continue;
    const addrOk = /\d/.test(addrLine) || /\bp\.?\s*o\.?\s*box\b/i.test(addrLine);
    if (!addrOk || addrLine.length > 200) continue;
    const cityOk =
      /^[A-Za-z][A-Za-z\s.'\-]{1,42},\s*(?:TX|Texas)\s+\d{5}(?:-\d{4})?\s*$/i.test(cityLine) ||
      /^[A-Za-z][A-Za-z\s.'\-]{1,42}\s+(?:TX|Texas)\s+\d{5}(?:-\d{4})?\s*$/i.test(cityLine);
    if (!cityOk) continue;
    const n = normalizePartyName(nameLine);
    if (n) return n;
  }
  const personTok = "[A-Za-z][A-Za-z.'\\-]+";
  const multiline = slice.match(
    new RegExp(
      `(?:^|[\\n\\r])\\s*(${personTok}(?:\\s+${personTok}){1,3})\\s*[\\n\\r]\\s*` +
        `([^\\n\\r]{6,120}\\d[^\\n\\r]{0,100})\\s*[\\n\\r]\\s*` +
        `([A-Za-z][^\\n\\r]{2,45},\\s*(?:TX|Texas)\\s+\\d{5}(?:-\\d{4})?)`,
      "i"
    )
  );
  if (multiline?.[1]) {
    const n = normalizePartyName(multiline[1]);
    if (n && !/^(the|unknown|owner|name)\b/i.test(n)) return n;
  }
  return null;
}

/**
 * Fallback: first plausible 2–3 capitalized-word name in the early body (tax rolls, bad OCR).
 */
export function inferOwnerFromCapitalizedNameBlock(text: string): string | null {
  const slice = text.slice(0, 9000);
  const lines = slice.split(/\r?\n/).map((l) => l.replace(/\u00A0/g, " ").trim());
  let skipped = 0;
  for (const line of lines) {
    if (!line) continue;
    if (skipped < 8 && line.length < 70 && /^[A-Z0-9\s#./\-]{6,}$/.test(line) && !/[a-z]/.test(line)) {
      skipped++;
      continue;
    }
    const words = line.split(/\s+/).filter(Boolean);
    if (words.length < 2 || words.length > 4) continue;
    if (!lineLooksLikePersonOrEntityName(line)) continue;
    const n = normalizePartyName(line);
    if (n) return n;
  }
  return null;
}

export function extractMailingAddressBlock(text: string): string | null {
  const slice = text.slice(0, 12000);
  const re =
    /(?:mailing\s+address|owner\s+address|postal\s+address|address\s*[:#])[\s:]*\n?([\s\S]{8,400}?)(?=\n\s*(?:grantor|grantee|lessor|lessee|county|state|section|legal)\b|\n{3,}|$)/i;
  const m = re.exec(slice);
  if (!m?.[1]) return null;
  const block = m[1]
    .split(/\n{3,}/)[0]
    .replace(/\s+/g, " ")
    .trim();
  if (block.length < 8 || block.length > 500) return null;
  if (!/\d/.test(block) && !/\bp\.?\s*o\.?\s*box\b/i.test(block)) return null;
  return block;
}

export function extractCountyFromText(text: string): string | null {
  const slice = text.slice(0, 28000);
  const patterns: RegExp[] = [
    /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+County,?\s*(?:Texas|\bTX\b)?/gm,
    /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+County\b/g,
    /\b([A-Z]{2,}(?:\s+[A-Z]{2,}){0,2})\s+COUNTY\b/g,
    /County\s+of\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/gi,
    /County\s+of\s+([A-Z]{2,}(?:\s+[A-Z]{2,}){0,2})/gi,
    /County\s+of\s+the\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/gi,
    /,\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+County\b/g,
    /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+Co\.?\s*,\s*(?:TX|Texas)\b/gi,
  ];
  let best: string | null = null;
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    const r = new RegExp(re.source, re.flags.replace("g", "") + "g");
    while ((m = r.exec(slice)) !== null) {
      const raw = m[1]?.trim();
      if (!raw || raw.length < 2) continue;
      const n = normalizePartyName(raw);
      if (n && !/^(the|state|united|public)\b/i.test(n)) best = n;
    }
  }
  return best;
}

export function extractStateFromText(text: string): string | null {
  const slice = text.slice(0, 32000);
  if (/\bTexas\b/i.test(slice) || /\bTX\b/.test(slice)) {
    const txCount = (slice.match(/\b(Texas|TX)\b/gi) ?? []).length;
    if (txCount >= 1) return "TX";
  }
  const m = slice.match(/\b([A-Z]{2})\b(?=[^\n]{0,40}(?:United States|USA|\d{5}))/);
  if (m && m[1] === "TX") return "TX";
  return null;
}

/** Infer county from legal description phrases like "in Reeves County" already tried; also "Reeves Co." */
export function extractCountyFromLegalFragment(text: string): string | null {
  const m = text.match(/\b(?:in|of)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+Co(?:unty)?\.?\b/i);
  if (m?.[1]) return normalizePartyName(m[1]);
  return null;
}

export function extractLegalDescriptionHeuristic(text: string): string | null {
  const slice = text.slice(0, 15000);
  const re =
    /((?:\b(?:Section|Sec\.?|S\/H|Abstract|A-\d+|Survey|Block|Lot|Tract|PSL|Township|Range|N\/2|S\/2|E\/2|W\/2|NE\/4|NW\/4|SE\/4|SW\/4)\b[^\n]{0,12}[\s\S]{20,800}?)(?=\n\s*(?:Royalty|Witness|Executed|Recording|Notary|STATE OF)\b|\n{4,}|$))/i;
  const m = re.exec(slice);
  if (m?.[1]) {
    const s = m[1].replace(/\s+/g, " ").trim();
    if (s.length >= 20) return s.slice(0, 1200);
  }
  return null;
}

export function extractAcreageFromText(text: string): number | null {
  const slice = text.slice(0, 28000);
  const patterns = [
    /\b([\d,]+(?:\.\d+)?)\s*(?:net\s+)?(?:mineral\s+)?acres?\b/gi,
    /\b([\d,]+(?:\.\d+)?)\s*ac\.?\b/gi,
    /\babout\s+([\d,]+(?:\.\d+)?)\s*acres?\b/gi,
  ];
  let best: number | null = null;
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(slice)) !== null) {
      const n = parseFloat(m[1].replace(/,/g, ""));
      if (Number.isFinite(n) && n > 0 && n < 1_000_000) {
        if (best == null || n > best) best = n;
      }
    }
  }
  return best;
}

export function extractRoyaltyHeuristic(text: string): string | null {
  const slice = text.slice(0, 14000);
  const frac = slice.match(/\b(?:royalt(?:y|ies))\s*(?:of|at|=|:)?\s*(\d+\s*\/\s*\d+)\b/i);
  if (frac?.[1]) return frac[1].replace(/\s+/g, "");
  const common = slice.match(/\b(1\/8|1\/6|1\/5|3\/16|1\/4|1\/3)\b/);
  if (common?.[1]) return common[1];
  const dec = slice.match(/\broyalt(?:y|ies)[^\n]{0,50}?\b(0\.\d{2,4})\b/i);
  if (dec?.[1]) return dec[1];
  const pct = slice.match(/\b(\d{1,2}(?:\.\d+)?)\s*%\s*(?:royalt|overrid|interest|mineral)\b/i);
  if (pct?.[1]) return `${pct[1]}%`;
  const pct2 = slice.match(/\broyalt(?:y|ies)[^\n]{0,40}?(\d{1,2}(?:\.\d+)?)\s*%/i);
  if (pct2?.[1]) return `${pct2[1]}%`;
  const fracBare = slice.match(/\b(?:leased\s+for|royalt(?:y|ies)\s+of)\s*(\d+\s*\/\s*\d+)\b/i);
  if (fracBare?.[1]) return fracBare[1].replace(/\s+/g, "");
  return null;
}

export function extractTermLengthHeuristic(text: string): string | null {
  const slice = text.slice(0, 8000);
  const m = slice.match(/\b(?:primary\s+term|initial\s+term|lease\s+term)\b[^\n]{0,6}([^\n]{4,80})/i);
  if (m?.[1]) return m[1].replace(/\s+/g, " ").trim().slice(0, 80);
  const years = slice.match(/\b(\d+)\s+years?\b/i);
  if (years?.[1]) return `${years[1]} years`;
  return null;
}

const DATE_LIKE =
  /\b(?:\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})\b/i;

export function extractEffectiveDateHeuristic(text: string): string | null {
  const slice = text.slice(0, 8000);
  const re = /(?:effective\s+date|dated|date\s+of\s+execution)\s*[:#]?\s*([^\n]+)/gi;
  let m: RegExpExecArray | null;
  let last: string | null = null;
  while ((m = re.exec(slice)) !== null) {
    const line = m[1] ?? "";
    const dm = line.match(DATE_LIKE);
    if (dm?.[0]) last = dm[0].trim();
  }
  return last;
}

export function extractRecordingDateHeuristic(text: string): string | null {
  const slice = text.slice(0, 8000);
  const re =
    /(?:record(?:ed|ing)?\s+date|recorded\s+on|recording\s+date|filed\s+for\s+record|filed)\s*[:#]?\s*([^\n]+)/gi;
  let m: RegExpExecArray | null;
  let last: string | null = null;
  while ((m = re.exec(slice)) !== null) {
    const line = m[1] ?? "";
    const dm = line.match(DATE_LIKE);
    if (dm?.[0]) last = dm[0].trim();
  }
  if (!last) {
    const inst = slice.match(/\binstrument\s+number[^\n]{0,40}?(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i);
    if (inst?.[1]) last = inst[1].trim();
  }
  return last;
}

const PERSON_NAME_TOKEN = "[A-Z][a-zA-Z.'-]+";
/** 2–4 tokens, looks like a person or trust name (allows LLC-style last token). */
const NAME_LINE_RE = new RegExp(
  `^(${PERSON_NAME_TOKEN}(?:\\s+${PERSON_NAME_TOKEN}){1,3})$`
);

/**
 * Fallback: first substantial line in the header with 2–3 title-case / caps words (no digits).
 */
export function inferOwnerFromCapitalizedNameLine(text: string): string | null {
  const head = text.slice(0, 4000).split(/\r?\n/);
  let seenNonEmpty = 0;
  for (const raw of head) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (!line) continue;
    seenNonEmpty++;
    if (seenNonEmpty > 28) break;
    if (line.length < 6 || line.length > 85) continue;
    if (/\d{3,}/.test(line)) continue;
    if (/^(state|county|texas|tx|page|appraisal|tax|record|legal|section)\b/i.test(line)) continue;
    const wc = line.split(/\s+/).filter(Boolean).length;
    if (wc < 2 || wc > 4) continue;
    if (!NAME_LINE_RE.test(line)) continue;
    const n = normalizePartyName(line);
    if (n) return n;
  }
  return null;
}

/** When city line matches, map to county name for Texas fallback (not exhaustive). */
const TX_CITY_TO_COUNTY: Record<string, string> = {
  midland: "Midland",
  odessa: "Ector",
  houston: "Harris",
  dallas: "Dallas",
  austin: "Travis",
  "san antonio": "Bexar",
  "fort worth": "Tarrant",
  lubbock: "Lubbock",
  amarillo: "Potter",
  lamesa: "Dawson",
  seminole: "Gaines",
  "denver city": "Yoakum",
  plains: "Yoakum",
  snyder: "Scurry",
  "colorado city": "Mitchell",
  sweetwater: "Nolan",
  abilene: "Taylor",
  "corpus christi": "Nueces",
  "san angelo": "Tom Green",
  "wichita falls": "Wichita",
};

export function detectTexasContext(text: string): boolean {
  const t = text.slice(0, 20000);
  const tx = (t.match(/\b(Texas|TX)\b/gi) ?? []).length;
  if (tx >= 2) return true;
  if (/\bCounty,?\s*TX\b/i.test(t)) return true;
  if (/\bState\s+of\s+Texas\b/i.test(t)) return true;
  return false;
}

/** Suggest county from "City, TX" when city matches known TX place hints. */
export function inferCountyFromTxCityLine(text: string): string | null {
  /** Prefer "City, TX" at line start or after newline (avoids "Office in Odessa, TX" → wrong capture). */
  const re = /(?:^|[\n\r])\s*([A-Za-z][A-Za-z]+(?:\s+[A-Za-z][A-Za-z]+)?)\s*,\s*(?:TX|Texas)\b/gm;
  let m: RegExpExecArray | null;
  const slice = text.slice(0, 28000);
  let last: string | null = null;
  while ((m = re.exec(slice)) !== null) {
    const raw = m[1]?.trim() ?? "";
    const place = raw.toLowerCase().replace(/\s+/g, " ");
    if (!place) continue;
    const mapped = TX_CITY_TO_COUNTY[place];
    if (mapped) {
      last = mapped;
      continue;
    }
    if (TX_PLACE_HINTS.has(place)) {
      last = raw
        .split(/\s+/)
        .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
        .join(" ");
    }
  }
  return last;
}

export function classifyDocumentFromKeywords(text: string): ExtractionDocumentClass {
  const head = `${text.slice(0, 8000)}\n${text.slice(-2500)}`.toUpperCase();
  if (
    /\bOPERATOR\b.*\bREPORT\b|\bSCOUT\b|\bWELL\s*COMPLETION\b|\bDRILLING\s*REPORT\b|\bWELLBORE\b|\bRIG\b.*\bREPORT\b|\bPRODUCTION\s+REPORT\b|\bFIELD\s+SUMMARY\b/.test(
      head
    )
  ) {
    return "operator_intel_report";
  }
  if (/\bMINERAL\s+AND\s+ROYALTY\s+DEED\b/.test(head.slice(0, 4000))) {
    return "mineral_deed";
  }
  const explicitLeaseTitle = /\bOIL\s+AND\s+GAS\s+LEASE\b|\bPAID[\s-]*UP\s+LEASE\b|\bMINERAL\s+LEASE\b/.test(
    head.slice(0, 3500)
  );
  const taxPropertyRecordSignals =
    /\b(APPRAISAL\s*ROLL|TAX\s*ROLL|PROPERTY\s*TAX|TAX\s*CERTIFICATE|TAX\s*STATEMENT|ASSESSMENT\s*(?:ROLL|NOTICE)|PROPERTY\s*RECORD|CAD\s*RECORD|MINERAL\s*ACCOUNT|TAX\s*RECORD)\b/.test(
      head
    ) ||
    (/\b(TAX|ASSESSMENT)\b/.test(head) && /\b(PROPERTY|RECORD|ROLL|PARCEL|ACCOUNT|APPRAISAL)\b/.test(head)) ||
    (/\b(PROPERTY|RECORD)\b/.test(head) && /\b(TAX|ASSESSMENT|APPRAISAL|ROLL)\b/.test(head));
  if (taxPropertyRecordSignals && !explicitLeaseTitle) {
    return "tax_mineral_ownership_record";
  }
  if (
    /\bAPPRAISAL\s*ROLL\b|\bTAX\s*ROLL\b|\bMINERAL\s*OWNERSHIP\b|\bOWNERSHIP\s*RECORD\b|\bPRORATION\b|\b(RRC|RAILROAD\s+COMMISSION)\b/.test(
      head
    )
  ) {
    return "tax_mineral_ownership_record";
  }
  if (/\bASSIGNMENT\s+OF\b|\bASSIGNMENT\s+AND\b|\bCONVEYANCE\s+OF\b|\bDEED\s+OF\s+CONVEYANCE\b/.test(head)) {
    return "assignment";
  }
  if (/\bROYALTY\s+DEED\b/.test(head)) return "royalty_deed";
  if (/\bMINERAL\s+DEED\b|\bQUIT\s*CLAIM\s+DEED\b|\bSPECIAL\s+WARRANTY\b/.test(head)) return "mineral_deed";
  if (/\bOIL\s+AND\s+GAS\s+LEASE\b|\bPAID[\s-]*UP\s+LEASE\b|\bMINERAL\s+LEASE\b/.test(head)) {
    return "oil_and_gas_lease";
  }
  if (/\bDEED\b/.test(head) && !/\bLEASE\b/.test(head)) return "mineral_deed";
  return "unknown";
}

/** Native → OCR → raw PDF order so the adopted primary text wins, then fallbacks fill gaps. */
function orderedTextLayers(
  normalizedText: string,
  opts?: { ocrText?: string | null; rawPdfText?: string | null }
): string[] {
  const parts = [normalizedText, opts?.ocrText ?? "", opts?.rawPdfText ?? ""];
  const out: string[] = [];
  for (const p of parts) {
    if (typeof p !== "string") continue;
    const t = p.trim();
    if (t.length > 0) out.push(p);
  }
  return out;
}

function firstNonNullFromLayers(layers: string[], pick: (s: string) => string | null): string | null {
  for (const layer of layers) {
    const v = pick(layer);
    if (v?.trim()) return v;
  }
  return null;
}

function longestNonNullFromLayers(layers: string[], pick: (s: string) => string | null): string | null {
  let best: string | null = null;
  for (const layer of layers) {
    const v = pick(layer);
    if (v?.trim() && (!best || v.length > best.length)) best = v;
  }
  return best;
}

function mergeGrantorGranteeAcrossLayers(layers: string[]): { grantor: string | null; grantee: string | null } {
  let grantor: string | null = null;
  let grantee: string | null = null;
  for (const layer of layers) {
    const gg = extractGrantorGranteeFromHeadings(layer);
    if (!grantor && gg.grantor) grantor = gg.grantor;
    if (!grantee && gg.grantee) grantee = gg.grantee;
  }
  return { grantor, grantee };
}

function mergeLessorLesseeAcrossLayers(layers: string[]): { lessor: string | null; lessee: string | null } {
  let lessor: string | null = null;
  let lessee: string | null = null;
  for (const layer of layers) {
    const ll = extractLessorLesseeFromHeadings(layer);
    if (!lessor && ll.lessor) lessor = ll.lessor;
    if (!lessee && ll.lessee) lessee = ll.lessee;
  }
  return { lessor, lessee };
}

function bestAcreageAcrossLayers(layers: string[]): number | null {
  let best: number | null = null;
  for (const layer of layers) {
    const n = extractAcreageFromText(layer);
    if (n != null && Number.isFinite(n) && n > 0) {
      if (best == null || n > best) best = n;
    }
  }
  return best;
}

export function extractHeuristicFields(
  normalizedText: string,
  opts?: { ocrText?: string | null; rawPdfText?: string | null }
): HeuristicFieldResult {
  const layers = orderedTextLayers(normalizedText, opts);
  const combined = layers.join("\n\n");
  const detected_class = classifyDocumentFromKeywords(combined || normalizedText);

  const gg = mergeGrantorGranteeAcrossLayers(layers.length > 0 ? layers : [normalizedText]);
  const ll = mergeLessorLesseeAcrossLayers(layers.length > 0 ? layers : [normalizedText]);
  let county =
    firstNonNullFromLayers(layers.length > 0 ? layers : [normalizedText], (s) => extractCountyFromText(s)) ??
    (combined.trim() ? extractCountyFromText(combined) : null);
  const state = extractStateFromText(combined || normalizedText);
  let legal =
    longestNonNullFromLayers(layers.length > 0 ? layers : [normalizedText], (s) =>
      extractLegalDescriptionHeuristic(s)
    ) ?? (combined.trim() ? extractLegalDescriptionHeuristic(combined) : null);
  const acreage =
    bestAcreageAcrossLayers(layers.length > 0 ? layers : [normalizedText]) ??
    (combined.trim() ? extractAcreageFromText(combined) : null);
  const royalty_rate = firstNonNullFromLayers(layers.length > 0 ? layers : [normalizedText], (s) =>
    extractRoyaltyHeuristic(s)
  );
  const term_length = firstNonNullFromLayers(layers.length > 0 ? layers : [normalizedText], (s) =>
    extractTermLengthHeuristic(s)
  );
  const effective_date = firstNonNullFromLayers(layers.length > 0 ? layers : [normalizedText], (s) =>
    extractEffectiveDateHeuristic(s)
  );
  const recording_date = firstNonNullFromLayers(layers.length > 0 ? layers : [normalizedText], (s) =>
    extractRecordingDateHeuristic(s)
  );
  let owner =
    firstNonNullFromLayers(layers.length > 0 ? layers : [normalizedText], (s) => extractOwnerFromHeadings(s)) ??
    (combined.trim() ? extractOwnerFromHeadings(combined) : null);
  if (!owner) {
    const fromAddr =
      inferOwnerFromNameAddressBlock(combined) ?? inferOwnerFromNameAddressBlock(normalizedText);
    if (fromAddr) {
      owner = fromAddr;
      console.log("[extract] FALLBACK_OWNER_USED", { source: "heuristic_name_address_block" });
    }
  }
  if (!owner) {
    const fromCap =
      inferOwnerFromCapitalizedNameBlock(combined) ?? inferOwnerFromCapitalizedNameBlock(normalizedText);
    if (fromCap) {
      owner = fromCap;
      console.log("[extract] FALLBACK_OWNER_USED", { source: "heuristic_capitalized_block" });
    }
  }
  const mailing_address =
    extractMailingAddressBlock(normalizedText) ?? extractMailingAddressBlock(combined);

  if (!county) {
    county = extractCountyFromLegalFragment(legal ?? normalizedText);
  }
  if (!county) {
    county = extractCountyFromLegalFragment(combined);
  }
  if (!county) {
    const cityCounty = inferCountyFromTxCityLine(normalizedText) ?? inferCountyFromTxCityLine(combined);
    if (cityCounty) {
      county = cityCounty;
      console.log("[extract] FALLBACK_COUNTY_USED", { source: "heuristic_tx_city_line" });
    }
  }

  let document_type: string | null = documentClassToDisplayLabel(detected_class);
  if (detected_class === "unknown") document_type = null;

  const deedLike =
    detected_class === "mineral_deed" ||
    detected_class === "royalty_deed" ||
    detected_class === "assignment";
  const leaseLike = detected_class === "oil_and_gas_lease";

  let grantor = gg.grantor;
  let grantee = gg.grantee;
  let lessor = ll.lessor;
  let lessee = ll.lessee;

  if (deedLike) {
    if (!grantor && lessor) grantor = lessor;
    if (!grantee && lessee) grantee = lessee;
  }
  if (leaseLike) {
    if (!lessor && grantor) lessor = grantor;
    if (!lessee && grantee) lessee = grantee;
  }

  if (detected_class === "tax_mineral_ownership_record" && owner && !grantor && !lessor) {
    lessor = owner;
  }

  const buyer = grantee ?? lessee ?? null;

  return {
    grantor,
    grantee,
    lessor,
    lessee,
    county,
    state,
    legal_description: legal,
    effective_date,
    recording_date,
    royalty_rate,
    term_length,
    document_type,
    owner,
    buyer,
    mailing_address,
    acreage,
    detected_class,
  };
}
