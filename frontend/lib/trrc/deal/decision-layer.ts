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
  return defaultAssumptions({
    oilPriceUsdBbl: deal.deck.scenarios.base.oilUsdBbl, gasPriceUsdMcf: deal.deck.scenarios.base.gasUsdMcf, priceBasis: deal.deckLabel,
    fieldName: l.field, county: l.county,
    operatorNri: v.leaseNri && v.leaseNriBasis && !/No working-interest/.test(v.leaseNriBasis) ? round4(v.leaseNri) : null,
    operatorNriBasis: v.leaseNri && v.leaseNriBasis && !/No working-interest/.test(v.leaseNriBasis) ? `Appraisal roll working-interest decimal (${round4(v.leaseNri)})` : null,
  });
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

export function entryAnalysis(e: EconomicsResult): EntryAnalysis | null {
  if (e.status !== "calculated" || !e.scenarios) return null;
  const a = e.assumptions, s = e.scenarios;
  const ceiling = s.base.presentValue;
  const high = pvAt(s.base.monthlyNet, a.discountRatePct + 5);
  const low = Math.min(s.downside.presentValue, high);
  let irr: number | null = null, payout: number | null = null, multiple: number | null = null;
  let position: EntryAnalysis["position"] = "no asking price";
  if (a.askingPriceUsd) {
    irr = irrAnnualPct([-a.askingPriceUsd, ...s.base.monthlyNet]);
    let cum = -a.askingPriceUsd;
    payout = null;
    for (let i = 0; i < s.base.monthlyNet.length; i++) { cum += s.base.monthlyNet[i]; if (cum >= 0) { payout = i + 1; break; } }
    multiple = s.base.undiscountedNet / a.askingPriceUsd;
    position = a.askingPriceUsd > ceiling ? "above ceiling" : a.askingPriceUsd > high ? "above range, under ceiling" : a.askingPriceUsd < low ? "below range" : "within range";
  }
  return { hurdlePct: a.discountRatePct, ceiling, rangeLow: low, rangeHigh: high, askingPriceUsd: a.askingPriceUsd, askingIrrPct: irr, askingPayoutMonths: payout, askingMultiple: multiple, position };
}

export function exitAnalysis(e: EconomicsResult, entry: EntryAnalysis | null): ExitAnalysis | null {
  if (e.status !== "calculated" || !e.scenarios || !entry) return null;
  const a = e.assumptions;
  const months = Math.round(a.holdYears * 12);
  const basis = a.askingPriceUsd ?? entry.rangeHigh;
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
  return { holdYears: a.holdYears, entryBasisUsd: basis, entryBasisLabel: a.askingPriceUsd ? "asking price" : "top of the recommended range", byScenario: out };
}

/** Everything the record found that does not agree, or that it could not establish. */
export function reconcile(l: DealLease, e: EconomicsResult): { contradictions: Finding[]; missing: Finding[] } {
  const contradictions: Finding[] = [], missing: Finding[] = [];
  const src = l.sources;
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
  if (l.trailingUnreportedMonths >= 3) missing.push({ kind: "missing", severity: 2, text: `${l.trailingUnreportedMonths} recent months have no reported production.`, sources: src.production });
  missing.push({ kind: "missing", severity: 1, text: "A title opinion and the seller's division order are required before closing; the chain here is evidence of the record.", sources: [] });
  if (!e.assumptions.askingPriceUsd) missing.push({ kind: "missing", severity: 1, text: "No asking price entered: IRR, payout and the entry position are not calculated.", sources: [] });
  return { contradictions, missing };
}

