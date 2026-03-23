/**
 * Deal scoring V2: lead vs intel tracks. Lead = 100-point owner/acquisition model; intel =
 * corporate conveyance instrument model. {@link calculateDealScore} classifies, then routes.
 */

/** Persisted on `deal_score.type`: corporate conveyance intel vs owner-facing lead. */
export type DealScoreKind = "lead" | "intel";

export type DealScoreResult = {
  score: number;
  grade: "A Deal" | "B Deal" | "C Deal" | "D Deal";
  reasons: string[];
  /** When true, numeric score is not assigned (e.g. intel-only — not a deal lead). */
  incomplete_data?: boolean;
  type?: DealScoreKind;
};

/** Permian / top-target Texas counties (+20 location). */
const TOP_TARGET_COUNTIES = new Set([
  "reeves",
  "midland",
  "martin",
  "loving",
  "ward",
  "upton",
  "winkler",
  "pecos",
  "reagan",
  "glasscock",
  "andrews",
  "ector",
  "howard",
]);

/** Strong buyer / activity counties (+15 location). */
const STRONG_COUNTIES = new Set([
  "scurry",
  "mitchell",
  "nolan",
  "sterling",
  "coke",
  "irion",
  "tom green",
  "runnels",
  "crosby",
  "dawson",
  "gaines",
  "yoakum",
  "borden",
  "garza",
  "lynn",
  "terry",
  "hockley",
  "lubbock",
  "fisher",
  "jones",
  "kent",
  "king",
  "knox",
  "stonewall",
  "haskell",
  "throckmorton",
  "shackelford",
  "callahan",
  "taylor",
  "brown",
  "eastland",
  "stephens",
  "young",
  "archer",
  "wichita",
  "wilbarger",
  "childress",
  "hardeman",
  "foard",
  "motley",
  "cottle",
  "dickens",
]);

function normalizeCountyName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\s+county$/i, "")
    .trim();
}

function isTexasState(state: string): boolean {
  const s = state.trim().toLowerCase();
  return s === "tx" || s === "texas";
}

export type DealScoreInput = {
  drilling_distance_miles?: number | null;
  county?: string | null;
  state?: string | null;
  lease_status?: string | null;
  acreage?: number | null;
  recency_months?: number | null;
  recording_date?: string | null;
  effective_date?: string | null;
  operator?: string | null;
  ownership?: string | null;
  lessor?: string | null;
  lessee?: string | null;
  grantee?: string | null;
  owner?: string | null;
  grantor?: string | null;
  owner_name?: string | null;
  ownerName?: string | null;
  royalty_rate?: string | null;
  legal_description?: string | null;
  extracted_text_length?: number | null;
  document_processed_at?: string | null;
  /** Parsed lease / extraction confidence 0–1. */
  extraction_confidence?: number | null;
  confidence_score?: number | null;
  confidence?: number | null;
  document_type?: string | null;
  /** Optional structured party list (objects with name/type or plain strings). */
  parties?: unknown;
  /** Explicit flag from enrichment / baseline. */
  intel_only?: boolean | null;
  phone?: string | null;
  owner_phone?: string | null;
  contact_phone?: string | null;
  telephone?: string | null;
  email?: string | null;
  owner_email?: string | null;
  mailing_address?: string | null;
  owner_mailing_address?: string | null;
  postal_address?: string | null;
  owner_entity_type?: string | null;
  entity_type?: string | null;
  ownership_entity_type?: string | null;
};

