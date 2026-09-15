import { parseApiInput } from "./api-input";

export interface OfferedWell {
  originalApi: string; wellNumber: string; leaseNumber: string; district: string;
  page: number;
}
export interface LeaseInventoryEvidence {
  leaseNumber: string; district: string; sourceUrl: string; retrievedAt: string;
  sha256: string; complete: boolean;
  rows: Array<{ api_no: string; well_no: string; lease_no: string; district: string; on_schedule: string }>;
}
const lease = (s: string) => /^\d+$/.test(s.trim()) ? s.trim().replace(/^0+(?=\d)/, "") : null;
const district = (s: string) => s.trim().toUpperCase().replace(/^0+(?=\d)/, "");
const well = (s: string) => s.trim().toUpperCase().replace(/\s+/g, "");

/** Resolve offered identifiers against cited current lease rows, never by
 * deleting/inserting API digits. Proposals require review, not silent repair. */
export function reconcileAssetInventory(offered: OfferedWell[], source: LeaseInventoryEvidence) {
  const evidenceUsable = source.complete && /^https:\/\//.test(source.sourceUrl) &&
    /^[a-f0-9]{64}$/i.test(source.sha256) && Number.isFinite(Date.parse(source.retrievedAt));
  return offered.map(input => {
    const parsed = parseApiInput(input.originalApi);
    const base = { input, inputValidationError: parsed.error, canonicalInputApi: parsed.api10,
      source: { url: source.sourceUrl, retrievedAt: source.retrievedAt, sha256: source.sha256 },
      candidates: [] as string[] };
    if (!evidenceUsable || !lease(input.leaseNumber) || lease(input.leaseNumber) !== lease(source.leaseNumber) || district(input.district) !== district(source.district)) {
      return { ...base, status: "unavailable" as const, reason: "Complete cited inventory for the requested lease/district is required." };
    }
    const matches = source.rows.filter(r => lease(r.lease_no) === lease(input.leaseNumber) && district(r.district) === district(input.district) && well(r.well_no) === well(input.wellNumber) && r.on_schedule.trim().toUpperCase() === "Y");
    const identities = matches.map(r => parseApiInput(r.api_no));
    if (identities.some(p => !p.ok)) return { ...base, status: "unavailable" as const, reason: "Matching regulator rows contain invalid API identifiers." };
    const candidates = Array.from(new Set(identities.map(p => p.api10!)));
    if (candidates.length !== 1) return { ...base, candidates, status: candidates.length > 1 ? "ambiguous" as const : "unmatched" as const, reason: "No unique current well-number match within the requested lease/district." };
    if (parsed.ok && parsed.api10 === candidates[0]) return { ...base, candidates, status: "matched" as const, reason: "Base API and well number agree with the current lease inventory; suffix identity is not established." };
    return { ...base, candidates, status: "correction_proposed" as const, reason: "Unique current lease/well-number match; review before replacing the supplied API. No ownership or production allocation is established." };
  });
}