export function decideLeaseRecord(l: DealLease, e: EconomicsResult): LeaseDecisionRecord {
  const { contradictions, missing } = reconcile(l, e);
  const entry = entryAnalysis(e);
  const exit = exitAnalysis(e, entry);
  const pass: string[] = [], review: string[] = [], conditions: string[] = [], risks: Risk[] = [];
  const s = e.scenarios;
  if (e.status !== "calculated") review.push(`Economics not calculated: ${e.reason}`);
  else if (s && s.base.lifeMonths < 12) pass.push(`Base-case life is ${s.base.lifeMonths} months at the stated costs.`);
  else if (s && s.base.presentValue <= 0) pass.push(`The interest has no positive value at base prices under these assumptions (${s.base.presentValue < 0 ? "−" : ""}$${Math.abs(Math.round(s.base.presentValue)).toLocaleString("en-US")} at ${e.assumptions.discountRatePct}%).`);
  if (entry?.position === "above ceiling") pass.push(`Asking price $${Math.round(entry.askingPriceUsd!).toLocaleString("en-US")} is above the walk-away ceiling of $${Math.round(entry.ceiling).toLocaleString("en-US")} at a ${entry.hurdlePct}% hurdle.`);
  if (!l.fit) review.push("No decline curve could be fit to the reported production.");
  else if (l.fit.rSquared < 0.6) review.push(`The decline fit explains little of the history (R-squared ${l.fit.rSquared.toFixed(2)}).`);
  for (const f of l.regulatory.critical) review.push(`Regulatory: ${f}`);
  for (const c of contradictions.filter(c => c.severity === 3)) review.push(c.text);
  for (const m of missing.filter(m => m.severity === 3)) conditions.push(m.text);
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
  const reasons = verdict === "PASS" ? pass : verdict === "REVIEW" ? review : [
    entry?.askingPriceUsd
      ? `Asking price $${Math.round(entry.askingPriceUsd).toLocaleString("en-US")} is ${entry.position} ($${Math.round(entry.rangeLow).toLocaleString("en-US")}–$${Math.round(entry.rangeHigh).toLocaleString("en-US")}, ceiling $${Math.round(entry.ceiling).toLocaleString("en-US")}).`
      : `Buy within $${Math.round(entry!.rangeLow).toLocaleString("en-US")}–$${Math.round(entry!.rangeHigh).toLocaleString("en-US")}; walk away above $${Math.round(entry!.ceiling).toLocaleString("en-US")}.`,
    `Valued from ${l.production.length} months of reported lease production with a decline fit of R-squared ${l.fit!.rSquared.toFixed(2)}.`,
  ];
  return { leaseKey: l.key, leaseName: l.leaseName ?? `RRC ${l.district}-${l.leaseNumber}`, verdict, reasons, conditions: [...new Set(conditions)], risks: risks.slice(0, 8), contradictions, missing, economics: e, entry, exit };
}

/** The whole package: one record per lease under that lease's assumptions. */
export function assembleDecision(deal: Deal, assumptionsByLease: Record<string, EconomicsAssumptions>): DealDecisionRecord {
  const leases = deal.leases.map(l => {
    const a = assumptionsByLease[l.key] ?? defaultsForLease(l, deal).assumptions;
    return decideLeaseRecord(l, evaluatePrototype(economicsAssetFromLease(l), a));
  });
  const dealFindings: Finding[] = deal.excluded.map(x => ({ kind: "missing", severity: 2, text: `${x.input}: ${x.reason}`, sources: [] }));
  const buy = leases.filter(l => l.verdict === "BUY"), review = leases.filter(l => l.verdict === "REVIEW"), pass = leases.filter(l => l.verdict === "PASS");
  const verdict: Verdict = buy.length ? "BUY" : review.length || !leases.length ? "REVIEW" : "PASS";
  const reasons = !leases.length ? ["No submitted API reconciled to a producing lease."]
    : verdict === "BUY" ? [`Buy ${buy.map(l => l.leaseName).join(", ")}.`, ...(review.length ? [`Hold ${review.map(l => l.leaseName).join(", ")} for review.`] : []), ...(pass.length ? [`Pass on ${pass.map(l => l.leaseName).join(", ")}.`] : [])]
    : leases.flatMap(l => l.reasons.map(r => `${l.leaseName}: ${r}`));
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
      const key = `${o.cadLeaseNumber ?? ""}|${o.sourceRow}`;
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
