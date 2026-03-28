/**
 * Lightweight, deterministic development-signal detection for mineral documents.
 * Not a GIS or NLP engine — pattern-based only.
 */

export type DevelopmentSignalsSnapshot = {
  has_development_signals: boolean;
  matched_signals: string[];
  extracted_depth_limit_feet: number | null;
  referenced_wells: string[];
  has_infrastructure_language: boolean;
  has_legal_development_context: boolean;
  /** True when the snapshot relies on document signals (e.g. county geology unknown). */
  partial_snapshot: boolean;
  /** Formation name found in text when county mapping did not supply one (display only). */
  formation_text_mention: string | null;
  display_depth_label: string | null;
  display_wells_note: string | null;
  display_infrastructure_note: string | null;
  display_context_note: string | null;
};

const MAX_WELLS = 12;
const MAX_SIGNAL_LABELS = 24;

/** Common U.S. onshore formation names (subset; extend as needed). */
const FORMATION_NAMES_SORTED = [
  "Bakken",
  "Barnett",
  "Bois d'Arc",
  "Bone Spring",
  "Buda",
  "Canyon",
  "Cline",
  "Delaware",
  "Duvernay",
  "Eagle Ford",
  "Ellenburger",
  "Granite Wash",
  "Haynesville",
  "Marcellus",
  "Midland",
  "Mississippian",
  "Montney",
  "Pennsylvanian",
  "San Andres",
  "Spraberry",
  "Strawn",
  "Three Forks",
  "Wolfcamp",
  "Woodford",
].sort((a, b) => b.length - a.length);

function uniqStrings(list: string[], cap: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const t = raw.trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
    if (out.length >= cap) break;
  }
  return out;
}

function normalizeScanText(extractedText: string, extractedFields: Record<string, unknown>): string {
  const chunks: string[] = [];
  if (extractedText && extractedText.trim()) chunks.push(extractedText);
  const keys = [
    "legal_description",
    "document_type",
    "county",
    "state",
    "lessor",
    "lessee",
    "grantor",
    "grantee",
    "owner",
    "buyer",
  ] as const;
  for (const k of keys) {
    const v = extractedFields[k];
    if (typeof v === "string" && v.trim()) chunks.push(v);
  }
  return chunks.join("\n\n");
}

export function extractDepthLimitFeetFromText(text: string): number | null {
  const s = text.slice(0, 500_000);
  // Phrases like "below the depth of 3200 feet", "down to ... 3200 ft"
  const patterns: RegExp[] = [
    /\b(?:below|down\s+to|depth\s+limitation|depth\s+of|below\s+the\s+depth\s+of)\b[^.\n]{0,160}?(\d{3,5})\s*(?:feet|ft\.?)\b/gi,
    /\b(\d{3,5})\s*(?:feet|ft\.?)\b[^.\n]{0,80}?\b(?:below|depth|limitation)\b/gi,
    // "depth ... 3200 ft", "limitation of 3200 feet", "3200 ft depth limit"
    /\b(?:depth|limit|limitation|below|deepest|shallow)\b[^.\n]{0,150}?(\d{3,5})\s*(?:feet|ft\.?)\b/gi,
    /\b(\d{3,5})\s*(?:feet|ft\.?)\b[^.\n]{0,150}?\b(?:depth|limit|limitation|below|deepest|surface)\b/gi,
  ];
  const candidates: number[] = [];
  for (const re of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n >= 200 && n <= 35_000) candidates.push(n);
    }
  }
  if (candidates.length > 0) return Math.min(...candidates);

  // Line-based: "3200 ft" / "3200 feet" on a line that also mentions depth/limit/below/shallow
  const lines = s.split(/\n/);
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (!/\b(?:depth|limit|limitation|below|deepest|shallow)\b/.test(lower)) continue;
    const reLine = /\b(\d{3,5})\s*(?:feet|ft\.?)\b/gi;
    let m: RegExpExecArray | null;
    while ((m = reLine.exec(line)) !== null) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n >= 200 && n <= 35_000) candidates.push(n);
    }
  }
  if (candidates.length === 0) return null;
  return Math.min(...candidates);
}