function clampScore(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** Single canonical letter grade from a 0–100 numeric score (uses rounded clamp). */
export function getGradeFromScore(score: number): "A" | "B" | "C" | "D" {
  const s = clampScore(score);
  if (s >= 80) return "A";
  if (s >= 60) return "B";
  if (s >= 40) return "C";
  return "D";
}

const LETTER_TO_DEAL_GRADE: Record<ReturnType<typeof getGradeFromScore>, DealScoreResult["grade"]> = {
  A: "A Deal",
  B: "B Deal",
  C: "C Deal",
  D: "D Deal",
};

/** Full UI/storage label ("A Deal", …) — always derived from numeric score. */
export function dealGradeFullLabelFromScore(score: number): DealScoreResult["grade"] {
  return LETTER_TO_DEAL_GRADE[getGradeFromScore(score)];
}

/** @deprecated Prefer {@link dealGradeFullLabelFromScore} or {@link getGradeFromScore}. */
export function dealLetterGradeFromScore(score: number): DealScoreResult["grade"] {
  return dealGradeFullLabelFromScore(score);
}

/** True when state is Texas or county is in a known Texas-focused target set. */
export function isTexasDealContext(
  countyRaw: string | null | undefined,
  stateRaw: string | null | undefined
): boolean {
  const county = typeof countyRaw === "string" ? countyRaw : "";
  const state = typeof stateRaw === "string" ? stateRaw : "";
  if (state && isTexasState(state)) return true;
  if (county && (isTopTargetCounty(county) || isStrongCounty(county))) return true;
  return false;
}

function extractedTextMeaningfulForScoring(rec: Record<string, unknown>): boolean {
  const len = readFiniteNumber(rec.extracted_text_length) ?? 0;
  if (len >= 120) return true;
  const legal = readNonEmptyString(rec.legal_description);
  return !!legal && legal.length >= 20;
}

function uselessExtractedText(rec: Record<string, unknown>): boolean {
  return !extractedTextMeaningfulForScoring(rec);
}

function extremelyLowExtractionConfidence(conf: number | null): boolean {
  return conf !== null && conf < 0.2;
}

/** When true, a final numeric score of 0 is allowed (non–intel-only path). */
function allowsDealScoreZero(
  rec: Record<string, unknown>,
  ownerPresent: boolean,
  countyUnknown: boolean,
  conf: number | null
): boolean {
  if (extractionNeedsReview(rec)) return false;
  if (!ownerPresent && countyUnknown) return true;
  if (uselessExtractedText(rec) && extremelyLowExtractionConfidence(conf)) return true;
  return false;
}

function realDealMinimumScoreFloorApplies(
  rec: Record<string, unknown>,
  ownerPresent: boolean,
  countyUnknown: boolean,
  countyRaw: string | undefined,
  stateRaw: string | undefined,
  leaseRaw: string | undefined
): boolean {
  if (!ownerPresent || countyUnknown) return false;
  if (!isTexasDealContext(countyRaw, stateRaw)) return false;
  if (!isLeaseStatusUnknownTier(leaseRaw) && !extractedTextMeaningfulForScoring(rec)) return false;
  return true;
}

function readFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = parseFloat(value.trim());
    if (!Number.isNaN(n) && Number.isFinite(n)) return n;
  }
  return undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") {
    const t = value.trim();
    if (t) return t;
  }
  return undefined;
}

/**
 * Parses extraction royalty strings (e.g. "1/8", "12.5%", "0.125") to a 0–1 fraction.
 * Returns undefined when missing or unparseable.
 */
export function parseRoyaltyRateFraction(raw: string | null | undefined): number | undefined {
  if (raw == null) return undefined;
  const t = raw.trim();
  if (!t) return undefined;

  const frac = /^(\d+)\s*\/\s*(\d+)$/.exec(t);
  if (frac) {
    const a = Number(frac[1]);
    const b = Number(frac[2]);
    if (b !== 0 && Number.isFinite(a) && Number.isFinite(b)) return a / b;
    return undefined;
  }

  if (/%\s*$/.test(t)) {
    const n = parseFloat(t.replace(/%\s*$/, "").trim().replace(/,/g, ""));
    if (Number.isFinite(n)) return n / 100;
    return undefined;
  }

  const plain = parseFloat(t.replace(/,/g, ""));
  if (!Number.isFinite(plain)) return undefined;
  if (plain > 1 && plain <= 100) return plain / 100;
  return plain;
}

function incompleteIntelOnly(): DealScoreResult {
  const score = 0;
  return {
    score,
    grade: dealGradeFullLabelFromScore(score),
    reasons: ["Intel-only document — not scored as a deal lead"],
    incomplete_data: true,
  };
}

function hasIdentifiedOwner(src: Record<string, unknown>): boolean {
  const keys = ["grantor", "lessor", "owner", "owner_name", "ownerName"] as const;
  for (const k of keys) {
    if (readNonEmptyString(src[k])) return true;
  }
  return false;
}

function isCountyUnknown(countyRaw: string | undefined, stateRaw: string | undefined): boolean {
  if (!countyRaw) return true;
  const n = normalizeCountyName(countyRaw);
  if (!n || n === "unknown" || n === "n/a" || n === "na" || n === "none") return true;
  if (n.length <= 2 && /^[a-z]{2}$/.test(n) && stateRaw && normalizeCountyName(stateRaw) === n) return true;
  return false;
}

function isTopTargetCounty(county: string): boolean {
  return TOP_TARGET_COUNTIES.has(normalizeCountyName(county));
}

function isStrongCounty(county: string): boolean {
  const n = normalizeCountyName(county);
  return STRONG_COUNTIES.has(n) && !TOP_TARGET_COUNTIES.has(n);
}

function locationPoints(countyRaw: string | undefined, stateRaw: string | undefined): { pts: number; note: string } {
  if (isCountyUnknown(countyRaw, stateRaw)) {
    return { pts: 0, note: "County unknown — no location quality points" };
  }
  const c = countyRaw!.trim();
  if (isTopTargetCounty(c)) {
    return { pts: 20, note: "Top-target county (+20)" };
  }
  if (isStrongCounty(c)) {
    return { pts: 15, note: "Strong buyer county (+15)" };
  }
  if (stateRaw && isTexasState(stateRaw)) {
    return { pts: 8, note: "Texas county — average market (+8)" };
  }
  return { pts: 4, note: "Weaker / non-core market (+4)" };
}

