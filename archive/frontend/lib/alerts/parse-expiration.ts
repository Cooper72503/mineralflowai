/**
 * Calculates a lease expiration date from raw extracted fields.
 *
 * term_length examples: "3 years", "5-year primary term", "36 months",
 *                        "one year", "primary term of 3 years"
 * effective_date examples: "01/15/2022", "January 15, 2022", "2022-01-15"
 */

const WORD_TO_NUM: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

/** Parse term_length string → total months, or null if unrecognisable. */
export function parseTermMonths(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const s = raw.toLowerCase().replace(/[,;]/g, " ");

  // Try word numbers first
  for (const [word, val] of Object.entries(WORD_TO_NUM)) {
    if (s.includes(word)) {
      const monthsMatch = s.includes("month");
      const yearsMatch = s.includes("year");
      if (yearsMatch) return val * 12;
      if (monthsMatch) return val;
    }
  }

  // Try numeric: "3 years", "5-year", "36 months", "3.5 years"
  const numMatch = s.match(/(\d+(?:\.\d+)?)\s*[-\s]*(year|month)/);
  if (numMatch) {
    const n = parseFloat(numMatch[1]);
    const unit = numMatch[2];
    if (unit.startsWith("year")) return Math.round(n * 12);
    if (unit.startsWith("month")) return Math.round(n);
  }

  return null;
}

/** Parse an effective_date string → Date object, or null. */
export function parseEffectiveDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const s = raw.trim();

  // ISO 8601: 2022-01-15
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }

  // MM/DD/YYYY or M/D/YYYY
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (mdy) {
    const d = new Date(Number(mdy[3]), Number(mdy[1]) - 1, Number(mdy[2]));
    return isNaN(d.getTime()) ? null : d;
  }

  // "January 15, 2022" or "Jan 15 2022"
  const attempt = new Date(s);
  if (!isNaN(attempt.getTime())) return attempt;

  return null;
}

/** Add N months to a date (handles month-end rollover). */
function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

export type ExpirationResult = {
  expiration_date: Date;
  /** ISO date string YYYY-MM-DD for DB storage. */
  expiration_date_str: string;
  source: "calculated";
};

/** Derive expiration date. Returns null if either field is missing/unparseable. */
export function calculateExpirationDate(
  effectiveDateRaw: string | null | undefined,
  termLengthRaw: string | null | undefined
): ExpirationResult | null {
  const start = parseEffectiveDate(effectiveDateRaw);
  const months = parseTermMonths(termLengthRaw);

  if (!start || !months || months <= 0) return null;

  const expDate = addMonths(start, months);
  const y = expDate.getFullYear();
  const m = String(expDate.getMonth() + 1).padStart(2, "0");
  const d = String(expDate.getDate()).padStart(2, "0");

  return {
    expiration_date: expDate,
    expiration_date_str: `${y}-${m}-${d}`,
    source: "calculated",
  };
}

/** Days until expiration (negative = already expired). */
export function daysUntilExpiration(expirationDateStr: string): number {
  const exp = new Date(expirationDateStr);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  exp.setHours(0, 0, 0, 0);
  return Math.round((exp.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}
