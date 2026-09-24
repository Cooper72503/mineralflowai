/**
 * The deal report: one document for one package, in the order a buyer reads
 * it — Decision; Lease and wells; Production and forecast; Ownership; Chain
 * of title; Regulatory; Evidence. Figures carry a bracketed source number
 * that resolves in the Evidence section.
 */
import React from "react";
import { Document, Page, Text, View, Link, renderToBuffer } from "@react-pdf/renderer";
import { C, S, kv, fmtUsd, ProductionChart, OwnershipSection } from "../report-builder";
import { TX_OIL_SEVERANCE, TX_GAS_SEVERANCE, AD_VALOREM, WORKOVER_USD_PER_BOE } from "../ownership/interest-value";
import { FIXED_OPERATING_FLOOR_USD_PER_WELL_MONTH } from "../economics";
import { DECISION_RULES, OFFER_POLICY, type Verdict } from "./underwriting";
import type { Deal, DealLease } from "./build";

const e = React.createElement;
const VERDICT: Record<Verdict, { bg: string; fg: string; text: string }> = {
  BUY: { bg: C.greenBg, fg: C.green, text: "BUY" }, REVIEW: { bg: C.yellowBg, fg: C.yellow, text: "REVIEW" }, PASS: { bg: C.redBg, fg: C.red, text: "PASS" },
};
const refs = (ids: string[]) => ids.length ? ` [${[...new Set(ids)].join(", ")}]` : "";
const leaseTitle = (l: DealLease) => `${l.leaseName ?? "Lease"} — RRC ${l.district}-${l.leaseNumber}`;
const num = (v: number) => Math.round(v).toLocaleString("en-US");
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

function Chrome({ deal, children }: { deal: Deal; children?: React.ReactNode }) {
  return e(Page, { size: "LETTER", style: S.page, wrap: true },
    e(View, { fixed: true, style: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 12, paddingBottom: 6, borderBottomWidth: 1, borderBottomColor: C.border } },
      e(Text, { style: { fontSize: 7, fontFamily: "Helvetica-Bold", color: C.navy } }, "MineralFlow AI — Acquisition Report"),
      e(Text, { style: { fontSize: 7, color: C.gray } }, `Package ${deal.packageId.slice(0, 8)} · ${deal.generatedAt.slice(0, 10)}`)),
    children,
    e(View, { fixed: true, style: S.footer },
      e(Text, { style: S.footerText }, "CONFIDENTIAL — Public-record screening, not a title opinion, reserve report or appraisal"),
      e(Text, { style: S.footerText, render: ({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) => `${pageNumber} / ${totalPages}` })));
}

function Badge({ verdict, large = false }: { verdict: Verdict; large?: boolean }) {
  const v = VERDICT[verdict];
  return e(Text, { style: [S.badge, { backgroundColor: v.bg, color: v.fg, fontSize: large ? 11 : 7, paddingHorizontal: large ? 10 : 6, paddingVertical: large ? 4 : 2 }] }, v.text);
}

function Th({ cols }: { cols: [string, number, ("left" | "right")?][] }) {
  return e(View, { style: S.tableHeader }, ...cols.map(([t, w, a], i) => e(Text, { key: i, style: [S.tableHeaderCell, { width: w, textAlign: a ?? "left", paddingRight: 4 }] }, t)));
}
function Tr({ i, cols }: { i: number; cols: [string, number, ("left" | "right")?, string?][] }) {
  return e(View, { style: i % 2 === 0 ? S.tableRow : S.tableRowAlt, wrap: false },
    ...cols.map(([t, w, a, color], j) => e(Text, { key: j, style: [S.tableCell, { width: w, textAlign: a ?? "left", paddingRight: 4, color: color ?? C.dark }] }, t)));
}
const Note = (t: string) => e(Text, { style: S.noteText }, t);
const Body = (t: string) => e(Text, { style: S.bodyText }, t);
const Sub = (t: string) => e(Text, { style: S.subTitle }, t);
const Section = (t: string) => e(Text, { style: [S.sectionTitle, { marginTop: 0 }] }, t);
const Flag = (t: string, tone: "red" | "yellow" | "gray", key?: string | number) =>
  e(View, { key, style: [S.flagBox, { backgroundColor: tone === "red" ? C.redBg : tone === "yellow" ? C.yellowBg : C.offWhite }], wrap: false },
    e(Text, { style: [S.flagItem, { color: tone === "red" ? C.red : tone === "yellow" ? C.yellow : C.dark }] }, t));