function isLeaseStatusUnknownTier(leaseRaw: string | undefined): boolean {
  if (leaseRaw === undefined) return true;
  const raw = leaseRaw.trim();
  if (!raw) return true;
  if (raw === "—") return true;
  const s = raw.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  if (s === "none" || s === "no lease" || s === "no lease found" || /\bno lease found\b/.test(s)) return true;
  if (s === "expired") return false;
  if (s === "active") return false;
  if (s === "expiring soon") return false;
  if (s === "unknown" || /\bunclear\b/.test(s)) return true;
  return false;
}

function normalizeLeaseStatus(raw: string): string {
  const s = raw.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  if (s === "expiring soon") return "expiring soon";
  return s;
}

function opportunityPoints(
  leaseRaw: string | undefined,
  recencyMonths: number | undefined,
  operatorRaw: string | undefined
): { pts: number; note: string } {
  if (leaseRaw) {
    const ls = normalizeLeaseStatus(leaseRaw);
    if (ls === "expired") {
      return { pts: 20, note: "Likely expired lease — strong opportunity (+20)" };
    }
  }
  if (isLeaseStatusUnknownTier(leaseRaw)) {
    return { pts: 12, note: "Lease unknown / open — opportunity (+12)" };
  }
  const ls = leaseRaw ? normalizeLeaseStatus(leaseRaw) : "";
  const oldEnough = recencyMonths !== undefined && recencyMonths >= 30;
  const weakOp = !operatorRaw || operatorRaw.trim().length < 2;
  if (oldEnough && weakOp && ls !== "active" && ls !== "expiring soon") {
    return { pts: 10, note: "Older record with unclear operator / hold (+10)" };
  }
  if (ls === "expiring soon") {
    return { pts: 4, note: "Lease expiring soon — still held (+4)" };
  }
  if (ls === "active") {
    return { pts: 2, note: "Clearly active / held lease (+2)" };
  }
  return { pts: 1, note: "Limited opportunity signal (+1)" };
}

