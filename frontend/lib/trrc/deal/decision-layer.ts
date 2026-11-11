/**
 * MineralFlow decision layer: takes the RRC evidence, title and ownership,
 * production and the EconomicsProvider's result under the user's
 * assumptions, and assembles the decision.
 *
 *   normalize → reconcile → contradictions → missing diligence →
 *   entry and exit metrics → risk → decision, every item traced to a source.
 *
 * Pure: the page runs it on every recalculation and the Decision Record
 * runs it for the PDF, so what is shown is what is printed.
 */
import { reportedProductionSeries } from "../production-series";
import { monthlyDiscountRate } from "../economics";
import { CONFLICT_FINDING_TYPES, GAP_FINDING_TYPES } from "../title/chain-types";
import { evaluatePrototype, defaultAssumptions, validateAssumptions, type EconomicsAssumptions, type AssumptionBasis, type EconomicsAsset, type EconomicsResult } from "../economics-provider";
import type { Deal, DealLease } from "./build";
import type { Verdict } from "./underwriting";
import { MAX_UNREPORTED_COMPLETED_MONTHS } from "./readiness";
import { differsSentence, filledSentence } from "../sales/reconcile";

import { assessDistress, distressPassReasons, distressReviewReasons, reportingGapReason, exposureSentence, inactiveSentence, pluggingExposure, type LeaseDistress, type PluggingExposure } from "./distress";

export interface Finding { kind: "contradiction" | "missing"; severity: 1 | 2 | 3; text: string; sources: string[] }
export interface Risk { severity: 1 | 2 | 3; text: string }

export interface EntryAnalysis {
  hurdlePct: number;
  ceiling: number;
  rangeLow: number;
  rangeHigh: number;
  askingPriceUsd: number | null;
  askingIrrPct: number | null;
  askingPayoutMonths: number | null;
  askingMultiple: number | null;
  /** Plugging cost the interest takes on at entry, deducted from value and added to the outlay. */
  liabilityUsd: number;
  position: "no asking price" | "within range" | "above range, under ceiling" | "above ceiling" | "below range";
}

export interface ExitAnalysis {
  holdYears: number;
  entryBasisUsd: number;
  entryBasisLabel: string;
  byScenario: Record<"downside" | "base" | "upside", { holdCash: number; exitValue: number; total: number; multiple: number | null; irrPct: number | null }>;
}

export interface LeaseDecisionRecord {
  leaseKey: string;
  leaseName: string;
  verdict: Verdict;
  reasons: string[];
  conditions: string[];
  risks: Risk[];
  contradictions: Finding[];
  missing: Finding[];
  economics: EconomicsResult;
  entry: EntryAnalysis | null;
  exit: ExitAnalysis | null;
  distress: LeaseDistress;
  plugging: PluggingExposure;
}

export interface DealDecisionRecord { verdict: Verdict; reasons: string[]; leases: LeaseDecisionRecord[]; dealFindings: Finding[] }

/** The provider's view of a lease: reported lease-level production only. */
export function economicsAssetFromLease(l: DealLease): EconomicsAsset {
  const rep = reportedProductionSeries(l.production);
  return { key: l.key, name: l.leaseName ?? `RRC ${l.district}-${l.leaseNumber}`, monthlyOilBbl: rep.oil, monthlyGasMcf: rep.gas,
    lastReportedMonth: l.lastReportedMonth, producingWells: l.producingWells, fieldName: l.field, county: l.county };
}