// ─── 1. Decision ─────────────────────────────────────────────────────────────
function DecisionSection({ deal }: { deal: Deal }) {
  const deckRef = deal.sources.find(s => s.label === "Price deck")!.id;
  const standardRef = deal.sources.find(s => s.label === "MineralFlow standard assumptions")!.id;
  const valueRefs = [deckRef, standardRef, ...deal.leases.flatMap(l => [...l.sources.production, ...l.sources.roll])];
  const wells = sum(deal.leases.map(l => l.wells.filter(w => w.onProration).length));
  return e(View, {},
    Section("1. DECISION"),
    e(View, { style: { flexDirection: "row", alignItems: "center", marginBottom: 8 } }, e(Badge, { verdict: deal.decision.verdict, large: true }),
      e(Text, { style: { fontSize: 10, fontFamily: "Helvetica-Bold", color: C.navy, marginLeft: 10, flex: 1 } }, deal.decision.reasons[0] ?? "")),
    ...deal.decision.reasons.slice(1).map((r, i) => e(Text, { key: i, style: S.bodyText }, r)),
    Body(`${deal.submitted} API${deal.submitted === 1 ? "" : "s"} submitted (${deal.distinctApis} distinct) resolve to ${deal.leases.length} producing lease${deal.leases.length === 1 ? "" : "s"}${wells ? ` carrying ${wells} well${wells === 1 ? "" : "s"} on TRRC's proration schedule` : ""}. Each lease's production is counted once, however many of its wells were submitted.${refs(deal.leases.flatMap(l => l.sources.wells))}`),

    Sub("What the leases are worth (PV-10, all owners of record)"),
    e(Th, { cols: [["Interest", 200], ["Downside", 100, "right"], ["Base", 100, "right"], ["Upside", 100, "right"]] }),
    e(Tr, { i: 0, cols: [["Royalty and overriding royalty owners", 200], [deal.totals.royaltyAndOverridePv10 ? fmtUsd(deal.totals.royaltyAndOverridePv10.stress) : "Unavailable", 100, "right"], [deal.totals.royaltyAndOverridePv10 ? fmtUsd(deal.totals.royaltyAndOverridePv10.base) : "Unavailable", 100, "right"], [deal.totals.royaltyAndOverridePv10 ? fmtUsd(deal.totals.royaltyAndOverridePv10.upside) : "Unavailable", 100, "right"]] }),
    e(Tr, { i: 1, cols: [["Working interest (8/8ths, net of all costs)", 200], [deal.totals.workingInterestPv10 ? fmtUsd(deal.totals.workingInterestPv10.stress) : "Unavailable", 100, "right"], [deal.totals.workingInterestPv10 ? fmtUsd(deal.totals.workingInterestPv10.base) : "Unavailable", 100, "right"], [deal.totals.workingInterestPv10 ? fmtUsd(deal.totals.workingInterestPv10.upside) : "Unavailable", 100, "right"]] }),
    Note(`Sources${refs(valueRefs)}. Downside and upside move prices 25% either side of the base deck.`),

    Sub("Recommended offers"),
    e(Th, { cols: [["Lease", 130], ["Verdict", 48], ["Interest", 120], ["Offer range", 120, "right"], ["Ceiling", 64, "right"]] }),
    ...deal.leases.flatMap((l, li) => l.offers.status === "calculated"
      ? l.offers.ranges.map((r, ri) => e(Tr, { key: `${li}-${ri}`, i: li, cols: [[ri === 0 ? (l.leaseName ?? l.leaseNumber) : "", 130], [ri === 0 ? l.decision.verdict : "", 48, "left", ri === 0 ? VERDICT[l.decision.verdict].fg : undefined], [r.interest === "royalty" ? "Royalty, per 0.01 decimal" : "Working interest, per 1%", 120], [`${fmtUsd(r.low)} – ${fmtUsd(r.high)}`, 120, "right"], [fmtUsd(r.ceiling), 64, "right"]] }))
      : [e(Tr, { key: `${li}`, i: li, cols: [[l.leaseName ?? l.leaseNumber, 130], [l.decision.verdict, 48, "left", VERDICT[l.decision.verdict].fg], [`Unavailable: ${l.offers.reason}`, 304]] })]),
    Note(`${OFFER_POLICY} A royalty offer for a decimal other than 0.01 scales linearly: 0.0125 is 1.25 times the figure shown. ${deal.leases[0]?.offers.perNra.reason ?? ""}${refs(valueRefs)}`),

    ...deal.leases.map((l, i) => e(View, { key: i, wrap: false, style: { marginTop: 6 } },
      e(View, { style: { flexDirection: "row", alignItems: "center", marginBottom: 3 } }, e(Badge, { verdict: l.decision.verdict }), e(Text, { style: { fontSize: 8.5, fontFamily: "Helvetica-Bold", marginLeft: 6 } }, leaseTitle(l))),
      ...l.decision.reasons.map((r, j) => e(Text, { key: `r${j}`, style: S.flagItem }, `• ${r}`)),
      l.decision.risks.length ? e(Text, { style: [S.flagLabel, { color: C.gray, marginTop: 3 }] }, "TOP RISKS") : null,
      ...l.decision.risks.map((r, j) => e(Text, { key: `k${j}`, style: [S.flagItem, { color: r.severity === 3 ? C.red : r.severity === 2 ? C.yellow : C.dark }] }, `• ${r.text}`)),
      e(Text, { style: [S.flagLabel, { color: C.gray, marginTop: 3 }] }, "CONDITIONS"),
      ...l.decision.conditions.map((c, j) => e(Text, { key: `c${j}`, style: S.flagItem }, `• ${c}`)))),

    deal.excluded.length ? e(View, { style: { marginTop: 6 } }, Sub("Submitted APIs not in the valuation"), ...deal.excluded.map((x, i) => e(Text, { key: i, style: S.flagItem }, `• ${x.input}: ${x.reason}`))) : null,

    Sub("Underwriting — MineralFlow standard assumptions (each may be overridden)"),
    ...[
      `Prices: ${deal.deckLabel}${deal.deck.source === "user_input" ? " (override)" : ""}. [${deckRef}]`,
      `Production taxes: Texas statutory severance, ${(TX_OIL_SEVERANCE * 100).toFixed(1)}% of oil value and ${(TX_GAS_SEVERANCE * 100).toFixed(1)}% of gas value; ad valorem ${(AD_VALOREM * 100).toFixed(0)}% of revenue. [${standardRef}]`,
      `Operating cost: ${deal.overrides.loeUsdPerBoe ? `$${deal.overrides.loeUsdPerBoe.toFixed(2)}/BOE (override)` : "the basin midpoint for each lease (Section 3)"}, a $${WORKOVER_USD_PER_BOE}/BOE workover reserve, and at least $${num(FIXED_OPERATING_FLOOR_USD_PER_WELL_MONTH)} per producing well per month. [${standardRef}]`,
      `Forecast: Arps decline fit to reported lease production, switching to 8% a year exponential decline, run to the month the operator's cash flow stops being positive (40-year cap). Royalty income ends there too. [${standardRef}]`,
      "Discounting: PV-10 and PV-15, monthly. Royalty and overrides bear production taxes only; the working interest bears all costs.",
      ...DECISION_RULES,
    ].map((t, i) => e(Text, { key: i, style: S.flagItem }, `• ${t}`)),
  );
}