const PHONE_LIKE = /(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b|\b\d{10}\b/;

function hasPhone(src: Record<string, unknown>): boolean {
  const keys = ["phone", "owner_phone", "contact_phone", "telephone"] as const;
  for (const k of keys) {
    const v = readNonEmptyString(src[k]);
    if (v && PHONE_LIKE.test(v.replace(/\s+/g, " "))) return true;
  }
  return false;
}

const EMAIL_LIKE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

function hasEmail(src: Record<string, unknown>): boolean {
  for (const k of ["email", "owner_email"] as const) {
    const v = readNonEmptyString(src[k]);
    if (v && EMAIL_LIKE.test(v)) return true;
  }
  return false;
}

function mailingUsable(src: Record<string, unknown>): boolean {
  for (const k of ["mailing_address", "owner_mailing_address", "postal_address"] as const) {
    const v = readNonEmptyString(src[k]);
    if (!v || v.length < 6) continue;
    if (/\d/.test(v) || /\bp\.?\s*o\.?\s*box\b/i.test(v)) return true;
  }
  return false;
}

function usefulEntityType(src: Record<string, unknown>): boolean {
  for (const k of ["owner_entity_type", "entity_type", "ownership_entity_type"] as const) {
    const v = readNonEmptyString(src[k]);
    if (!v) continue;
    const l = v.toLowerCase();
    if (
      /\b(llc|l\.l\.c\.?|trust|corporation|corp\.?|inc\.?|ltd|limited|lp|l\.p\.?|individual|sole\s+prop)\b/.test(
        l
      )
    ) {
      return true;
    }
  }
  return false;
}

function ownershipQuality(
  src: Record<string, unknown>,
  ownerPresent: boolean
): { pts: number; notes: string[] } {
  let pts = 0;
  const notes: string[] = [];
  if (ownerPresent) {
    pts += 10;
    notes.push("Owner name present (+10)");
  }
  if (mailingUsable(src)) {
    pts += 10;
    notes.push("Mailing address usable (+10)");
  }
  if (usefulEntityType(src)) {
    pts += 5;
    notes.push("Useful owner / entity type (+5)");
  }
  return { pts: Math.min(25, pts), notes };
}

function contactabilityPoints(src: Record<string, unknown>): { pts: number; notes: string[] } {
  let pts = 0;
  const notes: string[] = [];
  if (hasPhone(src)) {
    pts += 10;
    notes.push("Phone found (+10)");
  }
  if (mailingUsable(src)) {
    pts += 5;
    notes.push("Mailing address for contact (+5)");
  }
  if (hasEmail(src)) {
    pts += 3;
    notes.push("Email found — bonus (+3)");
  }
  return { pts: Math.min(18, pts), notes };
}

function sizeEconomicsPoints(acreage: number | undefined, legalHint: boolean): { pts: number; note: string } {
  if (acreage !== undefined && acreage >= 20) {
    return { pts: 10, note: "Meaningful acreage (+10)" };
  }
  if (acreage !== undefined && acreage >= 8) {
    return { pts: 6, note: "Moderate / inferred size (+6)" };
  }
  if (acreage !== undefined && acreage > 0) {
    return { pts: 3, note: "Small interest — weaker economics (+3)" };
  }
  if (legalHint) {
    return { pts: 5, note: "Size inferred from legal only (+5)" };
  }
  return { pts: 0, note: "No usable acreage signal" };
}

function operatorBuyerPoints(
  miles: number | undefined,
  countyRaw: string | undefined
): { pts: number; note: string } {
  const hotCounty = countyRaw && isTopTargetCounty(countyRaw);
  if (miles !== undefined && miles >= 0 && miles <= 5) {
    return { pts: 10, note: "Near active drilling / hot activity (+10)" };
  }
  if (hotCounty) {
    return { pts: 10, note: "Top-target county — strong buyer interest (+10)" };
  }
  if (miles !== undefined && miles > 5 && miles <= 20) {
    return { pts: 7, note: "Decent buyer market — drilling within ~20 mi (+7)" };
  }
  if (countyRaw && isStrongCounty(countyRaw)) {
    return { pts: 7, note: "Strong county — decent buyer market (+7)" };
  }
  if (countyRaw && !isCountyUnknown(countyRaw, undefined)) {
    return { pts: 2, note: "Some location context — lower activity (+2)" };
  }
  return { pts: 0, note: "Limited operator / buyer signal (+0)" };
}

function extractionNeedsReview(rec: Record<string, unknown>): boolean {
  const s = readNonEmptyString(rec.extraction_status)?.toLowerCase();
  return s === "low_confidence" || s === "partial" || s === "failed";
}

function readExtractionConfidence(src: Record<string, unknown>): number | null {
  const candidates = [src.extraction_confidence, src.confidence_score, src.confidence];
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c) && c >= 0 && c <= 1) return c;
    if (typeof c === "string") {
      const n = parseFloat(c.trim());
      if (!Number.isNaN(n) && n >= 0 && n <= 1) return n;
    }
  }
  return null;
}

function confidenceMultiplier(conf: number | null): number {
  if (conf == null || conf >= 0.85) return 1;
  if (conf >= 0.7) return 0.95;
  if (conf >= 0.55) return 0.9;
  if (conf >= 0.45) return 0.8;
  return 0.65;
}

function confidenceReason(conf: number | null): string | null {
  if (conf == null || conf >= 0.85) return null;
  if (conf >= 0.7) return `Extraction confidence ${(conf * 100).toFixed(0)}% — score −5%`;
  if (conf >= 0.55) return `Extraction confidence ${(conf * 100).toFixed(0)}% — score −10%`;
  if (conf >= 0.45) return `Extraction confidence ${(conf * 100).toFixed(0)}% — score −20%`;
  return `Extraction confidence ${(conf * 100).toFixed(0)}% — score −35%`;
}

function downgradeFullGrade(g: DealScoreResult["grade"]): DealScoreResult["grade"] {
  switch (g) {
    case "A Deal":
      return "B Deal";
    case "B Deal":
      return "C Deal";
    case "C Deal":
      return "D Deal";
    case "D Deal":
      return "D Deal";
    default:
      return g;
  }
}

function maxScoreForGrade(g: DealScoreResult["grade"]): number {
  switch (g) {
    case "A Deal":
      return 100;
    case "B Deal":
      return 79;
    case "C Deal":
      return 59;
    case "D Deal":
      return 39;
    default:
      return 39;
  }
}

function pickReasons(pool: string[], minN: number, maxN: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of pool) {
    const t = typeof r === "string" ? r.trim() : "";
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= maxN) break;
  }
  const fallbacks = [
    "Composite 100-point mineral lead model (ownership, location, opportunity, contact, size, buyers)",
    "Rescore after richer extraction improves caps, floors, and confidence handling",
  ];
  for (const f of fallbacks) {
    if (out.length >= minN) break;
    if (!seen.has(f)) {
      seen.add(f);
      out.push(f);
    }
  }
  return out.slice(0, maxN);
}

