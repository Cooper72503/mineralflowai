/** Conservative index relevance for discovery, never a verified conveyance. */
export interface SearchTract {
  id: string; county: string; section_name: string | null;
  block_number: string | null; match_status: string;
}
function one(text: string, regex: RegExp): string | null {
  const values = new Set([...text.toUpperCase().matchAll(regex)].map(m => m[1].replace(/^0+(?=\d)/, "").replace(/\s/g, "")));
  return values.size === 1 ? [...values][0] : null;
}
function identity(t: SearchTract) {
  if (t.match_status !== "confirmed") return null;
  const section = t.section_name?.trim().match(/^(?:SEC(?:TION)?\.?\s*)?(\d+[A-Z]?)$/i)?.[1];
  const block = t.block_number?.trim().match(/^(?:BL(?:OC)?K\.?\s*)?(\d+[A-Z]?)(?:\s+(T\s*\d+\s*[NS]))?$/i);
  if (!section || !block?.[2]) return null;
  return { section: section.toUpperCase().replace(/^0+(?=\d)/, ""), block: block[1].toUpperCase().replace(/^0+(?=\d)/, ""), township: block[2].toUpperCase().replace(/\s/g, "") };
}
export function tractQueries(t: SearchTract): string[] {
  const i = identity(t);
  return i ? [`SEC ${i.section} BLK ${i.block} ${i.township}`, `SECTION ${i.section} BLOCK ${i.block} ${i.township}`] : [];
}
export function indexMatchesTract(legal: string, t: SearchTract): boolean {
  const i = identity(t);
  if (!i) return false;
  // Reject ambiguous multi-section/block/township descriptions; don't combine
  // a section from one clause with a township from another.
  return one(legal, /\bSEC(?:TION)?\.?\s*(\d+[A-Z]?)\b/g) === i.section
    && one(legal, /\bBL(?:OC)?K\.?\s*(\d+[A-Z]?)\b/g) === i.block
    && one(legal, /\b(T\s*\d+\s*[NS])\b/g) === i.township;
}
