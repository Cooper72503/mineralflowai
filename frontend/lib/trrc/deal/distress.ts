/**
 * Whether a lease is still an asset: has it stopped producing, is the
 * operator still filing, and how many of its wells TRRC carries as inactive
 * and unplugged.
 *
 * Both come from records the package already retrieved (lease production,
 * the inactive-well report, RRC OIL compliance), so a stopped lease is a
 * finding from reported evidence, not an inference from an unavailable
 * forecast. Live case (ODC /San Andres/ Unit, Gaines, 8A-60509, 2026-10-15):
 * no production after 2025-05, 27 of 47 wells inactive since 06/2023 with
 * every extension denied, and Notices of Violation for inactive unplugged
 * wells, and no production report filed after 2026-01; the record
 * nonetheless said only "economics unavailable". The seller holds run
 * statements, so the zeros and the missing filings are the question to
 * answer, not a reason to price the lease at nothing.
 */
import type { TrrcDDProductionRow } from "../types";
import type { EconomicsAssumptions } from "../economics-provider";
import type { DealWell } from "./build";
import { MAX_UNREPORTED_COMPLETED_MONTHS } from "./readiness";

/** Consecutive reported months of zero production, ending at the last reported month, that mean the lease has stopped. */
export const STOPPED_PRODUCING_MONTHS = 6;

export interface LeaseDistress {
  lastProducingMonth: string | null;
  lastReportedMonth: string | null;
  /** Consecutive reported zero months ending at the last reported month. */
  zeroMonthsAtEnd: number;
  /** Six or more reported zero months at the end of the reported history. */
  stopped: boolean;
  /** Completed months after the last reported month with no production report filed. */
  unreportedMonths: number;
  /**
   * Stopped, and the operator is still filing: TRRC's current record is zero.
   * When filings have also stopped, production may have resumed unreported,
   * so the record cannot settle it without the seller's run statements.
   */
  stoppedOnCurrentFilings: boolean;
  /** Oil and gas reported in the 36 reported months before the zero run. */
  priorOilBbl: number;
  priorGasMcf: number;
  priorMonths: number;
  inactive: { wells: number; denied: number; earliestShutIn: string | null; latestShutIn: string | null };
  /** Submitted wells TRRC has cited for an inactive unplugged well (SWR 3.14(b)(2)). */
  inactiveViolationWells: number;
  violationWells: number;
}

const volume = (r: TrrcDDProductionRow) => (r.oil_bbl ?? 0) + (r.gas_mcf ?? 0) + (r.casinghead_gas_mcf ?? 0) + (r.condensate_bbl ?? 0);
const reported = (r: TrrcDDProductionRow) => [r.oil_bbl, r.gas_mcf, r.casinghead_gas_mcf, r.condensate_bbl].some(v => typeof v === "number");
/** "06/2023" -> "2023-06", for ordering. */
const ym = (mmYyyy: string | null) => { const m = /^(\d{1,2})\/(\d{4})$/.exec(mmYyyy ?? ""); return m ? `${m[2]}-${m[1].padStart(2, "0")}` : null; };