// ─── 2. Lease and wells ──────────────────────────────────────────────────────
function LeaseSection({ deal }: { deal: Deal }) {
  return e(View, {}, Section("2. LEASE AND WELLS"),
    ...deal.leases.map((l, i) => e(View, { key: i, style: { marginBottom: 10 } },
      Sub(leaseTitle(l)),
      kv("Lease type", `${l.leaseType === "O" ? "Oil" : "Gas"} lease, district ${l.district}${refs(l.sources.wells)}`),
      kv("Field", l.field), kv("County", l.county), kv("Operator", `${l.operator ?? "—"}${l.operatorNo ? ` (P-5 ${l.operatorNo})` : ""}`),
      kv("Submitted APIs", `${l.apis.length}${refs(l.sources.wells)}`),
      kv("Producing wells", `${l.producingWells}. ${l.producingWellsBasis}${refs(l.sources.wells)}`),
      kv("Basin classification", l.basin ? `${l.basin.name}: operating cost $${l.basin.loeRange[0]}–$${l.basin.loeRange[1]}/BOE, midpoint $${l.basin.loeMidpoint.toFixed(2)} used` : "Unclassified; the generic operating cost is used"),
      e(Th, { cols: [["API", 90], ["Well", 50], ["Proration status", 150], ["Forms", 70], ["Submitted", 60]] }),
      ...l.wells.map((w, j) => e(Tr, { key: j, i: j, cols: [[`${w.api10.slice(0, 2)}-${w.api10.slice(2, 5)}-${w.api10.slice(5)}`, 90], [w.wellNo ?? "—", 50], [w.onProration ? (w.status ?? "—") : "Not on the oil proration schedule", 150, "left", w.status && /SHUT/i.test(w.status) ? C.yellow : undefined], [w.formsLacking ? "Lacking" : w.onProration ? "Complete" : "—", 70, "left", w.formsLacking ? C.red : undefined], [w.inPackage ? "Yes" : "No", 60]] })),
      Note(`Wells from TRRC's oil proration schedule for the lease, plus any submitted API not carried on it.${refs(l.sources.wells)}`))));
}

