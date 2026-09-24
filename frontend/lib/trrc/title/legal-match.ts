/**
 * Does a free-text legal description name a confirmed tract's section,
 * block and township?
 *
 * Mirrors worker/src/title-tract-search.ts#indexMatchesTract, which the
 * worker uses to decide which county index rows are relevant enough to
 * download. The frontend needs the same rule at link time: county index rows
 * carry only the clerk's free text ("SEC 37 BLK 39 T4S T&P RR CO SURV"), so
 * component-key matching could never link one to a tract and no index row
 * ever reached a chain of title. Both copies are tested against the same
 * verbatim Midland records; change them together.
 *
 * Conservative by construction: the section may be one entry of a list or
 * range, but the block and the township must each be unique in the text, so
 * a description spanning several blocks or townships is never stitched
 * together across clauses. Discovery and linkage only — never a conveyance.
 */
import type { CandidateTract } from "./chain-types";

const norm = (v: string) => v.toUpperCase().replace(/\s/g, "").replace(/^0+(?=\d)/, "");
const NUM = String.raw`\d+[A-Z]?`;
const ITEM = String.raw`${NUM}(?:\s*-\s*\d+)?`;
const LIST = String.raw`(${ITEM}(?:\s*(?:,|&|\bAND\b)\s*${ITEM})*)`;
const MAX_RANGE = 60;
const SECTION_RE = new RegExp(String.raw`\bSEC(?:TION)?S?\.?\s*:?\s*-?\s*${LIST}`, "g");
const BLOCK_RE = new RegExp(String.raw`\bBL(?:OC)?K\.?\s*:?\s*-?\s*${LIST}`, "g");
const TOWNSHIP_RE = /\bT(?:OWNSHIP)?\s*:?\s*-?\s*(\d+)\s*-?\s*([NS])\b/g;

function listed(text: string, re: RegExp): Set<string> {
  const out = new Set<string>();
  for (const m of text.toUpperCase().matchAll(re)) {
    for (const v of m[1].split(/\s*(?:,|&|\bAND\b)\s*/)) {
      const range = v.match(/^(\d+)\s*-\s*(\d+)$/);
      if (range) {
        const [lo, hi] = [Number(range[1]), Number(range[2])];
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

export function tractIdentity(t: Pick<CandidateTract, "sectionName" | "blockNumber">): { section: string; block: string; township: string } | null {
  const section = t.sectionName?.trim().match(/^(?:SEC(?:TION)?\.?\s*)?(\d+[A-Z]?)$/i)?.[1];
  const block = t.blockNumber?.trim().match(/^(?:BL(?:OC)?K\.?\s*)?(\d+[A-Z]?)(?:\s+(T\s*-?\s*\d+\s*-?\s*[NS]))?$/i);
  if (!section || !block?.[2]) return null;
  return { section: norm(section), block: norm(block[1]), township: norm(block[2].replace(/-/g, "")) };
}

export function legalDescriptionCoversTract(legal: string | null, t: Pick<CandidateTract, "sectionName" | "blockNumber">): boolean {
  if (!legal) return false;
  const i = tractIdentity(t);
  if (!i) return false;
  const blocks = listed(legal, BLOCK_RE);
  const towns = townships(legal);
  return listed(legal, SECTION_RE).has(i.section)
    && blocks.size === 1 && blocks.has(i.block)
    && towns.size === 1 && towns.has(i.township);
}
