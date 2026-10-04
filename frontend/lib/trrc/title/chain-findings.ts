import { recordingIdentity, texasCounty } from "./recording-identity";
/**
 * Cross-cutting findings and status aggregation for the title-chain
 * analysis. The ownership graph (ownership-graph.ts) reports what it can
 * see inside a branch; this module adds the checks that need the whole
 * job: identity candidates, referenced-but-missing instruments,
 * index-only evidence, provider / OCR limitations — and applies the
 * documented status aggregation rule (chain-types.ts).
 *
 * Deterministic. Every finding carries type, severity, affected tract /
 * interest, citations, explanation, and a next research action.
 */

import type {
  ChainFinding, ChainFindingType, ChainInterestType, Citation, FindingSeverity, TitleAssessmentClassification, CandidateTract,
} from "./chain-types";
import { CONFLICT_FINDING_TYPES, GAP_FINDING_TYPES } from "./chain-types";
import type { GraphInstrument, GraphParty, GraphClaim } from "./ownership-graph";
import { normalizeOwnerName } from "./asset-matching";

let seq = 0;
function finding(type: ChainFindingType, severity: FindingSeverity, title: string, explanation: string, nextAction: string, extra: Partial<ChainFinding> = {}): ChainFinding {
  seq++;
  return {
    findingId: `f-${type.toLowerCase()}-x${seq}`,
    type, severity, title, explanation, nextAction,
    affectedTractId: null, affectedTractLabel: null, affectedInterestType: null, instrumentIds: [], citations: [],
    ...extra,
  };
}

export interface CrossCuttingInput {
  tracts: CandidateTract[];
  instruments: GraphInstrument[];
  parties: GraphParty[];
  claims: GraphClaim[];
  limitations: string[];
  providerUnavailableCounties: string[];
  ocrFailedDocumentIds: string[];
}

/** Similar-but-not-identical names are review candidates, never automatic matches. */
export function findIdentityCandidates(parties: GraphParty[]): Array<{ a: GraphParty; b: GraphParty; reason: string }> {
  const out: Array<{ a: GraphParty; b: GraphParty; reason: string }> = [];
  const seen = new Set<string>();
  const distinct = new Map<string, GraphParty>();
  for (const p of parties) {
    const key = normalizeOwnerName(p.name);
    if (!distinct.has(key)) distinct.set(key, p);
  }
  const list = Array.from(distinct.values());
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      const ka = normalizeOwnerName(a.name), kb = normalizeOwnerName(b.name);
      if (ka === kb) continue;
      const pairKey = [ka, kb].sort().join("||");
      if (seen.has(pairKey)) continue;
      const entityA = isEntityName(a.name), entityB = isEntityName(b.name);
      // A company is never "the same person" as an individual, and person-name
      // rules (first name, initials) mean nothing for a company.
      const reason = entityA || entityB ? (entityA && entityB ? entitySimilarityReason(a.name, b.name) : null) : similarityReason(ka, kb);
      if (reason) { seen.add(pairKey); out.push({ a, b, reason }); }
    }
  }
  return out;
}

const ENTITY = /\b(LLC|L L C|INC|INCORPORATED|CO|COMPANY|CORP|CORPORATION|LP|L P|LTD|LIMITED|BANK|TRUST CO|PIPE ?LINE|PIPELINE|ENERGY|OIL|GAS|PETROLEUM|PARTNERS|PARTNERSHIP|SERVICES?|UNIT|SURVEY|RAILROAD|RR|RY|STATE|TEXAS|COUNTY|CITY|UNITED STATES|USA|U S A|U S|ASSOCIATION|CHURCH|FOUNDATION|RANCH|RANCHES|FARMS|HOLDINGS|RESOURCES|OPERATING|PRODUCTION|EXPLORATION|MIDSTREAM|ROYALTIES|MINERALS|FUND|AUTHORITY|DISTRICT|DEPARTMENT)\b/;
export function isEntityName(name: string): boolean {
  return ENTITY.test(name.toUpperCase().replace(/[.,]/g, " ").replace(/\s+/g, " "));
}

/** Edit distance, stopping early once it exceeds `max`. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Two company names that are the same name as indexed, spelled differently:
 * spacing ("GRANDPRIX" / "GRAND PRIX") or one letter ("WESTS" / "WEST",
 * "U S A" / "U S"). Different words are different companies.
 */
