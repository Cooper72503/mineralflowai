/**
 * Ownership step of API -> lease -> lease records -> ownership -> decision.
 *
 * Every owner of record on the RRC lease an API resolves to, from imported
 * appraisal-district mineral rolls (migration 038), grouped by appraisal
 * tract, with the decimal each owner is carried at and the exact source file.
 *
 * Two facts about the rolls shape this, both found in the Martin roll:
 *
 * 1. The roll's "RRC #" carries no district, and RRC lease numbers repeat
 *    across districts. Under RRC 60465 the Martin roll carries thirteen JO
 *    MILL UNIT tracts (a district 8A lease) and one ANGEL-FRAZIER 9G tract —
 *    the district 08 lease 60465. A tract is attached only when its lease
 *    name agrees with TRRC's lease name; the rest are reported as rejected.
 *
 * 2. One RRC lease can carry several appraisal tracts, each with its own
 *    division order summing to 1.0. SCHARBAUER RANCH H (47920) is five, one
 *    per well or well group. Decimals are therefore reconciled per tract, and
 *    lease production is shared across tracts in proportion to the appraisal
 *    district's own valuation of each tract — never counted once per tract.
 *
 * A unit crossing a county line is carried by each county it enters, so every
 * complete import is searched, not only the well's own county.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { selectAll } from "../title/select-all";

export type InterestType = "royalty" | "overriding_royalty" | "working_interest" | "unknown";
type Totals = Record<InterestType, number> & { all: number };

export interface RollOwner {
  ownerName: string;
  inCareOf: string | null;
  interestType: InterestType;
  interestTypeCode: string | null;
  decimal: number;
  acres: number | null;
  marketValue: number | null;
  rollLeaseName: string | null;
  operatorName: string | null;
  legalDescription: string | null;
  mineralAccountNumber: string | null;
  cadLeaseNumber: string | null;
  sourceRow: number;
}

export interface RollTract {
  cadLeaseNumber: string | null;
  leaseName: string | null;
  operatorName: string | null;
  legalDescription: string | null;
  owners: RollOwner[];
  totals: Totals;
  /** True when this tract's decimals do not sum to about 1 (0.95-1.05). */
  irregular: boolean;
  /** The appraisal district's market value of all interests in the tract. */
  marketValue: number;
  /** Share of lease production attributed to this tract (sums to 1 over attached tracts). */
  productionShare: number;
}

export interface RollSource { county: string; taxYear: number; fileName: string; sha256: string; interestTypeBasis: string | null }

export interface LeaseOwnership {
  status: "matched" | "no_match" | "no_roll" | "unavailable";
  rrcLeaseNumber: string | null;
  sources: RollSource[];
  tracts: RollTract[];
  /** Tracts carried under the same RRC number whose lease name does not match (another district's lease). */
  rejectedTracts: Array<{ cadLeaseNumber: string | null; leaseName: string | null; owners: number; reason: string }>;
  nameVerified: boolean;
  /** How production was shared across tracts, in words. */
  productionShareBasis: string | null;
  /** Every attached owner, largest decimal first. */
  owners: RollOwner[];
  reason: string | null;
}

const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
const GENERIC = new Set(["UNIT", "LEASE", "THE", "AND", "TRACT", "STATE", "EAST", "WEST", "NORTH", "SOUTH", "WELL", "WELLS", "VERT", "ALLOC", "CONSOLIDATED"]);
const distinctive = (s: string | null) => new Set((s ?? "").toUpperCase().replace(/[^A-Z ]/g, " ").split(/\s+/).filter(t => t.length >= 4 && !GENERIC.has(t)));
export function leaseNamesAgree(trrcName: string | null, rollName: string | null): boolean | null {
  const want = distinctive(trrcName), have = distinctive(rollName);
  if (!want.size || !have.size) return null;
  return [...want].some(t => have.has(t));
}
const zero = (): Totals => ({ royalty: 0, overriding_royalty: 0, working_interest: 0, unknown: 0, all: 0 });

function empty(status: LeaseOwnership["status"], rrcLeaseNumber: string | null, reason: string, sources: RollSource[] = [], rejectedTracts: LeaseOwnership["rejectedTracts"] = []): LeaseOwnership {
  return { status, rrcLeaseNumber, sources, tracts: [], rejectedTracts, nameVerified: false, productionShareBasis: null, owners: [], reason };
}