function isIntelOnlyDocument(src: Record<string, unknown>): boolean {
  if (src.intel_only === true) return true;
  const dt = readNonEmptyString(src.document_type);
  if (!dt) return false;
  if (
    /\b(operator\s*\/\s*intel|operator\s+intel|intel\s+report|well\s*completion|scout\s*ticket|drilling\s+report|wellbore\s+report)\b/i.test(
      dt
    )
  ) {
    return true;
  }
  return /\b(intel|intelligence|research|market\s*(?:study|report)|industry\s*report|comp(?:any)?\s*stak|data\s*room|broker\s*(?:opinion|report)|appraisal\s*report|reserve\s*report|teaser|confidential\s*information\s*memorandum|cim)\b/i.test(
    dt
  );
}

const COMPANY_ENTITY_RE =
  /\b(llc|l\.l\.c\.?|inc\.?|corp\.?|corporation|ltd\.?|limited|lp\b|l\.p\.?|p\.l\.c\.|plc\b|co\.|company|trust|partners|partnership|holdings|operating|energy|resources|petroleum|ventures|group)\b/i;

function companyNameLooksLikeEntity(name: string): boolean {
  return COMPANY_ENTITY_RE.test(name.trim());
}

function documentTypeHasConveyanceIntelKeywords(documentType: string): boolean {
  const l = documentType.toLowerCase();
  return l.includes("deed") || l.includes("assignment") || l.includes("conveyance");
}

function partyEntryIsCompany(p: unknown): boolean {
  if (typeof p === "string") return companyNameLooksLikeEntity(p);
  if (!p || typeof p !== "object" || Array.isArray(p)) return false;
  const o = p as Record<string, unknown>;
  const t = o.type ?? o.party_type ?? o.entity_type ?? o.kind;
  if (typeof t === "string") {
    const tl = t.trim().toLowerCase();
    if (/\b(company|corporation|corp|llc|entity|organization|organisation)\b/.test(tl)) return true;
    if (/\b(individual|person|natural)\b/.test(tl)) return false;
  }
  const n = o.name ?? o.party_name ?? o.legal_name;
  if (typeof n === "string" && n.trim()) return companyNameLooksLikeEntity(n);
  return false;
}

/** Prefer explicit deed labels, then lease labels, for conveyance / classification. */
function grantorConveyanceSide(src: Record<string, unknown>): string | undefined {
  return readNonEmptyString(src.grantor) ?? readNonEmptyString(src.lessor);
}

function granteeConveyanceSide(src: Record<string, unknown>): string | undefined {
  return readNonEmptyString(src.grantee) ?? readNonEmptyString(src.lessee);
}

function partiesContainIndividualParty(src: Record<string, unknown>): boolean {
  const parties = src.parties;
  if (!Array.isArray(parties)) return false;
  for (const p of parties) {
    if (typeof p === "string") {
      const t = p.trim();
      if (t && !companyNameLooksLikeEntity(t)) return true;
      continue;
    }
    if (!p || typeof p !== "object" || Array.isArray(p)) continue;
    const o = p as Record<string, unknown>;
    const t = readNonEmptyString(o.type ?? o.party_type ?? o.entity_type ?? o.kind);
    if (t && /\b(individual|person|natural|sole\s+proprietor)\b/i.test(t)) return true;
    const n = readNonEmptyString(o.name ?? o.party_name ?? o.legal_name);
    if (n && !companyNameLooksLikeEntity(n)) return true;
  }
  return false;
}

/**
 * When both conveyance sides look like companies, treat as intel unless the record clearly supports
 * outbound contact to a seller (phone/email or an individual party in structured `parties`).
 */
function hasStrongCallableSellerLeadEvidence(src: Record<string, unknown>): boolean {
  if (hasPhone(src) || hasEmail(src)) return true;
  if (mailingUsable(src) && partiesContainIndividualParty(src)) return true;
  return false;
}

/** True when structured `parties` are all company-like, or both grantor/grantee-style names look corporate. */
export function partiesAreCompanies(src: Record<string, unknown>): boolean {
  const parties = src.parties;
  if (Array.isArray(parties) && parties.length >= 2) {
    return parties.every((p) => partyEntryIsCompany(p));
  }
  const grantorSide = grantorConveyanceSide(src);
  const granteeSide = granteeConveyanceSide(src);
  if (!grantorSide || !granteeSide) return false;
  return companyNameLooksLikeEntity(grantorSide) && companyNameLooksLikeEntity(granteeSide);
}

/**
 * Classifies scoring V2 track: corporate deed / assignment / conveyance → intel; otherwise lead.
 */
export function classifyDealScoreType(
  data: DealScoreInput | Record<string, unknown> | null | undefined
): DealScoreKind {
  const src = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  const rec = src as Record<string, unknown>;
  const dt = readNonEmptyString(rec.document_type);
  if (!dt || !documentTypeHasConveyanceIntelKeywords(dt)) return "lead";
  if (!partiesAreCompanies(rec)) return "lead";
  if (hasStrongCallableSellerLeadEvidence(rec)) return "lead";
  return "intel";
}

