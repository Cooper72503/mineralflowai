/**
 * Decision step of API -> lease -> lease records -> ownership -> decision.
 *
 * The acquisition agent supplies its own underwriting instead of asking for a
 * price: every rule and number here is a MineralFlow standard assumption,
 * stated in the report as such, and any of them can be overridden. Nothing
 * here reads the network; it turns a valued lease into offers, a verdict and
 * the risks that drive it.
 */
import type { InterestValuation, ByScenario } from "../ownership/interest-value";
import type { LeaseOwnership } from "../ownership/mineral-roll";

export type Verdict = "BUY" | "REVIEW" | "PASS";

export interface OfferRange {
  interest: "royalty" | "working_interest";
  /** What one unit of the offer buys, in words. */
  unit: string;
  low: number;
  high: number;
  ceiling: number;
  /** Base-case PV-10 of the unit, for context. */
  basePv10: number;
}

export interface Offers {
  status: "calculated" | "unavailable";
  reason: string | null;
  ranges: OfferRange[];
  /** Price per net royalty acre; withheld unless unit acreage is sourced. */
  perNra: { status: "calculated" | "unavailable"; value: OfferRange | null; reason: string | null };
}

export const OFFER_POLICY = "Offer range from the downside-price PV-10 to the base-price PV-15; walk-away ceiling at the base-price PV-10. Downside prices are 25% below the live EIA spot price, upside 25% above.";

const range = (interest: OfferRange["interest"], unit: string, pv10: ByScenario, pv15: ByScenario, scale: number): OfferRange => {
  const a = pv10.stress * scale, b = pv15.base * scale;
  return { interest, unit, low: Math.min(a, b), high: Math.max(a, b), ceiling: pv10.base * scale, basePv10: pv10.base * scale };
};

export function offersFor(valuation: InterestValuation): Offers {
  const none = (reason: string): Offers => ({ status: "unavailable", reason, ranges: [], perNra: { status: "unavailable", value: null, reason } });
  if (valuation.status !== "valued" || !valuation.royaltyUnitPv10 || !valuation.royaltyUnitPv15) return none(valuation.reason ?? "The lease could not be valued.");
  const ranges: OfferRange[] = [range("royalty", "0.01 royalty decimal of the whole lease (also prices an override of the same decimal)", valuation.royaltyUnitPv10, valuation.royaltyUnitPv15, 0.01)];
  if (valuation.workingInterestPv10 && valuation.workingInterestPv15 && valuation.leaseNri)
    ranges.push(range("working_interest", `1% working interest (carrying ${(valuation.leaseNri).toFixed(4)} of revenue per 1.00 WI)`, valuation.workingInterestPv10, valuation.workingInterestPv15, 0.01));
  return { status: "calculated", reason: null, ranges,
    perNra: { status: "unavailable", value: null, reason: "Unit gross acreage is not carried on the mineral roll (acres are zero) and TRRC proration acres are not the unit's acreage, so a price per net royalty acre is not stated." } };
}

export interface LeaseSignals {
  valuation: InterestValuation;
  ownership: LeaseOwnership;
  /** R-squared of the oil (or gas) decline fit; null when no fit. */
  fitRSquared: number | null;
  monthsOfHistory: number;
  trailingUnreportedMonths: number;
  currentAnnualDeclinePct: number | null;
  producingWells: number;
  prorationWells: number;
  shutInWells: number;
  formsLackingWells: number;
  regulatoryCritical: string[];
  regulatoryImportant: string[];
  title: { status: "published" | "in_progress" | "not_found" | "unavailable"; readInstruments: number; indexedInstruments: number; reason: string | null };
  excludedMembers: number;
}

export interface Risk { severity: 1 | 2 | 3; text: string }
export interface LeaseDecision { verdict: Verdict; reasons: string[]; conditions: string[]; risks: Risk[] }

export const DECISION_RULES = [
  "PASS when the lease cannot return value: no forecast volume remains at the stated costs, or base-case economic life is under 12 months.",
  "REVIEW when the value is not supportable from the record: owners not matched on the mineral roll, a tract whose decimals do not reconcile, no decline fit or a fit with R-squared under 0.60, fewer than 12 months of history, or a critical regulatory flag.",
  "BUY otherwise, within the offer range and never above the ceiling, subject to the stated conditions (title, and anything the record could not establish).",
];