export async function loadLeaseOwnership(supabase: SupabaseClient, lease: { leaseNumber: string | null; leaseName: string | null }): Promise<LeaseOwnership> {
  const rrc = lease.leaseNumber?.replace(/\D/g, "").replace(/^0+(?=\d)/, "") || null;
  if (!rrc) return empty("unavailable", null, "The API did not resolve to an RRC lease number, so the mineral roll cannot be matched.");

  const { data: imports, error: importError } = await supabase.from("mineral_roll_imports")
    .select("id, county, tax_year, source_file_name, source_sha256, interest_type_basis").eq("status", "complete");
  if (importError) return empty("unavailable", rrc, `Mineral roll imports could not be read: ${importError.message}`);
  if (!imports?.length) return empty("no_roll", rrc, "No appraisal-district mineral roll has been imported.");

  const { data: rows, error } = await selectAll<Record<string, unknown>>((a, b) => supabase.from("mineral_roll_interests")
    .select("import_id, cad_lease_number, owner_name, in_care_of, interest_type, interest_type_code, decimal_interest, acres, market_value, lease_name, operator_name, legal_description, mineral_account_number, source_row")
    .eq("rrc_lease_number", rrc).in("import_id", imports.map(i => i.id)).order("id").range(a, b));
  if (error) return empty("unavailable", rrc, `Mineral roll rows could not be read: ${error.message}`);

  const allSources: RollSource[] = imports.map(i => ({ county: String(i.county), taxYear: Number(i.tax_year), fileName: String(i.source_file_name), sha256: String(i.source_sha256), interestTypeBasis: (i.interest_type_basis as string | null) ?? null }));
  const rollNames = allSources.map(s => `${s.county} ${s.taxYear}`).join(", ");
  if (!rows.length) return empty("no_match", rrc, `No owner on the imported roll(s) (${rollNames}) carries RRC lease ${rrc}.`, allSources);

  // Group by import and appraisal tract.
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const r of rows) { const k = `${r.import_id}|${r.cad_lease_number ?? ""}`; groups.set(k, [...(groups.get(k) ?? []), r]); }

  const tracts: RollTract[] = [];
  const rejectedTracts: LeaseOwnership["rejectedTracts"] = [];
  let unverifiable = false;
  const usedImports = new Set<string>();
  for (const [key, members] of groups) {
    const leaseName = (members.find(m => m.lease_name)?.lease_name as string | null) ?? null;
    const agrees = leaseNamesAgree(lease.leaseName, leaseName);
    const cad = (members[0].cad_lease_number as string | null) ?? null;
    if (agrees === false) {
      rejectedTracts.push({ cadLeaseNumber: cad, leaseName, owners: members.length,
        reason: `Roll lease name "${leaseName}" does not match the TRRC lease name "${lease.leaseName}"; the same RRC number belongs to another district's lease.` });
      continue;
    }
    if (agrees === null) unverifiable = true;
    usedImports.add(key.split("|")[0]);
    const owners: RollOwner[] = members.map(r => ({
      ownerName: String(r.owner_name), inCareOf: (r.in_care_of as string | null) ?? null,
      interestType: ((r.interest_type as InterestType) ?? "unknown"), interestTypeCode: (r.interest_type_code as string | null) ?? null,
      decimal: num(r.decimal_interest) ?? 0, acres: num(r.acres), marketValue: num(r.market_value),
      rollLeaseName: (r.lease_name as string | null) ?? null, operatorName: (r.operator_name as string | null) ?? null,
      legalDescription: (r.legal_description as string | null) ?? null, mineralAccountNumber: (r.mineral_account_number as string | null) ?? null,
      cadLeaseNumber: cad, sourceRow: Number(r.source_row),
    })).sort((a, b) => b.decimal - a.decimal);
    const totals = zero();
    for (const o of owners) { totals[o.interestType] += o.decimal; totals.all += o.decimal; }
    tracts.push({ cadLeaseNumber: cad, leaseName, operatorName: owners.find(o => o.operatorName)?.operatorName ?? null,
      legalDescription: owners.find(o => o.legalDescription)?.legalDescription ?? null, owners, totals,
      irregular: totals.all < 0.95 || totals.all > 1.05, marketValue: owners.reduce((s, o) => s + (o.marketValue ?? 0), 0), productionShare: 0 });
  }

  const sources = allSources.filter((_, i) => usedImports.has(String(imports[i].id)));
  if (!tracts.length) return empty("no_match", rrc, `RRC lease ${rrc} appears on the roll only under other leases' names; no tract matches the TRRC lease name "${lease.leaseName}".`, allSources, rejectedTracts);

  // Share lease production across tracts by the appraisal district's own
  // valuation of each; equal shares only when the roll carries no values.
  const totalValue = tracts.reduce((s, t) => s + t.marketValue, 0);
  let productionShareBasis: string | null = null;
  if (tracts.length === 1) tracts[0].productionShare = 1;
  else if (totalValue > 0) {
    for (const t of tracts) t.productionShare = t.marketValue / totalValue;
    productionShareBasis = `Lease production is shared across the ${tracts.length} appraisal tracts in proportion to the appraisal district's market value of each tract.`;
  } else {
    for (const t of tracts) t.productionShare = 1 / tracts.length;
    productionShareBasis = `The roll carries no tract values, so lease production is shared equally across the ${tracts.length} appraisal tracts.`;
  }
  tracts.sort((a, b) => b.productionShare - a.productionShare);
  const owners = tracts.flatMap(t => t.owners).sort((a, b) => b.decimal - a.decimal);
  return { status: "matched", rrcLeaseNumber: rrc, sources, tracts, rejectedTracts, nameVerified: !unverifiable, productionShareBasis, owners, reason: null };
}