// ─── 3. Production and forecast ──────────────────────────────────────────────
function ProductionSection({ deal }: { deal: Deal }) {
  return e(View, {}, Section("3. PRODUCTION AND FORECAST"),
    ...deal.leases.map((l, i) => {
      const recent = l.production.slice(-36);
      const v = l.valuation, f = l.fit, p = refs(l.sources.production);
      const years = v.baseForecast ? [0, 1, 2, 3, 4].map(y => ({ y: y + 1, oil: sum(v.baseForecast!.oilBbl.slice(y * 12, y * 12 + 12)), gas: sum(v.baseForecast!.gasMcf.slice(y * 12, y * 12 + 12)) })) : [];
      const gasOf = (r: typeof l.production[number]) => (r.gas_mcf ?? 0) + (r.casinghead_gas_mcf ?? 0);
      const chartRows = recent.map(r => ({ ...r, gas_mcf: r.gas_mcf === null && r.casinghead_gas_mcf === null ? null : gasOf(r) }));
      return e(View, { key: i, style: { marginBottom: 10 } },
        Sub(leaseTitle(l)),
        e(View, { style: { flexDirection: "row", marginBottom: 6 } },
          e(ProductionChart, { months: chartRows, metricKey: "oil_bbl", title: "Oil, last 36 months", unit: "bbl/month", color: C.navy }),
          e(ProductionChart, { months: chartRows, metricKey: "gas_mcf", title: "Gas incl. casinghead, last 36 months", unit: "mcf/month", color: C.accent })),
        kv("Reported history", `${l.production.length} months through ${l.lastReportedMonth ?? "—"}${l.trailingUnreportedMonths ? `; ${l.trailingUnreportedMonths} later month(s) not yet reported` : ""}${p}`),
        kv("Cumulative (reported window)", `${num(sum(l.production.map(r => r.oil_bbl ?? 0)))} bbl oil, ${num(sum(l.production.map(gasOf)))} mcf gas${p}`),
        f ? kv(`Decline fit (${l.fitPhase})`, `qi ${num(f.qi)}/month, initial decline ${f.diAnnualPct.toFixed(1)}%/yr, b ${f.b.toFixed(2)}, R² ${f.rSquared.toFixed(2)}; current decline ${f.currentAnnualDeclinePct.toFixed(1)}%/yr (${f.classification})${p}`) : kv("Decline fit", "Unavailable: fewer than six contiguous reported months."),
        l.fitWindowNote ? Note(l.fitWindowNote) : null,
        v.status === "valued"
          ? kv("Remaining to economic limit", `${num(v.remainingOilBbl ?? 0)} bbl oil, ${num(v.remainingGasMcf ?? 0)} mcf gas; ${v.economicLimitMonths!.base} months at base prices (${v.economicLimitMonths!.stress} downside, ${v.economicLimitMonths!.upside} upside)${v.economicLimitAtHorizonCap ? ", still economic at the 40-year cap" : ""}${p}`)
          : kv("Remaining to economic limit", `Unavailable: ${v.reason}`),
        years.length ? e(View, { style: { marginTop: 4 } },
          e(Th, { cols: [["Forecast year (base)", 120], ["Oil, bbl", 100, "right"], ["Gas, mcf", 100, "right"]] }),
          ...years.map((y, j) => e(Tr, { key: j, i: j, cols: [[`Year ${y.y}`, 120], [num(y.oil), 100, "right"], [num(y.gas), 100, "right"]] }))) : null,
        e(View, { style: { marginTop: 6 } },
          e(Th, { cols: [["Month", 80], ["Oil, bbl", 90, "right"], ["Gas, mcf", 90, "right"], ["Casinghead, mcf", 90, "right"], ["Water, bbl", 90, "right"]] }),
          ...l.production.slice(-24).reverse().map((r, j) => e(Tr, { key: j, i: j, cols: [[r.production_month, 80], [r.oil_bbl === null ? "Not reported" : num(r.oil_bbl), 90, "right"], [r.gas_mcf === null ? "—" : num(r.gas_mcf), 90, "right"], [r.casinghead_gas_mcf === null ? "—" : num(r.casinghead_gas_mcf), 90, "right"], [r.water_bbl === null ? "Not reported" : num(r.water_bbl), 90, "right"]] }))),
        Note(`Lease-level volumes as reported to TRRC; each month counted once across the submitted wells. A blank month is not a zero.${p}`));
    }));
}