/**
 * When deal scoring credits hot operator / drilling proximity, returns a short phrase for UI summaries.
 */
export function shortDrillingProximityPhrase(
  data: DealScoreInput | Record<string, unknown> | null | undefined
): string | null {
  const src = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  const rec = src as Record<string, unknown>;
  const miles = readFiniteNumber(
    rec.drilling_distance_miles ?? rec.drillingActivityMiles ?? rec.drilling_miles
  );
  const countyRaw = readNonEmptyString(rec.county);
  if (miles !== undefined && miles >= 0 && miles <= 5) {
    return "near active drilling";
  }
  if (countyRaw && isTopTargetCounty(countyRaw)) {
    return "near active drilling";
  }
  return null;
}

/**
 * Lead-track scoring: 0–100 mineral lead model (ownership, location, opportunity, contact, size, buyers).
 */
export function calculateLeadScore(
  data: DealScoreInput | Record<string, unknown> | null | undefined
): DealScoreResult {
  const src = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  const rec = src as Record<string, unknown>;

  if (isIntelOnlyDocument(rec)) {
    console.log("SCORING INPUTS SUMMARY", {
      intel_only: true,
      document_type: readNonEmptyString(rec.document_type) ?? null,
    });
    console.log("FINAL RAW SCORE", 0);
    console.log("FINAL FLOORED SCORE", 0);
    console.log("FINAL DISPLAY SCORE", 0);
    console.log("FINAL DISPLAY GRADE", getGradeFromScore(0));
    console.log("[score-debug] score =", 0);
    console.log("[score-debug] grade =", getGradeFromScore(0));
    return incompleteIntelOnly();
  }

  const countyRaw = readNonEmptyString(rec.county);
  const stateRaw = readNonEmptyString(rec.state);
  const leaseRaw = readNonEmptyString(rec.lease_status);
  const acreage = readFiniteNumber(rec.acreage);
  const recordingDateStr = readNonEmptyString(rec.recording_date);
  const effectiveDateStr = readNonEmptyString(rec.effective_date);
  let recencyMonths = readFiniteNumber(rec.recency_months);
  const refDate =
    (recordingDateStr && parseDocumentDate(recordingDateStr)) ??
    (effectiveDateStr && parseDocumentDate(effectiveDateStr)) ??
    null;
  if (refDate) {
    recencyMonths = calendarMonthsSince(refDate, new Date());
  }
  const operatorRaw = readNonEmptyString(rec.operator);
  const miles = readFiniteNumber(
    rec.drilling_distance_miles ?? rec.drillingActivityMiles ?? rec.drilling_miles
  );

  const ownerPresent = hasIdentifiedOwner(rec);
  const countyUnknown = isCountyUnknown(countyRaw, stateRaw);
  const legalDesc = readNonEmptyString(rec.legal_description);
  const legalHint = !!legalDesc && legalDesc.length >= 12;

  const conf = readExtractionConfidence(rec);
  const mult = confidenceMultiplier(conf);
  const confNote = confidenceReason(conf);

  const ownQ = ownershipQuality(rec, ownerPresent);
  const loc = locationPoints(countyRaw, stateRaw);
  const opp = opportunityPoints(leaseRaw, recencyMonths, operatorRaw);
  const contact = contactabilityPoints(rec);
  const sizeEcon = sizeEconomicsPoints(acreage, legalHint && acreage === undefined);
  const opBuy = operatorBuyerPoints(miles, countyRaw);

  console.log("SCORING INPUTS SUMMARY", {
    owner_present: ownerPresent,
    county: countyRaw ?? null,
    state: stateRaw ?? null,
    county_unknown: countyUnknown,
    texas_context: isTexasDealContext(countyRaw, stateRaw),
    lease_status: leaseRaw ?? null,
    lease_unknown_tier: isLeaseStatusUnknownTier(leaseRaw),
    extracted_text_length: readFiniteNumber(rec.extracted_text_length) ?? null,
    text_meaningful: extractedTextMeaningfulForScoring(rec),
    extraction_confidence: conf,
    intel_only: false,
  });

  let raw =
    ownQ.pts + loc.pts + opp.pts + contact.pts + sizeEcon.pts + opBuy.pts;
  raw = Math.min(100, raw);

  console.log("FINAL RAW SCORE", raw);

  let score = clampScore(raw * mult);

  const leaseUnknownForFloor = isLeaseStatusUnknownTier(leaseRaw);
  const topCo = countyRaw && isTopTargetCounty(countyRaw);
  const mailOk = mailingUsable(rec);
  const phoneOk = hasPhone(rec);
  const meaningfulAc = acreage !== undefined && acreage >= 20;

  if (ownerPresent && mailOk && topCo && leaseUnknownForFloor) {
    score = Math.max(score, 60);
  }
  if (ownerPresent && phoneOk && topCo) {
    score = Math.max(score, 65);
  }
  if (ownerPresent && mailOk && meaningfulAc && topCo) {
    score = Math.max(score, 70);
  }

  const reviewWeakExtraction = extractionNeedsReview(rec);
  if (!ownerPresent || countyUnknown) {
    score = Math.min(score, reviewWeakExtraction ? 69 : 59);
  }

  if (realDealMinimumScoreFloorApplies(rec, ownerPresent, countyUnknown, countyRaw, stateRaw, leaseRaw)) {
    score = Math.max(score, 40);
  }

  if (conf !== null && conf < 0.45) {
    const g0 = dealGradeFullLabelFromScore(score);
    const g2 = downgradeFullGrade(g0);
    score = Math.min(score, maxScoreForGrade(g2));
  }

  if (score <= 0 && !allowsDealScoreZero(rec, ownerPresent, countyUnknown, conf)) {
    score = 1;
  }

  const flooredScore = score;
  console.log("FINAL FLOORED SCORE", flooredScore);

  score = clampScore(score);
  const grade = dealGradeFullLabelFromScore(score);

  console.log("FINAL DISPLAY SCORE", score);
  console.log("FINAL DISPLAY GRADE", getGradeFromScore(score));
  console.log("[score-debug] score =", score);
  console.log("[score-debug] grade =", getGradeFromScore(score));

  const reasonPool: string[] = [
    ...ownQ.notes,
    loc.note,
    opp.note,
    ...contact.notes,
    sizeEcon.note,
    opBuy.note,
  ];
  if (confNote) reasonPool.push(confNote);
  if (!ownerPresent) {
    reasonPool.push(
      reviewWeakExtraction
        ? "Owner not extracted — low-confidence document; needs review"
        : "No owner name — capped at grade C"
    );
  }
  if (countyUnknown) {
    reasonPool.push(
      reviewWeakExtraction
        ? "County unclear from extraction — needs review before using location score"
        : "County unknown — capped at grade C"
    );
  }
  if (reviewWeakExtraction) {
    reasonPool.push("Low-confidence extraction — distinguish from weak deal quality");
  }
  if (conf !== null && conf < 0.45) {
    reasonPool.push("Low extraction confidence — downgraded one full grade");
  }

  const reasons = pickReasons(reasonPool, 2, 4);

  return {
    score,
    grade,
    reasons,
  };
}