export function defaultsForLease(l: DealLease, deal: Pick<Deal, "deck" | "deckLabel">): { assumptions: EconomicsAssumptions; basis: AssumptionBasis } {
  const v = l.valuation;
  const start = defaultAssumptions({
    oilPriceUsdBbl: deal.deck.scenarios.base.oilUsdBbl, gasPriceUsdMcf: deal.deck.scenarios.base.gasUsdMcf, priceBasis: deal.deckLabel,
    fieldName: l.field, county: l.county,
    operatorNri: v.leaseNri && v.leaseNriBasis && !/No working-interest/.test(v.leaseNriBasis) ? round4(v.leaseNri) : null,
    operatorNriBasis: v.leaseNri && v.leaseNriBasis && !/No working-interest/.test(v.leaseNriBasis) ? `Appraisal roll working-interest decimal (${round4(v.leaseNri)})` : null,
  });
  if (deal.deck.source === "eia_live") {
    start.basis.gasPriceUsdMcf = `${deal.deckLabel}. Conversion assumption: 1.000 MMBtu/Mcf, so $/MMBtu × 1.000 = $/Mcf. Lease heating value is unavailable; enter a realized $/Mcf price when known.`;
  }
  const location = `${l.operator ?? "Operator unavailable"} / ${l.county ?? "County unavailable"}`;
  for (const key of ["loeUsdPerBoe", "fixedOpexUsdPerWellMonth", "workoverUsdPerBoe"] as const)
    start.basis[key] += `. Scenario for ${location}; not verified operator expenses`;
  return start;
}

