/**
 * Ownership step of API -> lease -> lease records -> ownership -> decision.
 *
 * Every owner of record on the RRC lease an API resolves to, from imported
 * appraisal-district mineral rolls (migration 038), with the decimal each
 * owner is carried at and the exact source file. Matched on the RRC lease
 * number; the roll's lease name is compared with TRRC's as a cross-check and
 * the result is reported, never used to drop rows. A unit that crosses a
 * county line is carried by each county it enters, so every complete import
 * is searched, not only the well's own county.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { selectAll } from "../title/select-all";

export type InterestType = "royalty" | "overriding_royalty" | "working_interest" | "unknown";

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
  sourceRow: number;
}

export interface RollSource {
  county: string;
  taxYear: number;
  fileName: string;
  sha256: string;
  interestTypeBasis: string | null;
}

export interface LeaseOwnership {
  status: "matched" | "no_match" | "no_roll" | "unavailable";
  rrcLeaseNumber: string | null;
  sources: RollSource[];
  /** Roll lease names found under this RRC number, and whether they agree with TRRC's. */
  rollLeaseNames: string[];
  nameAgreement: "agrees" | "differs" | "unknown";
  owners: RollOwner[];
  totals: Record<InterestType, number> & { all: number };
  /** True when the decimals on the lease do not sum to about 1 (0.95-1.05). */
  totalsIrregular: boolean;
  reason: string | null;
}

const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
const tokens = (s: string) => new Set(s.toUpperCase().replace(/[^A-Z0-9 ]/g, " ").split(/\s+/).filter(t => t.length >= 3 && !/^(UNIT|LEASE|THE|AND)$/.test(t)));

function agreement(trrcName: string | null, rollNames: string[]): LeaseOwnership["nameAgreement"] {
  if (!trrcName || !rollNames.length) return "unknown";
  const want = tokens(trrcName);
  if (!want.size) return "unknown";
  return rollNames.some(n => { const have = tokens(n); return [...want].some(t => have.has(t)); }) ? "agrees" : "differs";
}

function empty(status: LeaseOwnership["status"], rrcLeaseNumber: string | null, reason: string, sources: RollSource[] = []): LeaseOwnership {
  return { status, rrcLeaseNumber, sources, rollLeaseNames: [], nameAgreement: "unknown", owners: [],
    totals: { royalty: 0, overriding_royalty: 0, working_interest: 0, unknown: 0, all: 0 }, totalsIrregular: false, reason };
}

export async function loadLeaseOwnership(supabase: SupabaseClient, lease: { leaseNumber: string | null; leaseName: string | null }): Promise<LeaseOwnership> {
  const rrc = lease.leaseNumber?.replace(/\D/g, "").replace(/^0+(?=\d)/, "") || null;
  if (!rrc) return empty("unavailable", null, "The API did not resolve to an RRC lease number, so the mineral roll cannot be matched.");

  const { data: imports, error: importError } = await supabase.from("mineral_roll_imports")
    .select("id, county, tax_year, source_file_name, source_sha256, interest_type_basis").eq("status", "complete");
  if (importError) return empty("unavailable", rrc, `Mineral roll imports could not be read: ${importError.message}`);
  if (!imports?.length) return empty("no_roll", rrc, "No appraisal-district mineral roll has been imported.");

  const { data: rows, error } = await selectAll<Record<string, unknown>>((a, b) => supabase.from("mineral_roll_interests")
    .select("import_id, owner_name, in_care_of, interest_type, interest_type_code, decimal_interest, acres, market_value, lease_name, operator_name, legal_description, mineral_account_number, source_row")
    .eq("rrc_lease_number", rrc).in("import_id", imports.map(i => i.id)).order("id").range(a, b));
  if (error) return empty("unavailable", rrc, `Mineral roll rows could not be read: ${error.message}`);

  const allSources: RollSource[] = imports.map(i => ({ county: String(i.county), taxYear: Number(i.tax_year), fileName: String(i.source_file_name), sha256: String(i.source_sha256), interestTypeBasis: (i.interest_type_basis as string | null) ?? null }));
  if (!rows.length) return empty("no_match", rrc, `No owner on the imported roll(s) (${allSources.map(s => `${s.county} ${s.taxYear}`).join(", ")}) carries RRC lease ${rrc}.`, allSources);

  const used = new Set(rows.map(r => String(r.import_id)));
  const sources = imports.filter(i => used.has(String(i.id))).map(i => allSources[imports.indexOf(i)]);
  const owners: RollOwner[] = rows.map(r => ({
    ownerName: String(r.owner_name), inCareOf: (r.in_care_of as string | null) ?? null,
    interestType: ((r.interest_type as InterestType) ?? "unknown"), interestTypeCode: (r.interest_type_code as string | null) ?? null,
    decimal: num(r.decimal_interest) ?? 0, acres: num(r.acres), marketValue: num(r.market_value),
    rollLeaseName: (r.lease_name as string | null) ?? null, operatorName: (r.operator_name as string | null) ?? null,
    legalDescription: (r.legal_description as string | null) ?? null, mineralAccountNumber: (r.mineral_account_number as string | null) ?? null,
    sourceRow: Number(r.source_row),
  })).sort((a, b) => b.decimal - a.decimal);

  const totals = { royalty: 0, overriding_royalty: 0, working_interest: 0, unknown: 0, all: 0 };
  for (const o of owners) { totals[o.interestType] += o.decimal; totals.all += o.decimal; }
  const rollLeaseNames = [...new Set(owners.map(o => o.rollLeaseName).filter((n): n is string => !!n))];
  return { status: "matched", rrcLeaseNumber: rrc, sources, rollLeaseNames, nameAgreement: agreement(lease.leaseName, rollLeaseNames),
    owners, totals, totalsIrregular: totals.all < 0.95 || totals.all > 1.05, reason: null };
}