/**
 * Intel-track scoring for corporate deed / assignment / conveyance: emphasizes parties, legal text, location, recency, and play context.
 */
export function calculateIntelScore(
  data: DealScoreInput | Record<string, unknown> | null | undefined
): DealScoreResult {
  const src = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  const rec = src as Record<string, unknown>;

  const countyRaw = readNonEmptyString(rec.county);
  const stateRaw = readNonEmptyString(rec.state);
  const loc = locationPoints(countyRaw, stateRaw);

  const grantorSide = grantorConveyanceSide(rec);
  const granteeSide = granteeConveyanceSide(rec);
  const partyNotes: string[] = [];
  let partyPts = 0;
  if (grantorSide && granteeSide) {
    partyPts = 25;
    partyNotes.push("Grantor and grantee identified on instrument (+25)");
  } else if (grantorSide || granteeSide) {
    partyPts = 12;
    partyNotes.push("One conveyance party identified (+12)");
  }

  const legalDesc = readNonEmptyString(rec.legal_description);
  let legalNote = "No legal description signal";
  let legalPts = 0;
  if (legalDesc && legalDesc.length >= 60) {
    legalPts = 20;
    legalNote = "Strong legal description for title intel (+20)";
  } else if (legalDesc && legalDesc.length >= 25) {
    legalPts = 12;
    legalNote = "Usable legal description (+12)";
  } else if (legalDesc) {
    legalPts = 5;
    legalNote = "Minimal legal description (+5)";
  }

  const recordingDateStr = readNonEmptyString(rec.recording_date);
  const effectiveDateStr = readNonEmptyString(rec.effective_date);
  const refDate =
    (recordingDateStr && parseDocumentDate(recordingDateStr)) ??
    (effectiveDateStr && parseDocumentDate(effectiveDateStr)) ??
    null;
  let recencyPts = 0;
  let recencyNote = "No recording / effective date for recency";
  if (refDate) {
    const months = calendarMonthsSince(refDate, new Date());
    if (months <= 36) {
      recencyPts = 18;
      recencyNote = "Recent instrument — fresher intel (+18)";
    } else if (months <= 120) {
      recencyPts = 10;
      recencyNote = "Moderate record age — still useful (+10)";
    } else {
      recencyPts = 4;
      recencyNote = "Older record — lower timeliness (+4)";
    }
  }

  const miles = readFiniteNumber(
    rec.drilling_distance_miles ?? rec.drillingActivityMiles ?? rec.drilling_miles
  );
  const opBuy = operatorBuyerPoints(miles, countyRaw);

  const conf = readExtractionConfidence(rec);
  const mult = confidenceMultiplier(conf);
  const confNote = confidenceReason(conf);

  let raw = loc.pts + partyPts + legalPts + recencyPts + opBuy.pts;
  raw = Math.min(100, raw);
  let score = clampScore(raw * mult);

  if (grantorSide && granteeSide && countyRaw && isTopTargetCounty(countyRaw)) {
    score = Math.max(score, 52);
  }

  if (conf !== null && conf < 0.45) {
    const g0 = dealGradeFullLabelFromScore(score);
    const g2 = downgradeFullGrade(g0);
    score = Math.min(score, maxScoreForGrade(g2));
  }

  if (score <= 0) {
    score = 1;
  }

  score = clampScore(score);
  const grade = dealGradeFullLabelFromScore(score);

  const reasonPool: string[] = [loc.note, ...partyNotes, legalNote, recencyNote, opBuy.note];
  if (confNote) reasonPool.push(confNote);
  reasonPool.push("Corporate conveyance — intel scoring track");

  const reasons = pickReasons(reasonPool, 2, 4);

  return {
    score,
    grade,
    reasons,
  };
}

