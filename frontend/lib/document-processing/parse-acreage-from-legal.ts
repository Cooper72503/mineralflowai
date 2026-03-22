/**
 * Best-effort acreage figure from legal description text (does not alter extraction).
 * Examples: "containing 160 acres", "160 acres, more or less", "1,234.5 acres".
 */
export function parseAcreageFromLegalDescription(
  legalDescription: string | null | undefined
): number | undefined {
  if (legalDescription == null || typeof legalDescription !== "string") return undefined;
  const text = legalDescription.trim();
  if (!text) return undefined;

  const parseNum = (raw: string): number | undefined => {
    const n = parseFloat(raw.replace(/,/g, ""));
    if (!Number.isFinite(n) || n < 0) return undefined;
    return n;
  };

  const containing = text.match(/containing\s+([\d,]+(?:\.\d+)?)\s+acres?\b/i);
  if (containing) {
    const n = parseNum(containing[1]);
    if (n !== undefined) return n;
  }

  const firstAcres = text.match(/\b([\d,]+(?:\.\d+)?)\s+acres?\b/i);
  if (firstAcres) {
    const n = parseNum(firstAcres[1]);
    if (n !== undefined) return n;
  }

  return undefined;
}
