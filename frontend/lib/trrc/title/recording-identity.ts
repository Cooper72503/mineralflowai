import { COUNTY_CODE_TO_NAME } from "./county-codes";

const counties = Object.values(COUNTY_CODE_TO_NAME).sort((a, b) => b.length - a.length);
const escaped = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");

/** Match a real Texas county, never the preceding words "of Midland". */
export function texasCounty(value: string | null | undefined): string | null {
  if (!value) return null;
  const clean = value.trim().replace(/^of\s+/i, "").replace(/\s+county(?:,?\s+texas)?$/i, "");
  return counties.find(c => c.toLowerCase() === clean.toLowerCase()) ?? null;
}

/** Reference context can span several jurisdictions. Ambiguity is not a county match. */
export function referenceCounty(context: string): string | null {
  const pattern = new RegExp(`\\b(${counties.map(escaped).join("|")})\\s+County\\b`, "gi");
  const matches = [...new Set([...context.matchAll(pattern)].map(m => texasCounty(m[1].replace(/\s+/g, " "))).filter((c): c is string => !!c))];
  return matches.length === 1 ? matches[0] : null;
}

/** Unknown counties never clear missing-record findings; volume/page boundaries matter. */
export function recordingIdentity(county: string | null, number: string | null, book: string | null): string | null {
  const c = texasCounty(county);
  if (!c) return null;
  if (number) return `${c}|n:${number.toUpperCase().replace(/\s+/g, "")}`;
  const m = book?.match(/(?:vol(?:ume)?\.?|book|bk\.?)\s*(\d+)[,\s]+(?:page|pg\.?|p\.)\s*(\d+)/i);
  return m ? `${c}|v:${Number(m[1])}|p:${Number(m[2])}` : null;
}