/**
 * Dual scoring V2: classifies lead vs intel, then runs the appropriate model. Adds `type` on the result.
 */
export function calculateDealScore(
  data: DealScoreInput | Record<string, unknown> | null | undefined
): DealScoreResult {
  const src = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  const rec = src as Record<string, unknown>;
  const docTypeNorm = readNonEmptyString(rec.document_type) ?? null;
  const corpCorp = partiesAreCompanies(rec);
  const callableSeller = hasStrongCallableSellerLeadEvidence(rec);
  console.log("[deal-score] CLASSIFICATION INPUTS", {
    document_type: docTypeNorm,
    grantor: grantorConveyanceSide(rec) ?? null,
    grantee: granteeConveyanceSide(rec) ?? null,
    lessor: readNonEmptyString(rec.lessor) ?? null,
    lessee: readNonEmptyString(rec.lessee) ?? null,
    parties: rec.parties ?? null,
    parties_are_companies: corpCorp,
    conveyance_keywords: docTypeNorm ? documentTypeHasConveyanceIntelKeywords(docTypeNorm) : false,
    callable_seller_evidence: callableSeller,
  });
  console.log("[deal-score] PARTIES NORMALIZED", rec.parties ?? null);
  console.log("[deal-score] DOCUMENT TYPE NORMALIZED", docTypeNorm);
  const type = classifyDealScoreType(rec);
  console.log("[deal-score] TYPE", type);
  const inner = type === "lead" ? calculateLeadScore(rec) : calculateIntelScore(rec);
  const result: DealScoreResult = { ...inner, type };
  console.log("[deal-score] SCORE CALCULATED", result.score);
  return result;
}

/** Whole calendar months from `earlier` to `later` (non-negative). */
export function calendarMonthsSince(earlier: Date, later: Date): number {
  if (later.getTime() < earlier.getTime()) return 0;
  let months =
    (later.getFullYear() - earlier.getFullYear()) * 12 + (later.getMonth() - earlier.getMonth());
  if (later.getDate() < earlier.getDate()) months -= 1;
  return Math.max(0, months);
}

/** Months from `date` until `now` (non-negative), by calendar month boundaries. */
export function monthsSinceDate(date: Date, now: Date = new Date()): number {
  return calendarMonthsSince(date, now);
}

/** Best-effort parse for ISO or common US date strings; returns null if not parseable. */
export function parseDocumentDate(value: string | null | undefined): Date | null {
  if (value == null || typeof value !== "string") return null;
  const t = value.trim();
  if (!t) return null;

  const yearOnly = /^(\d{4})$/.exec(t);
  if (yearOnly) {
    const y = Number(yearOnly[1]);
    if (y >= 1900 && y <= 2100) {
      return new Date(y, 0, 1, 12, 0, 0, 0);
    }
    return null;
  }

  const isoDateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (isoDateOnly) {
    const y = Number(isoDateOnly[1]);
    const m = Number(isoDateOnly[2]) - 1;
    const d = Number(isoDateOnly[3]);
    if (y >= 1900 && y <= 2100 && m >= 0 && m <= 11 && d >= 1 && d <= 31) {
      const local = new Date(y, m, d, 12, 0, 0, 0);
      if (local.getFullYear() === y && local.getMonth() === m && local.getDate() === d) {
        return local;
      }
    }
    return null;
  }

  const parsed = Date.parse(t);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed);
}