// ─── 4. Ownership ────────────────────────────────────────────────────────────
function OwnershipBlock({ deal }: { deal: Deal }) {
  return e(View, {}, Section("4. OWNERSHIP"),
    ...deal.leases.map((l, i) => e(View, { key: i, style: { marginBottom: 10 } },
      Sub(`${leaseTitle(l)}${refs([...l.sources.roll, ...l.sources.production, deal.sources.find(s => s.label === "Price deck")!.id])}`),
      e(OwnershipSection, { ownership: l.ownership, valuation: l.valuation, trrcLeaseName: l.leaseName, repeatHeader: i === deal.leases.length - 1 }))));
}

// ─── 5. Chain of title ───────────────────────────────────────────────────────
function TitleBlock({ deal }: { deal: Deal }) {
  return e(View, {}, Section("5. CHAIN OF TITLE"),
    Note("From county clerk records at the courthouse. Parties are as indexed by the clerk. \"Read\" instruments were extracted from the recorded image; \"Index\" rows are clerk index entries whose images were not read. This is evidence of the record, not a title opinion; ownership fractions are never inferred from it."),
    ...deal.leases.map((l, i) => {
      const t = l.title.analysis;
      if (!t) return e(View, { key: i, style: { marginBottom: 8 } }, Sub(leaseTitle(l)), Flag(`Unavailable: ${l.title.reason}`, "yellow"));
      const clerk = t.searchCoverage.filter(c => c.provider.startsWith("county:"));
      const latest = new Map<string, typeof clerk[number]>(); for (const q of clerk) latest.set(`${q.queryType}|${q.queryValue}`, q);
      const ran = [...latest.values()].filter(q => q.status !== "skipped_bounded").sort((a, b) => (b.resultCount ?? 0) - (a.resultCount ?? 0));
      const tracts = t.tracts.filter(x => x.matchStatus === "confirmed").map(x => x.tractLabel);
      return e(View, { key: i, style: { marginBottom: 10 } },
        Sub(`${leaseTitle(l)}${refs(l.sources.title)}`),
        kv("Tracts", tracts.join("; ") || "No confirmed tract"),
        kv("Recordings", `${l.title.indexedInstruments} on the tract; ${l.title.readInstruments} read from the recorded image${refs(l.sources.title)}`),
        kv("Assessment", `${t.statusDisplay} (analysis v${t.version}, ${t.generatedAt.slice(0, 10)})`),
        e(Th, { cols: [["Recorded", 58], ["Instrument", 92], ["Grantor  >  Grantee", 238], ["Evidence", 40], ["Reference", 82]] }),
        ...t.chronology.map((r, j) => {
          const cite = r.citations.find(c => c.sourceUrl) ?? r.citations[0];
          const ref = [r.recordingReference ?? cite?.label ?? "", r.contentVerified && cite?.page ? `p. ${cite.page}` : ""].filter(Boolean).join(" | ");
          const parties = `${r.fromParties.map(p => p.displayName).join("; ") || "—"}  >  ${r.toParties.map(p => p.displayName).join("; ") || "—"}`;
          return e(View, { key: j, style: j % 2 === 0 ? S.tableRow : S.tableRowAlt, wrap: false },
            e(Text, { style: [S.tableCell, { width: 58 }] }, r.recordedDate ?? r.executionDate ?? "—"),
            e(Text, { style: [S.tableCell, { width: 92 }] }, r.clerkDocType ?? String(r.instrumentType).replace(/_/g, " ")),
            e(Text, { style: [S.tableCell, { width: 238, paddingRight: 4 }] }, parties),
            e(Text, { style: [S.tableCell, { width: 40, color: r.contentVerified ? C.green : C.gray, fontFamily: r.contentVerified ? "Helvetica-Bold" : "Helvetica" }] }, r.contentVerified ? "Read" : "Index"),
            r.contentVerified && cite?.sourceUrl ? e(Link, { src: cite.sourceUrl, style: [S.tableCell, { width: 82, color: C.link }] }, ref || "Source") : e(Text, { style: [S.tableCell, { width: 82 }] }, ref || "—"));
        }),
        t.chronology.length === 0 ? Note("No recorded instruments are linked to a confirmed tract.") : null,
        Sub("County clerk searches"),
        ...ran.slice(0, 20).map((q, j) => e(Text, { key: `q${j}`, style: S.flagItem }, `• ${q.queryType.replace(/_/g, " ")}: "${q.queryValue}" — ${q.status.replace(/_/g, " ")}, ${q.resultCount ?? 0} hit(s)`)),
        ran.length > 20 ? Note(`${ran.length - 20} further searches are held in the title record.`) : null,
        ...t.limitations.map((x, j) => e(Text, { key: `l${j}`, style: S.noteText }, `Limitation: ${x}`)));
    }));
}

