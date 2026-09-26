/** Conservative index relevance for discovery, never a verified conveyance. */
export interface SearchTract {
  id: string; county: string; section_name: string | null;
  block_number: string | null; match_status: string;
}

const norm = (v: string) => v.toUpperCase().replace(/\s/g, "").replace(/^0+(?=\d)/, "");
const NUM = String.raw`\d+[A-Z]?`;
// One number or a range ("22-24"); the dash is only a range between two numbers.
const ITEM = String.raw`${NUM}(?:\s*-\s*\d+)?`;
// A designator followed by one item or a list ("37,48", "37 & 48", "22-24,26-28").
const LIST = String.raw`(${ITEM}(?:\s*(?:,|&|\bAND\b)\s*${ITEM})*)`;
const MAX_RANGE = 60;
// Both clerk formats seen live in Midland: "SEC 37 BLK 39 T4S" and the
// labeled "Survey Block: 39 Township: T4S Section: 37".
// Howard's clerk writes aliquot parts before the number: "Section: E/2 10"
// is the east half of Section 10. The part is skipped, never read as the section.
const ALIQUOT = String.raw`(?:(?:[NSEW]{1,2}\s*/\s*[24]|ALL)\s*(?:OF\s*)?)*`;
const SECTION_RE = new RegExp(String.raw`\bSEC(?:TION)?S?\.?\s*:?\s*-?\s*${ALIQUOT}${LIST}`, "g");
const BLOCK_RE = new RegExp(String.raw`\bBL(?:OC)?K\.?\s*:?\s*-?\s*${LIST}`, "g");
const TOWNSHIP_RE = /\bT(?:OWNSHIP)?\s*:?\s*-?\s*(\d+)\s*-?\s*([NS])\b/g;

function listed(text: string, re: RegExp): Set<string> {
  const out = new Set<string>();
  for (const m of text.toUpperCase().matchAll(re)) {
    for (const v of m[1].split(/\s*(?:,|&|\bAND\b)\s*/)) {
      const range = v.match(/^(\d+)\s*-\s*(\d+)$/);
      if (range) {
        const [lo, hi] = [Number(range[1]), Number(range[2])];
        // An implausible span is more likely a typo than a range; keep its ends only.
        if (hi >= lo && hi - lo <= MAX_RANGE) for (let n = lo; n <= hi; n++) out.add(String(n));
        else { out.add(norm(range[1])); out.add(norm(range[2])); }
      } else if (v) out.add(norm(v));
    }
  }
  return out;
}
function townships(text: string): Set<string> {
  return new Set([...text.toUpperCase().matchAll(TOWNSHIP_RE)].map(m => `T${norm(m[1])}${m[2]}`));
}

function identity(t: SearchTract) {
  if (t.match_status !== "confirmed") return null;
  const section = t.section_name?.trim().match(/^(?:SEC(?:TION)?\.?\s*)?(\d+[A-Z]?)$/i)?.[1];
  const block = t.block_number?.trim().match(/^(?:BL(?:OC)?K\.?\s*)?(\d+[A-Z]?)(?:\s+(T\s*\d+\s*[NS]))?$/i);
  if (!section || !block?.[2]) return null;
  return { section: norm(section), block: norm(block[1]), township: norm(block[2]) };
}
export function tractQueries(t: SearchTract): string[] {
  const i = identity(t);
  return i ? [`SEC ${i.section} BLK ${i.block} ${i.township}`, `SECTION ${i.section} BLOCK ${i.block} ${i.township}`] : [];
}
export function indexMatchesTract(legal: string, t: SearchTract): boolean {
  const i = identity(t);
  if (!i) return false;
  // A lease or deed covering several sections of the subject block is part of
  // the subject tract's chain, so the section may be one entry of a list. The
  // block and township must each be unique: a description spanning several
  // blocks or townships cannot say which section belongs to which, so it is
  // rejected rather than stitched together across clauses.
  const blocks = listed(legal, BLOCK_RE);
  const towns = townships(legal);
  return listed(legal, SECTION_RE).has(i.section)
    && blocks.size === 1 && blocks.has(i.block)
    && towns.size === 1 && towns.has(i.township);
}