export function assessDistress(production: TrrcDDProductionRow[], wells: DealWell[], unreportedMonths = 0): LeaseDistress {
  const months = [...production].filter(reported).sort((a, b) => a.production_month.localeCompare(b.production_month));
  let zero = 0;
  for (let i = months.length - 1; i >= 0 && volume(months[i]) === 0; i--) zero++;
  const producing = months.filter(r => volume(r) > 0);
  const prior = months.slice(Math.max(0, months.length - zero - 36), months.length - zero);
  const submitted = wells.filter(w => w.inPackage);
  const inactive = submitted.filter(w => w.inactive);
  const shutIns = inactive.map(w => ym(w.inactive!.shutIn)).filter((x): x is string => !!x).sort();
  const cited = (w: DealWell, inactiveOnly: boolean) => (w.violations ?? []).some(v => !inactiveOnly || /3\.14\(b\)\(2\)|inactive unplugged/i.test(`${v.rule} ${v.description}`));
  return {
    lastProducingMonth: producing.length ? producing[producing.length - 1].production_month.slice(0, 7) : null,
    lastReportedMonth: months.length ? months[months.length - 1].production_month.slice(0, 7) : null,
    zeroMonthsAtEnd: zero,
    stopped: zero >= STOPPED_PRODUCING_MONTHS,
    unreportedMonths,
    stoppedOnCurrentFilings: zero >= STOPPED_PRODUCING_MONTHS && unreportedMonths <= MAX_UNREPORTED_COMPLETED_MONTHS,
    priorOilBbl: prior.reduce((t, r) => t + (r.oil_bbl ?? 0) + (r.condensate_bbl ?? 0), 0),
    priorGasMcf: prior.reduce((t, r) => t + (r.gas_mcf ?? 0) + (r.casinghead_gas_mcf ?? 0), 0),
    priorMonths: prior.length,
    inactive: {
      wells: inactive.length,
      denied: inactive.filter(w => /denied/i.test(w.inactive!.extension ?? "")).length,
      earliestShutIn: shutIns[0] ?? null, latestShutIn: shutIns[shutIns.length - 1] ?? null,
    },
    inactiveViolationWells: submitted.filter(w => cited(w, true)).length,
    violationWells: submitted.filter(w => cited(w, false)).length,
  };
}

export interface PluggingExposure {
  /** Inactive wells TRRC requires to be plugged or restored to production. */
  wells: number;
  costPerWellUsd: number;
  grossUsd: number;
  /** The evaluated interest's share: its working interest of the gross; a royalty bears none. */
  toInterestUsd: number;
}

export function pluggingExposure(d: LeaseDistress, a: EconomicsAssumptions): PluggingExposure {
  const grossUsd = d.inactive.wells * a.pluggingCostUsdPerWell;
  return { wells: d.inactive.wells, costPerWellUsd: a.pluggingCostUsdPerWell, grossUsd, toInterestUsd: a.interestType === "working" ? grossUsd * a.workingInterest : 0 };
}

const reportedRow = (r: TrrcDDProductionRow) => [r.oil_bbl, r.gas_mcf, r.casinghead_gas_mcf, r.condensate_bbl].some(v => typeof v === "number");

/**
 * Why a lease with recent production still cannot be fitted: the reported
 * months since its last reporting gap are too few. Null when there is no
 * interior gap or the window since it is long enough.
 */
export function reportingGapReason(production: TrrcDDProductionRow[], minMonths = 6): string | null {
  const rows = [...production].sort((a, b) => a.production_month.localeCompare(b.production_month));
  let end = rows.length - 1;
  while (end >= 0 && !reportedRow(rows[end])) end--;
  if (end < 0) return null;
  let start = end;
  while (start > 0 && reportedRow(rows[start - 1])) start--;
  let gapStart = start - 1;
  while (gapStart > 0 && !reportedRow(rows[gapStart - 1])) gapStart--;
  const window = end - start + 1;
  if (start === 0 || window >= minMonths) return null;
  const m = (r: TrrcDDProductionRow) => r.production_month.slice(0, 7);
  const gap = gapStart === start - 1 ? monthLabel(m(rows[gapStart])) : `${monthLabel(m(rows[gapStart]))}–${monthLabel(m(rows[start - 1]))}`;
  return `${gap} ${gapStart === start - 1 ? "has" : "have"} no production report from TRRC or the run statements, and the ${window} reported month${window === 1 ? "" : "s"} since (${monthLabel(m(rows[start]))}–${monthLabel(m(rows[end]))}) ${window === 1 ? "is" : "are"} fewer than the ${minMonths} needed to fit a decline. A month with no report is not treated as zero. Statements for the missing months, or ${minMonths - window} more month${minMonths - window === 1 ? "" : "s"} of statements, would let the lease be valued.`;
}

const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const monthLabel = (ymStr: string | null) => { const m = /^(\d{4})-(\d{2})/.exec(ymStr ?? ""); return m ? `${MONTH[Number(m[2]) - 1]} ${m[1]}` : "an unknown month"; };
const shutInLabel = (x: string | null) => monthLabel(x);
const usd = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;
const n = (v: number) => Math.round(v).toLocaleString("en-US");

