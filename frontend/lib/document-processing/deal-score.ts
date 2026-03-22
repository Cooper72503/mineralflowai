/**
 * Deal scoring for extracted / enriched tract context. Scores are additive by category
 * with exclusive tiers within drilling, acreage, and recency.
 */

export type DealScoreResult = {
  score: number;
  grade: "A Deal" | "B Deal" | "C Deal";
  reasons: string[];
};

/** Texas counties treated as high drilling activity when real distance data is missing (temporary). */
const HIGH_DRILL_ACTIVITY_COUNTIES = new Set([
  "reeves",
  "midland",
  "martin",
  "loving",
  "ward",
]);

function normalizeCountyName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\s+county$/i, "")
    .trim();
}

function isHighDrillActivityCounty(county: string): boolean {
  return HIGH_DRILL_ACTIVITY_COUNTIES.has(normalizeCountyName(county));
}

export type DealScoreInput = {
  /** Distance to nearest active drilling, in miles. */
  drilling_distance_miles?: number | null;
  /** County name for temporary drilling heuristic when distance is unknown. */
  county?: string | null;
  /** One of: expired | none | expiring soon | active (case-insensitive; underscores/hyphens normalized). */
  lease_status?: string | null;
  /** Net mineral / lease acreage. */
  acreage?: number | null;
  /** Months since the relevant event (e.g. recording); lower is better for scoring. */
  recency_months?: number | null;
  /** ISO or common US date strings; used for recency when present (calendar-month distance). */
  recording_date?: string | null;
  effective_date?: string | null;
  /** major | mid */
  operator?: string | null;
  /** single | few */
  ownership?: string | null;
};

function clampScore(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function gradeFromScore(score: number): DealScoreResult["grade"] {
  if (score >= 80) return "A Deal";
  if (score >= 60) return "B Deal";
  return "C Deal";
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

function normalizeLeaseStatus(raw: string): string {
  const s = raw.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  if (s === "expiring soon") return "expiring soon";
  return s;
}

function normalizeOperator(raw: string): string {
  return raw.trim().toLowerCase();
}

function normalizeOwnership(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * When deal scoring would credit drilling proximity, returns a short phrase for UI summaries.
 * Aligns with {@link calculateDealScore} drilling tiers (≤5 mi or high-activity county heuristic).
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
  if (miles !== undefined && miles >= 0) {
    if (miles <= 5) return "near active drilling";
    return null;
  }
  if (miles === undefined && countyRaw && isHighDrillActivityCounty(countyRaw)) {
    return "near active drilling";
  }
  return null;
}

/**
 * Computes a 0–100 deal score, letter-style grade, and human-readable reasons.
 */
export function calculateDealScore(
  data: DealScoreInput | Record<string, unknown> | null | undefined
): DealScoreResult {
  const src = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  const miles = readFiniteNumber(
    (src as Record<string, unknown>).drilling_distance_miles ??
      (src as Record<string, unknown>).drillingActivityMiles ??
      (src as Record<string, unknown>).drilling_miles
  );
  const countyRaw = readNonEmptyString((src as Record<string, unknown>).county);
  const leaseRaw = readNonEmptyString((src as Record<string, unknown>).lease_status);
  const acreage = readFiniteNumber((src as Record<string, unknown>).acreage);
  const recordingDateStr = readNonEmptyString((src as Record<string, unknown>).recording_date);
  const effectiveDateStr = readNonEmptyString((src as Record<string, unknown>).effective_date);
  let recencyMonths = readFiniteNumber((src as Record<string, unknown>).recency_months);
  const refDate =
    (recordingDateStr && parseDocumentDate(recordingDateStr)) ??
    (effectiveDateStr && parseDocumentDate(effectiveDateStr)) ??
    null;
  if (refDate) {
    recencyMonths = calendarMonthsSince(refDate, new Date());
  }
  const operatorRaw = readNonEmptyString((src as Record<string, unknown>).operator);
  const ownershipRaw = readNonEmptyString((src as Record<string, unknown>).ownership);

  let score = 0;
  const reasons: string[] = [];

  if (miles !== undefined && miles >= 0) {
    if (miles <= 1) {
      score += 30;
      reasons.push("Active drilling within 1 mile");
    } else if (miles <= 3) {
      score += 20;
      reasons.push("Active drilling within 3 miles");
    } else if (miles <= 5) {
      score += 10;
      reasons.push("Drilling activity within 5 miles");
    }
  } else if (
    miles === undefined &&
    countyRaw &&
    isHighDrillActivityCounty(countyRaw)
  ) {
    score += 20;
    reasons.push("Active drilling within 3 miles (county heuristic, temporary)");
  }

  if (leaseRaw) {
    const ls = normalizeLeaseStatus(leaseRaw);
    if (ls === "expired") {
      score += 25;
      reasons.push("Lease expired");
    } else if (ls === "none") {
      score += 20;
      reasons.push("No lease found");
    } else if (ls === "expiring soon") {
      score += 15;
      reasons.push("Lease expiring soon");
    }
    // active: +0
  }

  if (acreage !== undefined && acreage >= 0) {
    if (acreage >= 100) {
      score += 15;
      reasons.push("Large acreage (100+ acres)");
    } else if (acreage >= 50) {
      score += 10;
      reasons.push("Medium acreage (50+ acres)");
    } else if (acreage >= 10) {
      score += 5;
      reasons.push("Acreage (10+ acres)");
    }
  }

  if (recencyMonths !== undefined && recencyMonths >= 0) {
    if (recencyMonths <= 6) {
      score += 10;
      reasons.push("Recent document (within 6 months)");
    } else if (recencyMonths <= 24) {
      score += 5;
      reasons.push("Document within 24 months");
    }
  }

  if (operatorRaw) {
    const op = normalizeOperator(operatorRaw);
    if (op === "major") {
      score += 10;
      reasons.push("Major operator nearby");
    } else if (op === "mid") {
      score += 5;
      reasons.push("Mid-size operator nearby");
    }
  }

  if (ownershipRaw) {
    const ow = normalizeOwnership(ownershipRaw);
    if (ow === "single") {
      score += 10;
      reasons.push("Single-owner interest");
    } else if (ow === "few") {
      score += 5;
      reasons.push("Few ownership interests");
    }
  }

  const finalScore = clampScore(score);
  return {
    score: finalScore,
    grade: gradeFromScore(finalScore),
    reasons,
  };
}

/** Whole calendar months from `earlier` to `later` (non-negative). Same calendar year/month boundaries match "within N months" for scoring. */
export function calendarMonthsSince(earlier: Date, later: Date): number {
  if (later.getTime() < earlier.getTime()) return 0;
  let months =
    (later.getFullYear() - earlier.getFullYear()) * 12 +
    (later.getMonth() - earlier.getMonth());
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

  // Year-only: avoid Date.parse("YYYY") UTC midnight, which can land in the prior local calendar year
  // and skew recency for documents dated in the current year.
  const yearOnly = /^(\d{4})$/.exec(t);
  if (yearOnly) {
    const y = Number(yearOnly[1]);
    if (y >= 1900 && y <= 2100) {
      return new Date(y, 0, 1, 12, 0, 0, 0);
    }
    return null;
  }

  // Date-only ISO: Date.parse uses UTC, which can shift to the previous local calendar day/year.
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
