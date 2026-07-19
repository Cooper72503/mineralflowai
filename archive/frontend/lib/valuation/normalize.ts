/**
 * Safe coercions for valuation inputs — never throws; returns null/undefined when unusable.
 */

const LOG = "[valuation-normalize]";

export function pickFirstFiniteNumber(...values: unknown[]): number | null {
  for (const v of values) {
    if (v == null) continue;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const n = parseFloat(v.trim().replace(/,/g, ""));
      if (!Number.isNaN(n) && Number.isFinite(n)) return n;
    }
  }
  return null;
}

/** Prefer first defined non-null; do not let null overwrite. */
export function preferDefined<T>(base: T | null | undefined, next: T | null | undefined): T | null | undefined {
  if (next !== null && next !== undefined) return next;
  return base;
}

/**
 * Normalize royalty to 0–1 decimal when possible (20%, 1/5, 0.2, "20%").
 */
export function normalizeRoyaltyToDecimal(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    if (raw > 1 && raw <= 100) return Math.min(1, raw / 100);
    if (raw > 0 && raw <= 1) return raw;
    return null;
  }
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t) return null;

  const frac = t.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (frac) {
    const a = parseInt(frac[1], 10);
    const b = parseInt(frac[2], 10);
    if (b > 0 && Number.isFinite(a)) return Math.min(1, a / b);
  }

  const pct = t.match(/^([\d.]+)\s*%$/);
  if (pct) {
    const n = parseFloat(pct[1]);
    if (!Number.isNaN(n) && Number.isFinite(n)) return Math.min(1, n / 100);
  }

  const n = parseFloat(t.replace(/,/g, ""));
  if (Number.isNaN(n) || !Number.isFinite(n)) return null;
  if (n > 1 && n <= 100) return Math.min(1, n / 100);
  if (n > 0 && n <= 1) return n;
  return null;
}

/**
 * Ownership / NRI decimal: 50%, 0.5, "50%".
 */
export function normalizeOwnershipPercentToDecimal(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    if (raw > 1 && raw <= 100) return Math.min(1, raw / 100);
    if (raw > 0 && raw <= 1) return raw;
    return null;
  }
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t) return null;
  if (/%/.test(t)) {
    const n = parseFloat(t.replace(/[%\s,]/g, ""));
    if (!Number.isNaN(n) && Number.isFinite(n)) return Math.min(1, n / 100);
  }
  const n = parseFloat(t.replace(/,/g, ""));
  if (Number.isNaN(n) || !Number.isFinite(n)) return null;
  if (n > 1 && n <= 100) return Math.min(1, n / 100);
  if (n > 0 && n <= 1) return n;
  return null;
}

export function logValuationDev(event: string, payload: Record<string, unknown>): void {
  if (process.env.NODE_ENV === "production") return;
  console.log(`${LOG} ${event}`, payload);
}