/** One sentence on the production record, stated as a finding. */
export function stoppedSentence(d: LeaseDistress): string {
  const since = d.lastProducingMonth ? `since ${monthLabel(d.lastProducingMonth)}` : "in any reported month of the retrieved history";
  const filings = d.unreportedMonths > MAX_UNREPORTED_COMPLETED_MONTHS ? ` No production report has been filed for the ${d.unreportedMonths} completed months since.` : "";
  return `TRRC's record shows no oil or gas ${since}: the operator reported zero for the last ${d.zeroMonthsAtEnd} reported months, through ${monthLabel(d.lastReportedMonth)}${d.lastProducingMonth && d.priorMonths ? `, after ${n(d.priorOilBbl)} bbl of oil and ${n(d.priorGasMcf)} mcf of gas in the ${d.priorMonths} reported months before that` : ""}.${filings}`;
}

/**
 * REVIEW reasons when TRRC shows the lease stopped but the operator has also
 * stopped filing: the public record cannot say whether production resumed.
 */
export function distressReviewReasons(d: LeaseDistress, submittedWells: number, a: EconomicsAssumptions): string[] {
  if (!d.stopped || d.stoppedOnCurrentFilings) return [];
  return [
    stoppedSentence(d),
    "Value cannot be established from the public record: the seller's purchaser run statements for every month since the last reported production are required, and any volumes they show must be reconciled to TRRC, where they were reported as zero or not reported.",
    ...[inactiveSentence(d, submittedWells), exposureSentence(pluggingExposure(d, a), a)].filter((s): s is string => !!s),
  ];
}

/** One sentence on inactive wells and TRRC's enforcement, or null when none are inactive. */
export function inactiveSentence(d: LeaseDistress, submittedWells: number): string | null {
  if (!d.inactive.wells) return null;
  const span = d.inactive.earliestShutIn === d.inactive.latestShutIn ? `since ${shutInLabel(d.inactive.earliestShutIn)}` : `since ${shutInLabel(d.inactive.earliestShutIn)}–${shutInLabel(d.inactive.latestShutIn)}`;
  const denied = d.inactive.denied ? `; TRRC denied the plugging extension for ${d.inactive.denied === d.inactive.wells ? "every one" : d.inactive.denied}` : "";
  const nov = d.inactiveViolationWells ? ` ${d.inactiveViolationWells} carry a Notice of Violation for an inactive unplugged well (SWR 3.14(b)(2)).` : "";
  return `${d.inactive.wells} of ${submittedWells} submitted wells are on TRRC's inactive-well report, shut in ${span}${denied}.${nov}`;
}

export function exposureSentence(x: PluggingExposure, a: EconomicsAssumptions): string | null {
  if (!x.wells) return null;
  const share = a.interestType === "working"
    ? ` The evaluated ${a.workingInterest} working interest carries ${usd(x.toInterestUsd)} of it.`
    : " A royalty does not pay to plug; the operator and working-interest owners do, and an abandoned lease pays no royalty.";
  return `Plugging exposure: ${x.wells} inactive well(s) × ${usd(x.costPerWellUsd)} per well = ${usd(x.grossUsd)} gross, at the stated plugging-cost assumption (not a bid).${share}`;
}

/**
 * PASS reasons when the record shows the lease is no longer an asset.
 * Empty when it is still producing.
 */
export function distressPassReasons(d: LeaseDistress, submittedWells: number, a: EconomicsAssumptions): string[] {
  if (!d.stoppedOnCurrentFilings) return [];
  const x = pluggingExposure(d, a);
  return [
    stoppedSentence(d),
    a.askingPriceUsd
      ? `There is no production value to support the ${usd(a.askingPriceUsd)} asking price; a decline curve cannot value a lease that has stopped producing.`
      : "There is no production value to price; a decline curve cannot value a lease that has stopped producing.",
    ...[inactiveSentence(d, submittedWells), exposureSentence(x, a)].filter((s): s is string => !!s),
  ];
}