export function decideLease(x: LeaseSignals): LeaseDecision {
  const pass: string[] = [], review: string[] = [], conditions: string[] = [], risks: Risk[] = [];
  const v = x.valuation;
  if (v.status !== "valued") {
    if (/economic limit/i.test(v.reason ?? "")) pass.push(v.reason!);
    else review.push(`Not valued: ${v.reason}`);
  } else if ((v.economicLimitMonths?.base ?? 0) < 12) pass.push(`Base-case economic life is ${v.economicLimitMonths?.base ?? 0} months at the stated costs.`);

  if (x.ownership.status !== "matched") review.push(`Owners not established: ${x.ownership.reason}`);
  for (const t of x.ownership.tracts.filter(t => t.irregular)) review.push(`Appraisal tract ${t.cadLeaseNumber} decimals sum to ${t.totals.all.toFixed(6)}, not 1.`);
  if (x.ownership.status === "matched" && !x.ownership.nameVerified) conditions.push("Confirm the appraisal tracts are this lease: the TRRC lease name was unavailable to verify them.");
  if (x.fitRSquared === null) review.push("No decline curve could be fit to the reported production.");
  else if (x.fitRSquared < 0.6) review.push(`The decline fit explains little of the history (R-squared ${x.fitRSquared.toFixed(2)}).`);
  if (x.monthsOfHistory < 12) review.push(`Only ${x.monthsOfHistory} months of reported production.`);
  for (const f of x.regulatoryCritical) review.push(`Regulatory: ${f}`);

  if (x.title.status !== "published") conditions.push(`Title: ${x.title.reason ?? "no published courthouse chain"}. Close subject to title examination.`);
  else if (x.title.readInstruments === 0) conditions.push(`Title: ${x.title.indexedInstruments} recordings are from the clerk index only; no instrument text was read. Close subject to title examination.`);
  else conditions.push(`Title: ${x.title.readInstruments} of ${x.title.indexedInstruments} recordings read. The chain is evidence, not a title opinion; close subject to title examination.`);
  conditions.push("Owner decimals are the appraisal district's, taken from operator division orders; confirm against the seller's division order before closing.");

  if (v.status === "valued") {
    const life = v.economicLimitMonths!.base;
    if (life < 36) risks.push({ severity: 3, text: `Short life: ${life} months to the economic limit at base prices.` });
    const stressShare = v.royaltyUnitPv10!.base > 0 ? v.royaltyUnitPv10!.stress / v.royaltyUnitPv10!.base : 1;
    if (stressShare < 0.7) risks.push({ severity: 2, text: `Price sensitivity: value falls ${Math.round((1 - stressShare) * 100)}% at downside prices.` });
    if (v.economicLimitAtHorizonCap) risks.push({ severity: 1, text: "The forecast is still economic at the 40-year cap; value depends on a long tail." });
  }
  if (x.currentAnnualDeclinePct !== null && x.currentAnnualDeclinePct > 40) risks.push({ severity: 2, text: `Steep decline: about ${Math.round(x.currentAnnualDeclinePct)}% a year at the current rate.` });
  if (x.shutInWells > 0) risks.push({ severity: 2, text: `${x.shutInWells} of ${x.prorationWells} proration well(s) are shut in.` });
  if (x.formsLackingWells > 0 && !x.regulatoryImportant.concat(x.regulatoryCritical).some(f => /FORMS LACKING/i.test(f))) risks.push({ severity: 2, text: `${x.formsLackingWells} well(s) carry "forms lacking" on TRRC's proration schedule.` });
  if (x.trailingUnreportedMonths >= 3) risks.push({ severity: 2, text: `${x.trailingUnreportedMonths} recent months have no reported production.` });
  for (const f of x.regulatoryCritical) risks.push({ severity: 3, text: f });
  for (const f of x.regulatoryImportant) risks.push({ severity: 1, text: f });
  if (x.title.status !== "published" || x.title.readInstruments === 0) risks.push({ severity: 2, text: "Title rests on the county index; no instrument text was read." });
  if (x.ownership.rejectedTracts.length) risks.push({ severity: 1, text: `${x.ownership.rejectedTracts.length} appraisal tract(s) under the same RRC number belong to another district's lease and were excluded.` });
  if (x.excludedMembers) risks.push({ severity: 2, text: `${x.excludedMembers} submitted API(s) on this lease could not be reconciled to its production.` });
  risks.sort((a, b) => b.severity - a.severity);

  const verdict: Verdict = pass.length ? "PASS" : review.length ? "REVIEW" : "BUY";
  const reasons = verdict === "PASS" ? pass : verdict === "REVIEW" ? review
    : [`Valued from ${x.monthsOfHistory} months of reported lease production, a decline fit with R-squared ${x.fitRSquared!.toFixed(2)}, and ${x.ownership.owners.length} owners of record whose decimals reconcile.`];
  return { verdict, reasons, conditions, risks: risks.slice(0, 6) };
}

export function decideDeal(leases: { name: string; decision: LeaseDecision }[]): { verdict: Verdict; reasons: string[] } {
  if (!leases.length) return { verdict: "REVIEW", reasons: ["No submitted API reconciled to a producing lease."] };
  const buy = leases.filter(l => l.decision.verdict === "BUY"), review = leases.filter(l => l.decision.verdict === "REVIEW"), pass = leases.filter(l => l.decision.verdict === "PASS");
  if (buy.length) return { verdict: "BUY", reasons: [`Buy ${buy.map(l => l.name).join(", ")} within the offer ranges.`, ...(review.length ? [`Hold ${review.map(l => l.name).join(", ")} for review.`] : []), ...(pass.length ? [`Pass on ${pass.map(l => l.name).join(", ")}.`] : [])] };
  if (review.length) return { verdict: "REVIEW", reasons: review.flatMap(l => l.decision.reasons.map(r => `${l.name}: ${r}`)) };
  return { verdict: "PASS", reasons: pass.flatMap(l => l.decision.reasons.map(r => `${l.name}: ${r}`)) };
}