function extractFormationMention(text: string): string | null {
  const s = text.slice(0, 500_000);
  for (const name of FORMATION_NAMES_SORTED) {
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(s)) return name;
  }
  return null;
}

function extractWellReferences(text: string): string[] {
  const s = text.slice(0, 500_000);
  const found: string[] = [];

  const reLdash = /\b[A-Z]-\d+\b/g;
  let m: RegExpExecArray | null;
  while ((m = reLdash.exec(s)) !== null) {
    found.push(m[0]);
  }

  // "Teagarden B2" style: Word(s) + letter + digit(s)
  const reNamed = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\s+[A-Z]\d+\b/g;
  while ((m = reNamed.exec(s)) !== null) {
    found.push(m[0].replace(/\s+/g, " ").trim());
  }

  // "Well 3", "Lease #12", "Unit A-7"
  const reTagged = /\b(?:well|lease|unit)\s*#?\s*[A-Z0-9][A-Z0-9\-]*\b/gi;
  while ((m = reTagged.exec(s)) !== null) {
    found.push(m[0].replace(/\s+/g, " ").trim());
  }

  return uniqStrings(found, MAX_WELLS);
}

function hasDepthLanguage(text: string): boolean {
  const t = text.slice(0, 500_000).toLowerCase();
  if (/\bdepth\s+limitation\b/.test(t)) return true;
  if (/\bdepth\s+of\b/.test(t)) return true;
  if (
    /\bdown\s+to\b/.test(t) &&
    /\b(?:feet|ft\.?)\b/.test(t) &&
    /\b(?:depth|below|surface)\b/.test(t)
  ) {
    return true;
  }
  if (/\b(?:subsurface|stratigraphic)\b/.test(t) && /\b(?:feet|ft\.?)\b/.test(t)) return true;
  return false;
}

function hasFeetNearDepth(text: string): boolean {
  const t = text.slice(0, 500_000).toLowerCase();
  return /\b\d{3,5}\s*(?:feet|ft\.?)\b/.test(t) && /\b(?:depth|below|down|feet|ft)\b/.test(t);
}

function hasSpacingLanguage(text: string): boolean {
  return /\b(?:spacing|proration|density|(?:unit\s+)?rule(?:s)?)\b/i.test(text.slice(0, 500_000));
}

function hasInfrastructureLanguage(text: string): boolean {
  const t = text.slice(0, 500_000).toLowerCase();
  return (
    /\b(?:flowline|flow\s*line)s?\b/.test(t) ||
    /\b(?:water\s*line|waterline)s?\b/.test(t) ||
    /\b(?:pump|tank|separator|compressor|fixture)s?\b/.test(t) ||
    /\b(?:surface\s+)?equipment\b/.test(t) ||
    /\b(?:gathering|pipeline)s?\b/.test(t)
  );
}

function hasLegalDevelopmentContext(text: string): boolean {
  const t = text.slice(0, 500_000).toLowerCase();
  return (
    /\bsection\s+\d/.test(t) ||
    /\bblock\s+\d/.test(t) ||
    /\bsurvey\b/.test(t) ||
    /\babstract\b/.test(t) ||
    /\btract\b/.test(t) ||
    /\bacres?\b/.test(t) ||
    /\b(?:legal\s+description|metes\s+and\s+bounds)\b/.test(t)
  );
}

function hasOperatorLeaseAssignmentContext(text: string): boolean {
  const t = text.slice(0, 500_000).toLowerCase();
  return (
    /\b(?:operator|produc(?:e|tion|ing))\b/.test(t) ||
    /\b(?:oil\s+and\s+gas|og)\s+lease\b/.test(t) ||
    /\b(?:mineral\s+interest|working\s+interest|overriding\s+royalty)\b/.test(t) ||
    /\bassignment\b/.test(t) ||
    /\b(?:lessor|lessee|grantor|grantee)\b/.test(t) ||
    /\b(?:lease|leased|royalt(?:y|ies))\b/.test(t)
  );
}

function pickStr(merged: Record<string, unknown>, snake: string, camel: string): string | undefined {
  const a = merged[snake];
  const b = merged[camel];
  if (typeof a === "string" && a.trim()) return a.trim();
  if (typeof b === "string" && b.trim()) return b.trim();
  return undefined;
}