// ─── 6. Regulatory ───────────────────────────────────────────────────────────
function RegulatoryBlock({ deal }: { deal: Deal }) {
  return e(View, {}, Section("6. REGULATORY"),
    ...deal.leases.map((l, i) => e(View, { key: i, style: { marginBottom: 8 } },
      Sub(`${leaseTitle(l)}${refs(l.sources.wells)}`),
      ...l.regulatory.critical.map((f, j) => Flag(`Critical: ${f}`, "red", `c${j}`)),
      ...l.regulatory.important.map((f, j) => Flag(`Important: ${f}`, "yellow", `m${j}`)),
      ...(l.regulatory.important.some(f => /FORMS LACKING/i.test(f)) ? [] : l.wells.filter(w => w.formsLacking).map((w, j) => Flag(`Well ${w.wellNo ?? w.api10}: forms lacking on the proration schedule.`, "yellow", `f${j}`))),
      !l.regulatory.critical.length && !l.regulatory.important.length && !l.wells.some(w => w.formsLacking)
        ? Body("No critical or important regulatory flags across the submitted wells' TRRC records (well status, compliance, plugging, orphan list, injection, permits).") : null)));
}

// ─── 7. Evidence ─────────────────────────────────────────────────────────────
function EvidenceBlock({ deal }: { deal: Deal }) {
  return e(View, {}, Section("7. EVIDENCE"),
    Note("Every bracketed number in this report refers to a source below. Figures not drawn from a public record are MineralFlow standard assumptions, listed in Section 1."),
    ...deal.sources.map((s, i) => e(View, { key: i, style: { marginBottom: 5 }, wrap: false },
      e(Text, { style: { fontSize: 8, fontFamily: "Helvetica-Bold" } }, `[${s.id}] ${s.label}`),
      e(Text, { style: S.flagItem }, `${s.detail}${s.retrievedAt ? `. Retrieved ${s.retrievedAt.slice(0, 16).replace("T", " ")} UTC` : ""}.`),
      s.url ? e(Link, { src: s.url, style: S.trrcLink }, s.url) : null)),
    Sub("Scope of this report"),
    ...[
      "Owners and decimals are as carried by the county appraisal district, which takes them from operator division orders. They are evidence of current ownership, not a title opinion. Owner mailing addresses are held in the dataset and not printed.",
      "The chain of title reports county clerk records. An index entry proves a recording exists; only instruments marked Read were extracted from the recorded image.",
      "Forecasts are screening decline fits to reported lease production, not certified reserves. Values are screening values, not an appraisal or fairness opinion.",
      `Retrieval runs: ${deal.leases.flatMap(l => l.runIds).map(r => r.slice(0, 8)).join(", ") || "none"}.`,
    ].map((t, i) => e(Text, { key: i, style: S.flagItem }, `• ${t}`)));
}

const SECTIONS = [DecisionSection, LeaseSection, ProductionSection, OwnershipBlock, TitleBlock, RegulatoryBlock, EvidenceBlock];

// Each section is its own page run. A page break requested from inside a
// nested view sent react-pdf into an unbounded layout loop (heap exhaustion
// on the 25-instrument Buttercup chain), so sections never request breaks.
export async function renderDealPdf(deal: Deal): Promise<Buffer> {
  const sections = SECTIONS;
  const doc = e(Document, { title: `MineralFlow Acquisition Report ${deal.packageId.slice(0, 8)}`, author: "MineralFlow AI" },
    ...sections.map((Sec, i) => e(Chrome, { key: i, deal }, e(Sec, { deal }))));
  return renderToBuffer(doc as never);
}
