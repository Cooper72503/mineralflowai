/** Canonical base API for matching source records, never proof of existence. */
export function canonicalApi10(raw: unknown): string | null {
  if (typeof raw !== "string" || !/^[\d\s-]+$/.test(raw.trim())) return null;
  const digits = raw.replace(/[\s-]/g, "");
  const full = digits.length === 8 ? `42${digits}` : digits;
  if (![10, 12, 14].includes(full.length) || !full.startsWith("42")) return null;
  return full.slice(0, 10);
}