function pickNum(merged: Record<string, unknown>, snake: string, camel: string): number | null {
  for (const v of [merged[snake], merged[camel]]) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const n = parseFloat(v.trim());
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

/**
 * Returns true when county-level geology produced a non-unknown formation or depth range.
 */
export function hasRegionalDrillFromDealInput(dealInput: Record<string, unknown>): boolean {
  const est = pickStr(dealInput, "estimated_formation", "estimatedFormation");
  if (est && est.toLowerCase() !== "unknown") return true;
  const dmin = pickNum(dealInput, "estimated_depth_min", "estimatedDepthMin");
  const dmax = pickNum(dealInput, "estimated_depth_max", "estimatedDepthMax");
  if (dmin != null && dmax != null) return true;
  const dd = pickStr(dealInput, "drill_difficulty", "drillDifficulty");
  if (dd && dd.toLowerCase() !== "unknown") return true;
  return false;
}

function pushSignal(list: string[], label: string, cond: boolean): void {
  if (cond) list.push(label);
}

/**
 * Detect development-related signals from raw text and normalized extraction fields.
 */
export function detectDevelopmentSignals(
  extractedText: string,
  extractedFields: Record<string, unknown>
): Omit<DevelopmentSignalsSnapshot, "partial_snapshot"> {
  const scan = normalizeScanText(extractedText, extractedFields);
  const matched: string[] = [];

  const depthLimit = extractDepthLimitFeetFromText(scan);
  const depthLang = hasDepthLanguage(scan) || hasFeetNearDepth(scan);
  pushSignal(matched, "depth_language", depthLang);
  pushSignal(matched, "depth_limit_feet", depthLimit != null);

  const formationMention = extractFormationMention(scan);
  pushSignal(matched, "formation_mention", formationMention != null);

  const wells = extractWellReferences(scan);
  pushSignal(matched, "well_references", wells.length > 0);

  const infra = hasInfrastructureLanguage(scan);
  pushSignal(matched, "infrastructure", infra);

  const legalDev = hasLegalDevelopmentContext(scan);
  pushSignal(matched, "legal_tract_context", legalDev);

  const spacing = hasSpacingLanguage(scan);
  pushSignal(matched, "spacing", spacing);

  const opCtx = hasOperatorLeaseAssignmentContext(scan);
  pushSignal(matched, "development_context_language", opCtx);

  const hasDevelopmentSignals =
    depthLang ||
    depthLimit != null ||
    formationMention != null ||
    wells.length > 0 ||
    infra ||
    legalDev ||
    spacing ||
    opCtx;

  const displayDepth =
    depthLimit != null ? `~${depthLimit.toLocaleString("en-US")} ft (from document)` : null;

  return {
    has_development_signals: hasDevelopmentSignals,
    matched_signals: matched.slice(0, MAX_SIGNAL_LABELS),
    extracted_depth_limit_feet: depthLimit,
    referenced_wells: wells,
    has_infrastructure_language: infra,
    has_legal_development_context: legalDev,
    formation_text_mention: formationMention,
    display_depth_label: displayDepth,
    display_wells_note:
      wells.length > 0 ? "Named wells or well identifiers referenced" : null,
    display_infrastructure_note: infra ? "Surface equipment, lines, or fixtures referenced" : null,
    display_context_note: legalDev
      ? "Legacy tract / survey-based development context detected"
      : null,
  };
}

/**
 * Builds the persisted `development_signals` object and sets `partial_snapshot`.
 */
export function buildDevelopmentSignalsSnapshot(
  extractedText: string,
  extractedFields: Record<string, unknown>,
  dealInputAfterCountyEnrichment: Record<string, unknown>
): DevelopmentSignalsSnapshot {
  const base = detectDevelopmentSignals(extractedText, extractedFields);
  const regional = hasRegionalDrillFromDealInput(dealInputAfterCountyEnrichment);

  const partial_snapshot =
    base.has_development_signals &&
    (!regional ||
      base.extracted_depth_limit_feet != null ||
      (base.formation_text_mention != null &&
        typeof dealInputAfterCountyEnrichment.estimated_formation === "string" &&
        dealInputAfterCountyEnrichment.estimated_formation.toLowerCase() === "unknown"));

  return {
    ...base,
    partial_snapshot,
  };
}