const round4 = (x: number) => Math.round(x * 1e4) / 1e4;
const norm = (s: string | null | undefined) => (s ?? "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\b(LLC|INC|LP|LTD|CO|CORP|CORPORATION|COMPANY|USA|U S A|THE)\b/g, " ").replace(/\s+/g, " ").trim();
const pvAt = (cf: number[], annualPct: number) => { const r = 1 + monthlyDiscountRate(annualPct / 100); return cf.reduce((t, c, i) => t + c / Math.pow(r, i + 1), 0); };

/**
 * Annualized IRR of monthly cash flows (an outlay then receipts), negative
 * when the receipts never recover the outlay. Null when the series has no
 * outlay, no receipts, or does not change sign once.
 */
export function irrAnnualPct(series: number[]): number | null {
  if (series.length < 2 || !(series[0] < 0) || !series.slice(1).some(v => v > 0)) return null;
  const npv = (r: number) => series.reduce((acc, v, t) => acc + v / Math.pow(1 + r, t), 0);
  let lo = -0.99, hi = 1;
  while (npv(hi) > 0 && hi < 1e6) hi *= 2;
  if (npv(lo) < 0 || npv(hi) > 0) return null;
  for (let i = 0; i < 200; i++) { const mid = (lo + hi) / 2; if (npv(mid) > 0) lo = mid; else hi = mid; }
  return (Math.pow(1 + (lo + hi) / 2, 12) - 1) * 100;
}

/**
 * `liabilityUsd` is a cost the buyer takes on at entry (the interest's share
 * of plugging inactive wells): it comes off every value and is added to the
 * outlay for IRR, payout and multiple.
 */
export function entryAnalysis(e: EconomicsResult, liabilityUsd = 0): EntryAnalysis | null {
  if (e.status !== "calculated" || !e.scenarios) return null;
  const a = e.assumptions, s = e.scenarios;
  const ceiling = s.base.presentValue - liabilityUsd;
  const high = pvAt(s.base.monthlyNet, a.discountRatePct + 5) - liabilityUsd;
  const low = Math.min(s.downside.presentValue - liabilityUsd, high);
  let irr: number | null = null, payout: number | null = null, multiple: number | null = null;
  let position: EntryAnalysis["position"] = "no asking price";
  if (a.askingPriceUsd) {
    const outlay = a.askingPriceUsd + liabilityUsd;
    irr = irrAnnualPct([-outlay, ...s.base.monthlyNet]);
    let cum = -outlay;
    payout = null;
    for (let i = 0; i < s.base.monthlyNet.length; i++) { cum += s.base.monthlyNet[i]; if (cum >= 0) { payout = i + 1; break; } }
    multiple = s.base.undiscountedNet / outlay;
    position = a.askingPriceUsd > ceiling ? "above ceiling" : a.askingPriceUsd > high ? "above range, under ceiling" : a.askingPriceUsd < low ? "below range" : "within range";
  }
  return { hurdlePct: a.discountRatePct, ceiling, rangeLow: low, rangeHigh: high, askingPriceUsd: a.askingPriceUsd, askingIrrPct: irr, askingPayoutMonths: payout, askingMultiple: multiple, liabilityUsd, position };
}

export function exitAnalysis(e: EconomicsResult, entry: EntryAnalysis | null): ExitAnalysis | null {
  if (e.status !== "calculated" || !e.scenarios || !entry) return null;
  const a = e.assumptions;
  const months = Math.round(a.holdYears * 12);
  const basis = (a.askingPriceUsd ?? entry.rangeHigh) + entry.liabilityUsd;
  const r = 1 + monthlyDiscountRate(a.discountRatePct / 100);
  const out = {} as ExitAnalysis["byScenario"];
  for (const k of ["downside", "base", "upside"] as const) {
    const cf = e.scenarios[k].monthlyNet;
    const hold = cf.slice(0, months);
    const holdCash = hold.reduce((t, c) => t + c, 0);
    // What a buyer at the same hurdle would pay at exit for the remaining cash flow.
    const exitValue = cf.slice(months).reduce((t, c, i) => t + c / Math.pow(r, i + 1), 0);
    const series = [-basis, ...hold.map((c, i) => i === hold.length - 1 ? c + exitValue : c)];
    if (hold.length < months) series.push(...new Array(months - hold.length).fill(0));
    out[k] = { holdCash, exitValue, total: holdCash + exitValue, multiple: basis > 0 ? (holdCash + exitValue) / basis : null, irrPct: basis > 0 ? irrAnnualPct(series) : null };
  }
  const label = a.askingPriceUsd ? "asking price" : "top of the recommended range";
  return { holdYears: a.holdYears, entryBasisUsd: basis, entryBasisLabel: entry.liabilityUsd ? `${label} plus the interest's plugging share` : label, byScenario: out };
}

/** Everything the record found that does not agree, or that it could not establish. */
/** Royalty decimals above this are almost always a working interest's revenue share entered as a royalty. */
export const ROYALTY_NRI_PLAUSIBLE_MAX = 0.3;

export function reconcile(l: DealLease, e: EconomicsResult, plugging?: PluggingExposure): { contradictions: Finding[]; missing: Finding[] } {
  const contradictions: Finding[] = [], missing: Finding[] = [];
  const src = l.sources;
  // The same limitation on many wells is one finding with a count, not one line per well.
  const gaps = new Map<string, { c: NonNullable<DealLease["regulatory"]["coverage"]>[number]; apis: string[]; sources: string[] }>();
  for (const c of l.regulatory.coverage ?? []) {
    if (c.status === "verified") continue;
    const key = `${c.status}|${c.source}|${c.reason}`;
    const g = gaps.get(key) ?? { c, apis: [], sources: [] };
    g.apis.push(c.api); g.sources.push(c.sourceId); gaps.set(key, g);
  }
  for (const { c, apis, sources } of gaps.values()) missing.push({ kind: "missing", severity: c.status === "unavailable" ? 3 : 1,
    text: apis.length === 1 ? `${apis[0]}: ${c.source}: ${c.reason}` : `${c.source}: ${c.reason.replace(/\.$/, "")} (${apis.length} wells).`, sources: [...new Set(sources)] });
  const a = e.assumptions;
  if (a.interestType === "royalty" && a.netRevenueInterest > ROYALTY_NRI_PLAUSIBLE_MAX)
    contradictions.push({ kind: "contradiction", severity: 3, sources: [],
      text: `The scenario values a royalty at NRI ${a.netRevenueInterest}. Royalty decimals are rarely above 0.25; ${a.netRevenueInterest} is typical of a working interest's revenue share. A royalty bears no operating${plugging?.grossUsd ? ` or plugging cost, so this scenario leaves out $${Math.round(plugging.grossUsd).toLocaleString("en-US")} of plugging exposure` : " cost"}. Set the interest type to working interest if that is what is being bought.` });
  for (const c of l.coverage ?? []) if (c.retrieved < c.wells)
    missing.push({ kind: "missing", severity: 3, text: `${c.source} was verified for ${c.retrieved} of ${c.wells} wells: ${c.lastError ?? "retrieval incomplete"}.`, sources: src.wells });
  if (!l.regulatory.coverage?.length) missing.push({ kind: "missing", severity: 3, text: "Per-well regulatory coverage has not been established for this report version.", sources: src.wells });
  if (l.ownership.status === "matched" && !l.ownership.nameVerified)
    missing.push({ kind: "missing", severity: 3, text: "Appraisal ownership is not verified against this lease's identity.", sources: src.roll });
  for (const tr of l.ownership.tracts.filter(t => t.irregular))
    contradictions.push({ kind: "contradiction", severity: 3, text: `Appraisal tract ${tr.cadLeaseNumber} decimals do not reconcile.`, sources: src.roll });
  const sellerMonths = l.seller?.months ?? [];
  const filled = filledSentence(sellerMonths), differs = differsSentence(sellerMonths);
  if (filled) contradictions.push({ kind: "contradiction", severity: 3, text: filled, sources: l.seller!.sources });
  if (differs) contradictions.push({ kind: "contradiction", severity: 3, text: differs, sources: [...l.seller!.sources, ...src.production] });
  const filledCount = sellerMonths.filter(m => m.basis === "filled").length;
  if (filledCount) missing.push({ kind: "missing", severity: 2, sources: l.seller!.sources,
    text: `${filledCount} month(s) of production in this record come from seller-supplied purchaser run statements, not TRRC; confirm them with the purchaser before closing.` });
  const opTrrc = norm(l.operator);
  const rollOps = [...new Set(l.ownership.tracts.map(t => t.operatorName).filter((x): x is string => !!x))];
  for (const op of rollOps) {
    const n = norm(op);
    if (opTrrc && n && !n.includes(opTrrc.split(" ")[0]) && !opTrrc.includes(n.split(" ")[0]))
      contradictions.push({ kind: "contradiction", severity: 1, text: `TRRC lists ${l.operator} as operator; the ${l.ownership.sources[0]?.county ?? "county"} appraisal roll (tax year ${l.ownership.sources[0]?.taxYear ?? "?"}) carries ${op.replace(/\.+$/, "")}. An operator change after the roll's valuation date would explain it; confirm with the operator of record.`, sources: [...src.wells, ...src.roll] });
  }
  const offSchedule = l.wells.filter(w => w.inPackage && !w.onProration);
  if (offSchedule.length) contradictions.push({ kind: "contradiction", severity: 1, text: `${offSchedule.length} submitted API(s) (${offSchedule.map(w => w.wellNo ?? w.api10).join(", ")}) are on this lease per TRRC's wellbore record but are not carried on its oil proration schedule.`, sources: src.wells });
  const shut = l.wells.filter(w => /SHUT/i.test(w.status ?? ""));
  if (shut.length && l.production.length) contradictions.push({ kind: "contradiction", severity: 1, text: `${shut.length} of ${l.wells.filter(w => w.onProration).length} proration wells are shut in while the lease reports production; lease-level volumes do not show which wells produce it.`, sources: [...src.wells, ...src.production] });

  const t = l.title.analysis;
  if (t) {
    if (t.status !== "NO_SURFACE_DISCONTINUITIES_DETECTED") missing.push({ kind: "missing", severity: 3, text: `Title assessment: ${t.statusDisplay ?? t.status ?? "not established"}.`, sources: src.title });
    if (t.reviewQueueOpenCount > 0) missing.push({ kind: "missing", severity: 3, text: `${t.reviewQueueOpenCount} title review item(s) remain unresolved in the linked research scope.`, sources: src.title });
    // One line per kind of finding, with its count: the analysis records one finding per instance.
    const findings = t.findings;
    const grouped = (types: string[], text: (f: typeof findings[number], n: number) => string, kind: Finding["kind"]) => {
      const byTitle = new Map<string, typeof findings>();
      for (const f of findings.filter(f => types.includes(f.type))) byTitle.set(f.title, [...(byTitle.get(f.title) ?? []), f]);
      return [...byTitle.values()].map(fs => ({ kind, severity: (fs.some(f => f.severity === "critical" || f.severity === "high") ? 3 : 2) as 2 | 3, text: text(fs[0], fs.length), sources: src.title }));
    };
    contradictions.push(...grouped(CONFLICT_FINDING_TYPES, (f, n) => `Title: ${f.title}${n > 1 ? ` (${n} instances)` : ""}. ${f.explanation}`, "contradiction"));
    missing.push(...grouped(GAP_FINDING_TYPES.filter(x => x !== "INDEX_ONLY_EVIDENCE"), (f, n) => `Title: ${f.title}${n > 1 ? ` (${n} instances)` : ""}. ${f.nextAction || f.explanation}`, "missing"));
    const unread = l.title.indexedInstruments - l.title.readInstruments;
    if (unread > 0) missing.push({ kind: "missing", severity: 2, text: `${unread} of ${l.title.indexedInstruments} recordings on the tract are known from the clerk's index only; their text was not read.`, sources: src.title });
    for (const lim of t.limitations.filter(x => /not been researched|not researched|no confirmed tract covers/i.test(x)))
      missing.push({ kind: "missing", severity: 3, text: `Title: ${lim}`, sources: src.title });
    const opWords = opTrrc.split(" ").filter(w => w.length >= 4);
    const names = t.chronology.flatMap(r => [...r.fromParties, ...r.toParties].map(p => norm(p.displayName)));
    if (opWords.length && !names.some(n => opWords.some(w => n.includes(w))))
      missing.push({ kind: "missing", severity: 2, text: `No retrieved recording on the tract names the TRRC operator (${l.operator}); the lease or assignment into the operator is not in the chain.`, sources: [...src.title, ...src.wells] });
  } else {
    missing.push({ kind: "missing", severity: 3, text: `No courthouse chain of title: ${l.title.reason ?? "no research published"}.`, sources: [] });
  }

  if (l.ownership.status === "matched") {
    const royaltyTotal = l.ownership.tracts.reduce((s, tr) => s + (tr.totals.royalty + tr.totals.overriding_royalty) * tr.productionShare, 0);
    if (e.assumptions.interestType === "royalty" && e.assumptions.netRevenueInterest > royaltyTotal + 1e-6)
      contradictions.push({ kind: "contradiction", severity: 3, text: `The entered royalty decimal (${e.assumptions.netRevenueInterest}) exceeds all royalty and overriding royalty carried on the roll for this lease (${round4(royaltyTotal)}).`, sources: src.roll });
  } else {
    missing.push({ kind: "missing", severity: 2, text: `Owners of record not established from an appraisal roll (${(l.ownership.reason ?? "not matched").replace(/\.+$/, "")}); the entered interest (${e.assumptions.netRevenueInterest}) is the user's and is unverified.`, sources: src.roll });
  }
  missing.push({ kind: "missing", severity: 1, text: "Production is reported to TRRC by lease; well-level allocation is not attempted here.", sources: src.production });
  if (l.trailingUnreportedMonths > MAX_UNREPORTED_COMPLETED_MONTHS) missing.push({ kind: "missing", severity: 3, text: `${l.trailingUnreportedMonths} completed months have no reported production; current valuation requires updated evidence.`, sources: src.production });
  missing.push({ kind: "missing", severity: 1, text: "A title opinion and the seller's division order are required before closing; the chain here is evidence of the record.", sources: [] });
  if (!e.assumptions.askingPriceUsd) missing.push({ kind: "missing", severity: 1, text: "No asking price entered: IRR at asking, payout at asking and the asking-price position are unavailable. Exit analysis may show an illustrative IRR at the explicitly labeled entry basis.", sources: [] });
  return { contradictions, missing };
}

export function decideLeaseRecord(l: DealLease, e: EconomicsResult): LeaseDecisionRecord {
  // Reports built before the distress assessment existed recompute it from what they carry.
  const distress = l.distress ?? assessDistress(l.production, l.wells, l.trailingUnreportedMonths);
  const plugging = pluggingExposure(distress, e.assumptions);
  const { contradictions, missing } = reconcile(l, e, plugging);
  const entry = entryAnalysis(e, plugging.toInterestUsd);
  const exit = exitAnalysis(e, entry);
  const pass: string[] = [], review: string[] = [], conditions: string[] = [], risks: Risk[] = [];
  const s = e.scenarios;
  // A stopped lease is a finding from TRRC's reported production, not an
  // unavailable forecast: it decides the record ahead of any evidence gap.
  pass.push(...distressPassReasons(distress, l.apis.length, e.assumptions));
  review.push(...distressReviewReasons(distress, l.apis.length, e.assumptions));
  const inactive = inactiveSentence(distress, l.apis.length), exposure = exposureSentence(plugging, e.assumptions);
  if (inactive) risks.push({ severity: 3, text: inactive });
  if (exposure) { risks.push({ severity: 3, text: exposure }); conditions.push("Obtain the operator's plugging schedule, TRRC compliance status for the inactive wells and plugging bids before valuing any interest."); }
  if (distress.stopped) conditions.push(`Obtain the seller's purchaser run statements from ${distress.lastProducingMonth ?? "the start of the zero months"} forward and reconcile every month to TRRC, which shows zero or no report.`);
  // The seller's evidence and its disagreement with TRRC lead, ahead of the gaps it leaves.
  review.push(...[filledSentence(l.seller?.months ?? []), differsSentence(l.seller?.months ?? [])].filter((x): x is string => !!x));
  const gapReason = e.status !== "calculated" ? reportingGapReason(l.production) : null;
  if (e.status !== "calculated" && !distress.stopped) review.push(`Economics not calculated: ${gapReason ?? e.reason}`);
  // Inactive wells TRRC refused to extend are a present obligation whether or not the lease still produces.
  if (!distress.stopped && distress.inactive.denied) review.push(...[inactive, exposure].filter((x): x is string => !!x));
  else if (s && s.base.lifeMonths < 12) pass.push(`Base-case life is ${s.base.lifeMonths} months at the stated costs.`);
  else if (s && s.base.presentValue <= 0) pass.push(`The interest has no positive value at base prices under these assumptions (${s.base.presentValue < 0 ? "−" : ""}$${Math.abs(Math.round(s.base.presentValue)).toLocaleString("en-US")} at ${e.assumptions.discountRatePct}%).`);
  if (entry?.position === "above ceiling") pass.push(`Asking price $${Math.round(entry.askingPriceUsd!).toLocaleString("en-US")} is above the walk-away ceiling of $${Math.round(entry.ceiling).toLocaleString("en-US")} at a ${entry.hurdlePct}% hurdle.`);
  if (!l.fit) { if (!distress.stopped && !gapReason) review.push("No decline curve could be fit to the reported production."); }
  else if (l.fit.rSquared < 0.6) review.push(`The decline fit explains little of the history (R-squared ${l.fit.rSquared.toFixed(2)}).`);
  for (const f of l.regulatory.critical) review.push(`Regulatory: ${f}`);
  for (const c of contradictions.filter(c => c.severity === 3)) review.push(c.text);
  for (const m of missing.filter(m => m.severity >= 2)) { review.push(m.text); conditions.push(m.text); }
  // Even medium-severity title conflicts cannot be left outside the verdict.
  for (const c of contradictions.filter(c => c.text.startsWith("Title:") && c.severity < 3)) review.push(c.text);
  conditions.push("Close subject to title examination and the seller's division order.");
  if (entry?.position === "above range, under ceiling") conditions.push(`Negotiate toward $${Math.round(entry.rangeHigh).toLocaleString("en-US")}: the asking price is above the recommended range but under the ceiling.`);

  if (s && e.status === "calculated") {
    if (s.base.lifeMonths < 36) risks.push({ severity: 3, text: `Short life: ${s.base.lifeMonths} months to the economic limit at base prices.` });
    const drop = s.base.presentValue > 0 ? 1 - s.downside.presentValue / s.base.presentValue : 0;
    if (drop > 0.3) risks.push({ severity: 2, text: `Price sensitivity: value falls ${Math.round(drop * 100)}% in the downside case.` });
    if (s.base.atHorizonCap) risks.push({ severity: 1, text: "The forecast is still economic at the 40-year cap; value depends on a long tail." });
  }
  if (l.fit && l.fit.currentAnnualDeclinePct > 40) risks.push({ severity: 2, text: `Steep decline: about ${Math.round(l.fit.currentAnnualDeclinePct)}% a year at the current rate.` });
  for (const c of contradictions) risks.push({ severity: c.severity, text: c.text });
  for (const f of l.regulatory.important) risks.push({ severity: 1, text: f });
  risks.sort((a, b) => b.severity - a.severity);

  const verdict: Verdict = pass.length ? "PASS" : review.length ? "REVIEW" : "BUY";
  const reasons = verdict === "PASS" ? pass : verdict === "REVIEW" ? [...new Set(review)] : [
    entry?.askingPriceUsd
      ? `Asking price $${Math.round(entry.askingPriceUsd).toLocaleString("en-US")} is ${entry.position} ($${Math.round(entry.rangeLow).toLocaleString("en-US")}–$${Math.round(entry.rangeHigh).toLocaleString("en-US")}, ceiling $${Math.round(entry.ceiling).toLocaleString("en-US")}).`
      : `Buy within $${Math.round(entry!.rangeLow).toLocaleString("en-US")}–$${Math.round(entry!.rangeHigh).toLocaleString("en-US")}; walk away above $${Math.round(entry!.ceiling).toLocaleString("en-US")}.`,
    `Valued from ${l.production.length} months of reported lease production with a decline fit of R-squared ${l.fit!.rSquared.toFixed(2)}.`,
  ];
  return { leaseKey: l.key, leaseName: l.leaseName ?? `RRC ${l.district}-${l.leaseNumber}`, verdict, reasons, conditions: [...new Set(conditions)], risks: risks.slice(0, 8), contradictions, missing, economics: e, entry, exit, distress, plugging };
}

/** The whole package: one record per lease under that lease's assumptions. */
export function assembleDecision(deal: Deal, assumptionsByLease: Record<string, EconomicsAssumptions>): DealDecisionRecord {
  const leases = deal.leases.map(l => {
    const a = assumptionsByLease[l.key] ?? defaultsForLease(l, deal).assumptions;
    return decideLeaseRecord(l, evaluatePrototype(economicsAssetFromLease(l), a));
  });
  const dealFindings: Finding[] = deal.excluded.map(x => ({ kind: "missing", severity: 3, text: `${x.input}: ${x.reason}`, sources: [] }));
  for (const reason of deal.completeness?.blockers ?? []) if (!dealFindings.some(f => f.text === reason))
    dealFindings.push({ kind: "missing", severity: 3, text: reason.replace(/Not valued:/g, "Ownership-based valuation unavailable:"), sources: [] });
  if (deal.deck.source === "static_fallback") dealFindings.push({ kind: "missing", severity: 3, text: "No sourced EIA deck is available. Starting prices are fallback assumptions; displayed economics are conditional, not a supported acquisition value.", sources: [] });
  const buy = leases.filter(l => l.verdict === "BUY"), review = leases.filter(l => l.verdict === "REVIEW"), pass = leases.filter(l => l.verdict === "PASS");
  const verdict: Verdict = dealFindings.some(f => f.severity >= 2) || review.length || (buy.length && pass.length) || !leases.length ? "REVIEW" : buy.length ? "BUY" : "PASS";
  const reasons = !leases.length ? ["No submitted API reconciled to a producing lease."]
    : verdict === "BUY" ? [`Buy ${buy.map(l => l.leaseName).join(", ")}.`, ...(review.length ? [`Hold ${review.map(l => l.leaseName).join(", ")} for review.`] : []), ...(pass.length ? [`Pass on ${pass.map(l => l.leaseName).join(", ")}.`] : [])]
    // Each lease's own decision reasons first: package blockers restate the evidence gaps they rest on.
    : [...new Set([...(buy.length && pass.length ? ["Mixed lease outcomes: the submitted package is not approved as a whole."] : []), ...leases.flatMap(l => l.reasons.map(r => `${l.leaseName}: ${r}`)), ...dealFindings.map(f => f.text)])];
  return { verdict, reasons, leases, dealFindings };
}

/** Owners of record valued under the user's assumptions (prices, costs, discount), by tract share and decimal. */
export function ownerValuesUnder(l: DealLease, a: EconomicsAssumptions): Map<string, number | null> {
  const values = new Map<string, number | null>();
  if (l.ownership.status !== "matched") return values;
  const asset = economicsAssetFromLease(l);
  const unit = evaluatePrototype(asset, { ...a, interestType: "royalty", netRevenueInterest: 1 });
  const wiCache = new Map<number, number | null>();
  for (const t of l.ownership.tracts) {
    for (const o of t.owners) {
      const key = `${o.tractKey ?? o.cadLeaseNumber ?? ""}|${o.sourceRow}`;
      if (unit.status !== "calculated") { values.set(key, null); continue; }
      if (o.interestType === "royalty" || o.interestType === "overriding_royalty") values.set(key, unit.scenarios!.base.presentValue * t.productionShare * o.decimal);
      else if (o.interestType === "working_interest" && t.totals.working_interest > 0) {
        const nri = Math.min(1, t.totals.working_interest);
        if (!wiCache.has(nri)) { const w = evaluatePrototype(asset, { ...a, interestType: "working", workingInterest: 1, netRevenueInterest: nri }); wiCache.set(nri, w.status === "calculated" ? w.scenarios!.base.presentValue : null); }
        const wv = wiCache.get(nri);
        values.set(key, wv === null || wv === undefined ? null : wv * t.productionShare * (o.decimal / t.totals.working_interest));
      } else values.set(key, null);
    }
  }
  return values;
}

/**
 * The user's edits laid over each lease's starting assumptions. Unknown
 * fields and wrong types are refused, never coerced; every error names the
 * lease and the field. `edited` lists the fields that differ from the start.
 */
export function applyAssumptionEdits(deal: Deal, edits: Record<string, Record<string, unknown>>): {
  errors: string[];
  byLease: Record<string, { assumptions: EconomicsAssumptions; basis: AssumptionBasis; edited: (keyof EconomicsAssumptions)[] }>;
} {
  const errors: string[] = [];
  const byLease: Record<string, { assumptions: EconomicsAssumptions; basis: AssumptionBasis; edited: (keyof EconomicsAssumptions)[] }> = {};
  for (const k of Object.keys(edits)) if (!deal.leases.some(l => l.key === k)) errors.push(`${k} is not a lease in this package.`);
  for (const l of deal.leases) {
    const start = defaultsForLease(l, deal);
    const a = { ...start.assumptions } as Record<string, unknown>;
    const name = l.leaseName ?? `RRC ${l.district}-${l.leaseNumber}`;
    for (const [field, v] of Object.entries(edits[l.key] ?? {})) {
      if (!(field in start.assumptions)) { errors.push(`${name}: ${field} is not an assumption.`); continue; }
      const ok = field === "interestType" ? v === "royalty" || v === "working"
        : field === "askingPriceUsd" ? v === null || (typeof v === "number" && Number.isFinite(v))
        : typeof v === "number" && Number.isFinite(v);
      if (!ok) { errors.push(`${name}: ${field} has the wrong type.`); continue; }
      a[field] = v;
    }
    const assumptions = a as unknown as EconomicsAssumptions;
    for (const p of validateAssumptions(assumptions)) errors.push(`${name}: ${p}`);
    const edited = (Object.keys(start.assumptions) as (keyof EconomicsAssumptions)[]).filter(f => assumptions[f] !== start.assumptions[f]);
    byLease[l.key] = { assumptions, basis: start.basis, edited };
  }
  return { errors, byLease };
}

/**
 * Decision reasons for a summary: exact repeats dropped, per-well repeats
 * ("4232946216: <reason>") stated once with the number of wells, and the list
 * capped with a pointer to where the rest are printed in full.
 */
export function summarizeReasons(reasons: string[], max = 8, rest = "Section 12"): string[] {
  const perWell = new Map<string, { apis: Set<string>; first: string }>();
  const order: string[] = [];
  for (const r of reasons) {
    const m = r.match(/^(?:(.+?): )?(\d{10}): (.+)$/);
    const key = m ? `well|${m[1] ?? ""}|${m[3]}` : `text|${r}`;
    const g = perWell.get(key);
    if (g) { if (m) g.apis.add(m[2]); continue; }
    perWell.set(key, { apis: new Set(m ? [m[2]] : []), first: r });
    order.push(key);
  }
  const all = order.map(k => {
    const g = perWell.get(k)!;
    if (g.apis.size <= 1) return g.first;
    const m = g.first.match(/^(?:(.+?): )?(\d{10}): (.+)$/)!;
    return `${m[1] ? `${m[1]}: ` : ""}${m[3].replace(/\.$/, "")} (${g.apis.size} wells).`;
  });
  return all.length > max ? [...all.slice(0, max), `${all.length - max} further reason(s) are listed in ${rest}.`] : all;
}