export function entitySimilarityReason(a: string, b: string): string | null {
  const compact = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const ca = compact(a), cb = compact(b);
  if (!ca || !cb || ca === cb && a.toUpperCase().replace(/\s+/g, " ").trim() === b.toUpperCase().replace(/\s+/g, " ").trim()) return null;
  if (ca === cb) return "Company names differ only in spacing or punctuation";
  // A different number or one-letter designator names a different entity:
  // NOBLES 2H UNIT and NOBLES 4H UNIT, BRADFORD TRUST A UNIT 2 and B UNIT 2.
  let i = 0; while (i < ca.length && i < cb.length && ca[i] === cb[i]) i++;
  let j = 0; while (j < ca.length - i && j < cb.length - i && ca[ca.length - 1 - j] === cb[cb.length - 1 - j]) j++;
  if (/\d/.test(ca.slice(i, ca.length - j) + cb.slice(i, cb.length - j))) return null;
  const tokens = (s: string) => s.toUpperCase().replace(/[^A-Z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  const ta = tokens(a), tb = tokens(b);
  if (ta.length === tb.length) {
    const diff = ta.map((t, k) => [t, tb[k]]).filter(([x, y]) => x !== y);
    if (diff.length === 1 && diff[0][0].length === 1 && diff[0][1].length === 1) return null;
  }
  if (Math.min(ca.length, cb.length) >= 8 && editDistance(ca, cb, 1) === 1) return "Company names differ by one letter, as a clerk's index often does";
  return null;
}

function similarityReason(a: string, b: string): string | null {
  const SUFFIX = /^(jr|sr|ii|iii|iv)$/;
  const strip = (s: string) => { const t = s.split(" ").filter(Boolean); const hasSuffix = t.length > 1 && SUFFIX.test(t[t.length - 1]); return { tokens: hasSuffix ? t.slice(0, -1) : t, hasSuffix }; };
  const A = strip(a), B = strip(b);
  const ta = A.tokens, tb = B.tokens;
  if (ta.length === 0 || tb.length === 0) return null;
  // Initials alone ("V R") do not identify a person.
  if (!ta.some(t => t.length >= 3) || !tb.some(t => t.length >= 3)) return null;
  const lastA = ta[ta.length - 1], lastB = tb[tb.length - 1];
  const firstA = ta[0], firstB = tb[0];
  if (lastA !== lastB) return null;
  if (firstA === firstB && A.hasSuffix !== B.hasSuffix) return "Same name with and without a generational suffix — likely different people";
  if (firstA === firstB && ta.length !== tb.length) return "Same first and last name with differing middle name/initial";
  if (firstA !== firstB && firstA[0] === firstB[0] && (firstA.length === 1 || firstB.length === 1)) return "Same surname; one record uses only a first initial";
  if (firstA !== firstB && (firstA.startsWith(firstB) || firstB.startsWith(firstA))) return "Same surname with a shortened or variant first name";
  return null;
}

export function buildCrossCuttingFindings(input: CrossCuttingInput): ChainFinding[] {
  seq = 0;
  const findings: ChainFinding[] = [];
  const tractsById = new Map(input.tracts.map(t => [t.id, t]));
  const claimsByInstrument = new Map<string, GraphClaim[]>();
  for (const c of input.claims) {
    const l = claimsByInstrument.get(c.instrumentId);
    if (l) l.push(c); else claimsByInstrument.set(c.instrumentId, [c]);
  }
  const tractFor = (instrumentId: string): CandidateTract | null => {
    const c = claimsByInstrument.get(instrumentId)?.find(x => x.canonicalTractId);
    return c?.canonicalTractId ? tractsById.get(c.canonicalTractId) ?? null : null;
  };
  const interestFor = (instrumentId: string): ChainInterestType | null => claimsByInstrument.get(instrumentId)?.[0]?.interestType ?? null;

  // Identity candidates.
  for (const cand of findIdentityCandidates(input.parties)) {
    const instA = input.instruments.find(i => i.id === cand.a.instrumentId);
    const instB = input.instruments.find(i => i.id === cand.b.instrumentId);
    findings.push(finding("IDENTITY_MISMATCH", "medium", "Similar party names not treated as the same person",
      `"${cand.a.name}" and "${cand.b.name}" appear in different instruments. ${cand.reason}. They are carried as separate parties; a chain that depends on them being one person will show as unsupported until confirmed.`,
      "Confirm from the instruments (address, spouse, capacity, acknowledgment) whether these are the same party, then merge or keep separate in the review queue.",
      { affectedTractId: tractFor(cand.a.instrumentId)?.id ?? null, affectedTractLabel: tractFor(cand.a.instrumentId)?.tractLabel ?? null, instrumentIds: [cand.a.instrumentId, cand.b.instrumentId],
        citations: [instA, instB].filter((x): x is GraphInstrument => !!x).map(i => ({ documentId: i.documentId, instrumentId: i.id, page: i.sourcePage, excerpt: null, sourceUrl: i.sourceUrl, label: i.instrumentNumber ?? i.bookVolumePage })) }));
  }

  // Referenced instruments not in the reviewed set.
  const knownRefs = new Set<string>();
  for (const i of input.instruments) {
    // An index hit is a retrieval lead, not a reviewed predecessor instrument.
    const key = recordingIdentity(i.county, i.instrumentNumber, i.bookVolumePage);
    if (i.contentVerified && key) knownRefs.add(key);
    const bookKey = recordingIdentity(i.county, null, i.bookVolumePage);
    if (i.contentVerified && bookKey) knownRefs.add(bookKey);
  }
  const reported = new Set<string>();
  for (const i of input.instruments) {
    for (const r of i.references) {
      if (r.relation !== "predecessor" && r.relation !== "prior_lease" && r.relation !== "corrected_instrument") continue;
      if (!r.instrumentNumber && !r.bookVolumePage) continue;
      // Never assume an unqualified reference belongs to the source deed's county.
      const key = recordingIdentity(r.county, r.instrumentNumber, r.bookVolumePage);
      const reportKey = key ?? `unresolved:${i.id}:${r.instrumentNumber ?? r.bookVolumePage}`;
      if ((key && knownRefs.has(key)) || reported.has(reportKey)) continue;
      reported.add(reportKey);
      const tract = tractFor(i.id);
      findings.push(finding("MISSING_REFERENCED_INSTRUMENT", "medium", "Referenced instrument not in reviewed records",
        `${i.instrumentType.replace(/_/g, " ")} ${i.instrumentNumber ?? i.bookVolumePage ?? i.id} refers to ${r.instrumentNumber ? `Instrument No. ${r.instrumentNumber}` : r.bookVolumePage} (${r.relation.replace(/_/g, " ")}), which was not among the documents reviewed.`,
        `Retrieve and read ${r.instrumentNumber ? `Instrument No. ${r.instrumentNumber}` : r.bookVolumePage}${texasCounty(r.county) ? ` from ${texasCounty(r.county)} County records` : "; verify the recording county from the cited source first"}, then add it to this job.`,
        { affectedTractId: tract?.id ?? null, affectedTractLabel: tract?.tractLabel ?? null, affectedInterestType: interestFor(i.id), instrumentIds: [i.id],
          citations: [{ documentId: i.documentId, instrumentId: i.id, page: r.page, excerpt: r.description, sourceUrl: i.sourceUrl, label: r.instrumentNumber ?? r.bookVolumePage }] }));
    }
  }

  // Index-only evidence attached to a confirmed tract.
  const indexOnly = input.instruments.filter(i => !i.contentVerified && (claimsByInstrument.get(i.id) ?? []).some(c => c.canonicalTractId));
  if (indexOnly.length > 0) {
    findings.push(finding("INDEX_ONLY_EVIDENCE", "medium", `${indexOnly.length} instrument(s) known from a county index only`,
      "These instruments appear in a county-clerk index but their text was not reviewed. An index entry proves a record exists; it does not establish parties' capacities, fractions, reservations, or exceptions. They are shown in the chronology but not interpreted.",
      "Retrieve the recorded images (or upload them) so the conveyance language can be reviewed.",
      { instrumentIds: indexOnly.map(i => i.id), citations: indexOnly.slice(0, 10).map(i => ({ documentId: i.documentId, instrumentId: i.id, page: null, excerpt: null, sourceUrl: i.sourceUrl, label: i.instrumentNumber ?? i.bookVolumePage })) }));
  }

  for (const county of input.providerUnavailableCounties) {
    findings.push(finding("PROVIDER_UNAVAILABLE", "info", `No automated county-record access for ${county} County`,
      `${county} County records were not searched automatically because no supported provider covers that county. Coverage for this tract is limited to TRRC documents and anything uploaded.`,
      "Search the county clerk's records manually (or through a paid aggregator) and upload the instruments to this job."));
  }
  for (const docId of input.ocrFailedDocumentIds) {
    findings.push(finding("OCR_FAILED", "info", "A document could not be read",
      "Text could not be extracted from this document (no text layer and OCR failed). Its contents are not reflected in the chain.",
      "Re-upload a clearer scan or paste the instrument text.", { citations: [{ documentId: docId, instrumentId: null, page: null, excerpt: null, sourceUrl: null, label: null }] }));
  }

  return findings;
}

/** Documented aggregation rule — see STATUS_AGGREGATION_RULE. All findings are kept; only the headline status is chosen here. */
export function aggregateStatus(args: {
  findings: ChainFinding[];
  confirmedTractCount: number;
  verifiedInstrumentsOnConfirmedTracts: number;
}): TitleAssessmentClassification {
  if (args.confirmedTractCount === 0 || args.verifiedInstrumentsOnConfirmedTracts === 0) return "INSUFFICIENT_DATA";
  const severe = (f: ChainFinding) => f.severity === "critical" || f.severity === "high";
  if (args.findings.some(f => CONFLICT_FINDING_TYPES.includes(f.type) && (f.type !== "FRACTION_INCONSISTENCY" || severe(f)))) return "POTENTIAL_CONFLICTS_DETECTED";
  if (args.findings.some(f => GAP_FINDING_TYPES.includes(f.type) || (f.type === "FRACTION_INCONSISTENCY"))) return "POTENTIAL_GAPS_DETECTED";
  return "NO_SURFACE_DISCONTINUITIES_DETECTED";
}

const SEVERITY_RANK: Record<FindingSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
export function sortFindings(findings: ChainFinding[]): ChainFinding[] {
  return [...findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.type.localeCompare(b.type));
}

export function citationsFor(inst: GraphInstrument): Citation[] {
  return [{ documentId: inst.documentId, instrumentId: inst.id, page: inst.sourcePage, excerpt: null, sourceUrl: inst.sourceUrl, label: inst.instrumentNumber ?? inst.bookVolumePage }];
}
