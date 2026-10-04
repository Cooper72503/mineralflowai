/**
 * The Decision Record: the PDF behind "Generate Decision Record".
 *
 * Thirteen sections, in the order a buyer reads them, rendered from the same
 * deal evidence and the same decision layer the page shows, under the
 * assumptions the user set. Every figure carries a bracketed source number
 * that resolves in the appendix; assumptions carry their basis.
 */
import React from "react";
import { oilSensitivity, SENSITIVITY_DISCLOSURE } from "./oil-sensitivity";
import path from "node:path";
import { Document, Page, Text, View, Link, Font, renderToBuffer } from "@react-pdf/renderer";
import { C, S as baseStyles, fmtUsd, fmtDec, TYPE_LABEL, ProductionChart } from "../report-builder";
import type { Deal, DealLease } from "./build";
import type { DealDecisionRecord, LeaseDecisionRecord, Finding } from "./decision-layer";
import { ownerValuesUnder, summarizeReasons } from "./decision-layer";
import type { AssumptionBasis, EconomicsAssumptions } from "../economics-provider";
import type { Verdict } from "./underwriting";

import { formatShare } from "../title/report";
import { scenarioScope, scenarioStatus } from "./report-scope";

const e = React.createElement;
// Reuse the repository's licensed GOLD fonts. Embed them so the viewer does
// not substitute Helvetica with incompatible character metrics.
const fontDir = path.join(process.cwd(), "lib", "trrc", "gold", "fonts");
Font.register({ family: "DecisionSans", fonts: [
  { src: path.join(fontDir, "NimbusSans-Regular.otf"), fontWeight: 400 },
  { src: path.join(fontDir, "NimbusSans-Bold.otf"), fontWeight: 700 },
] });
const S = Object.fromEntries(Object.entries(baseStyles).map(([key, value]) => [key, {
  ...value,
  ...("fontFamily" in value ? { fontFamily: "DecisionSans", fontWeight: value.fontFamily === "Helvetica-Bold" ? 700 : 400 } : {}),
}])) as typeof baseStyles;
function kv(label: string, value: string | null | undefined) {
  return e(View, { style: S.kvRow }, e(Text, { style: S.kvLabel }, label), e(Text, { style: S.kvValue }, value ?? "Unavailable"));
}
const VERDICT: Record<Verdict, { bg: string; fg: string }> = { BUY: { bg: C.greenBg, fg: C.green }, REVIEW: { bg: C.yellowBg, fg: C.yellow }, PASS: { bg: C.redBg, fg: C.red } };
const refs = (ids: string[]) => ids.length ? ` [${[...new Set(ids)].join(", ")}]` : "";
const num = (v: number) => Math.round(v).toLocaleString("en-US");
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const pct = (v: number | null | undefined, d = 1) => v === null || v === undefined || !Number.isFinite(v) ? "Not calculated" : `${v.toFixed(d)}%`;
const leaseTitle = (l: DealLease) => `${l.leaseName ?? "Lease"} — RRC ${l.district}-${l.leaseNumber}`;
const api = (a: string) => `${a.slice(0, 2)}-${a.slice(2, 5)}-${a.slice(5)}`;

export interface DecisionRecordInput {
  deal: Deal;
  record: DealDecisionRecord;
  basisByLease: Record<string, AssumptionBasis>;
  /** Assumption fields the user changed from the starting values. */
  editedByLease: Record<string, (keyof EconomicsAssumptions)[]>;
}

function Chrome({ deal, children }: { deal: Deal; children?: React.ReactNode }) {
  return e(Page, { size: "LETTER", style: S.page, wrap: true },
    e(View, { fixed: true, style: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 12, paddingBottom: 6, borderBottomWidth: 1, borderBottomColor: C.border } },
      e(Text, { style: { fontSize: 7, fontFamily: "DecisionSans", fontWeight: 700, color: C.navy } }, "MineralFlow AI — Decision Record"),
      e(Text, { style: { fontSize: 7, color: C.gray } }, `Package ${deal.packageId.slice(0, 8)} · ${deal.generatedAt.slice(0, 10)}`)),
    children,
    e(View, { fixed: true, style: S.footer },
      e(Text, { style: S.footerText }, "CONFIDENTIAL — Public-record screening, not a title opinion, reserve report or appraisal"),
      e(Text, { style: S.footerText, render: ({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) => `${pageNumber} / ${totalPages}` })));
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
const Sub = (t: string) => e(Text, { style: S.subTitle, minPresenceAhead: 50 }, t);
const Section = (t: string) => e(Text, { style: [S.sectionTitle, { marginTop: 0 }], minPresenceAhead: 65 }, t);
const Bullet = (t: string, key: string | number, color: string = C.dark) => e(Text, { key, style: [S.flagItem, { color }] }, `• ${t}`);
const sevColor = (s: 1 | 2 | 3) => s === 3 ? C.red : s === 2 ? C.yellow : C.dark;
function Badge({ verdict, large = false }: { verdict: Verdict; large?: boolean }) {
  const v = VERDICT[verdict];
  return e(Text, { style: [S.badge, { backgroundColor: v.bg, color: v.fg, fontSize: large ? 11 : 7, paddingHorizontal: large ? 10 : 6, paddingVertical: large ? 4 : 2 }] }, verdict);
}
const deckRef = (deal: Deal) => deal.sources.find(s => s.label === "Price deck")?.id ?? "";
const stdRef = (deal: Deal) => deal.sources.find(s => s.label === "MineralFlow standard assumptions")?.id ?? "";
const leaseRec = (inp: DecisionRecordInput, l: DealLease) => inp.record.leases.find(r => r.leaseKey === l.key)!;

// 1 ─────────────────────────────────────────────────────────────────────────
function Executive({ inp }: { inp: DecisionRecordInput }) {
  const { deal, record } = inp;
  return e(View, {}, Section("1. EXECUTIVE DECISION SUMMARY"),
    e(View, { style: { flexDirection: "row", alignItems: "center", marginBottom: 8 } }, e(Badge, { verdict: record.verdict, large: true }),
      e(Text, { style: { fontSize: 10, fontFamily: "DecisionSans", fontWeight: 700, color: C.navy, marginLeft: 10, flex: 1 } }, summarizeReasons(record.reasons)[0] ?? "")),
    ...summarizeReasons(record.reasons, 3).slice(1).map((r, i) => e(Text, { key: i, style: S.bodyText }, r)),
    ...record.leases.map((r, i) => {
      const l = deal.leases.find(x => x.key === r.leaseKey)!;
      const s = r.economics.scenarios, a = r.economics.assumptions;
      // The block may break across pages; a long reason list must never be cut off or leave a blank page.
      return e(View, { key: i, style: { marginTop: 8, borderTopWidth: 0.5, borderTopColor: C.border, paddingTop: 6 } },
        e(View, { wrap: false, minPresenceAhead: 60, style: { flexDirection: "row", alignItems: "center", marginBottom: 4 } }, e(Badge, { verdict: r.verdict }), e(Text, { style: { fontSize: 9, fontFamily: "DecisionSans", fontWeight: 700, marginLeft: 6 } }, leaseTitle(l))),
        ...summarizeReasons(r.reasons, 3).map((t, j) => Bullet(t, `r${j}`)),
        Note(scenarioScope(a, l.lastReportedMonth)),
        kv("Interest evaluated", `${a.interestType === "royalty" ? "Royalty" : "Working interest"}, ${a.netRevenueInterest} revenue decimal${a.interestType === "working" ? `, ${a.workingInterest} working interest` : ""}`),
        s ? kv(`Conditional value at ${a.discountRatePct}%`, `${fmtUsd(s.downside.presentValue)} downside  |  ${fmtUsd(s.base.presentValue)} base  |  ${fmtUsd(s.upside.presentValue)} upside${refs([deckRef(deal), stdRef(deal), ...l.sources.production])}`) : kv("Value", `Not calculated: ${r.economics.reason}`),
        r.entry ? kv("Entry", `Range ${fmtUsd(r.entry.rangeLow)} – ${fmtUsd(r.entry.rangeHigh)}; walk-away ceiling ${fmtUsd(r.entry.ceiling)}${r.entry.askingPriceUsd ? `; asking ${fmtUsd(r.entry.askingPriceUsd)} is ${r.entry.position}` : ""}`) : null,
        r.exit ? kv(`Exit after ${r.exit.holdYears} years`, `${r.exit.byScenario.base.multiple?.toFixed(2) ?? "—"}x, IRR ${pct(r.exit.byScenario.base.irrPct)} at base prices from the ${r.exit.entryBasisLabel}`) : null,
        r.risks.length ? e(Text, { style: [S.flagLabel, { color: C.gray, marginTop: 3 }] }, "TOP RISKS") : null,
        ...r.risks.slice(0, 5).map((k, j) => Bullet(k.text, `k${j}`, sevColor(k.severity))),
        e(Text, { style: [S.flagLabel, { color: C.gray, marginTop: 3 }] }, "CONDITIONS"),
        ...summarizeReasons(r.conditions, 3).map((c, j) => Bullet(c, `c${j}`)));
    }));
}

// 2 ─────────────────────────────────────────────────────────────────────────
function Overview({ inp }: { inp: DecisionRecordInput }) {
  const { deal } = inp;
  const rows = [
    ...deal.leases.flatMap(l => l.members.map(m => ({ input: m.input, api: m.api ?? "", lease: `${l.leaseName ?? ""} (${l.district}-${l.leaseNumber})`, operator: l.operator ?? "—", county: l.county ?? "—", status: l.wells.find(w => w.api10 === m.api)?.status ?? (l.wells.find(w => w.api10 === m.api)?.onProration === false ? "Not on proration schedule" : "—"), included: scenarioStatus(inp.record.leases.find(r => r.leaseKey === l.key)) }))),
    ...deal.excluded.map(x => ({ input: x.input, api: x.api ?? "", lease: "—", operator: "—", county: "—", status: "—", included: `Excluded: ${x.reason}` })),
  ];
  return e(View, {}, Section("2. ASSET AND API OVERVIEW"),
    Body(`${deal.submitted} API numbers submitted (${deal.distinctApis} distinct). ${deal.leases.length} resolved lease${deal.leases.length === 1 ? "" : "s"} identified; each lease's production is counted once however many of its wells were submitted.${refs(deal.leases.flatMap(l => l.sources.wells))}`),
    Note("Scope is the submitted API list. This report does not establish that the list includes every asset offered by a seller."),
    e(Th, { cols: [["API", 72], ["Lease", 150], ["Operator", 100], ["County", 50], ["Proration status", 70], ["Scenario status", 90]] }),
    ...rows.map((r, i) => e(Tr, { key: i, i, cols: [[r.input, 72], [r.lease, 150], [r.operator, 100], [r.county, 50], [r.status, 70, "left", /SHUT/i.test(r.status) ? C.yellow : undefined], [r.included, 90, "left", r.included.startsWith("Excluded") ? C.red : undefined]] })));
}

// 3 ─────────────────────────────────────────────────────────────────────────
function Identity({ inp }: { inp: DecisionRecordInput }) {
  return e(View, {}, Section("3. WELL AND LEASE IDENTITY"),
    Note("Each API was resolved through TRRC's wellbore query to one well, district and lease. A well carried on more than one lease with none current, or a query TRRC did not answer, is excluded rather than attached to a guess."),
    ...inp.deal.leases.map((l, i) => e(View, { key: i, style: { marginBottom: 10 } },
      Sub(leaseTitle(l)),
      kv("Lease type", `${l.leaseType === "O" ? "Oil" : "Gas"} lease, district ${l.district}${refs(l.sources.wells)}`),
      kv("Field", l.field), kv("County", l.county), kv("Operator", `${l.operator ?? "—"}${l.operatorNo ? ` (P-5 ${l.operatorNo})` : ""}${refs(l.sources.wells)}`),
      kv("Producing wells", `${l.producingWellsBasis}${refs(l.sources.wells)}`),
      e(Th, { cols: [["API", 90], ["Well", 50], ["Proration status", 160], ["Forms", 70], ["Submitted", 60]] }),
      ...l.wells.map((w, j) => e(Tr, { key: j, i: j, cols: [[api(w.api10), 90], [w.wellNo ?? "—", 50], [w.onProration ? (w.status ?? "—") : "Not on the oil proration schedule", 160, "left", w.status && /SHUT/i.test(w.status) ? C.yellow : undefined], [w.formsLacking ? "Lacking" : w.onProration ? "Complete" : "—", 70, "left", w.formsLacking ? C.red : undefined], [w.inPackage ? "Yes" : "No", 60]] })))));
}

// 4 ─────────────────────────────────────────────────────────────────────────
function Production({ inp, only }: { inp: DecisionRecordInput; only: number }) {
  const l = inp.deal.leases[only];
  const p = refs(l.sources.production);
  const gasOf = (r: typeof l.production[number]) => (r.gas_mcf ?? 0) + (r.casinghead_gas_mcf ?? 0);
  const chartRows = l.production.slice(-36).map(r => ({ ...r, gas_mcf: r.gas_mcf === null && r.casinghead_gas_mcf === null ? null : gasOf(r) }));
  return e(View, {},
    only === 0 ? Section("4. PRODUCTION") : null,
    Sub(leaseTitle(l)),
    e(View, { style: { flexDirection: "row", marginBottom: 6 } },
      e(ProductionChart, { months: chartRows, metricKey: "oil_bbl", title: "Oil, last 36 months", unit: "bbl/month", color: C.navy }),
      e(ProductionChart, { months: chartRows, metricKey: "gas_mcf", title: "Gas incl. casinghead, last 36 months", unit: "mcf/month", color: C.accent })),
    kv("Reported history", `${l.production.length} months through ${l.lastReportedMonth ?? "—"}${l.trailingUnreportedMonths ? `; ${l.trailingUnreportedMonths} later month(s) not yet reported` : ""}${p}`),
    kv("Cumulative (reported window)", `${num(sum(l.production.map(r => r.oil_bbl ?? 0)))} bbl oil, ${num(sum(l.production.map(gasOf)))} mcf gas${p}`),
    e(View, { style: { marginTop: 6 } },
      e(Th, { cols: [["Month", 80], ["Oil, bbl", 90, "right"], ["Gas, mcf", 90, "right"], ["Casinghead, mcf", 90, "right"], ["Water, bbl", 90, "right"]] }),
      ...l.production.slice(-24).reverse().map((r, j) => e(Tr, { key: j, i: j, cols: [[r.production_month, 80], [r.oil_bbl === null ? "Not reported" : num(r.oil_bbl), 90, "right"], [r.gas_mcf === null ? "—" : num(r.gas_mcf), 90, "right"], [r.casinghead_gas_mcf === null ? "—" : num(r.casinghead_gas_mcf), 90, "right"], [r.water_bbl === null ? "Not reported" : num(r.water_bbl), 90, "right"]] }))),
    Note(`Lease-level volumes as reported to TRRC; each month counted once across the submitted wells. A blank month is not a zero. Well-level allocation is not attempted.${p}`));
}

// 5 ─────────────────────────────────────────────────────────────────────────
const SOURCE_LABEL: Record<string, string> = {
  search_by_api: "Wellbore query", fetch_well_status: "Well status (fallback)", fetch_production: "Production Data Query", fetch_p4_records: "P-4 gatherer/purchaser",
  fetch_severance_records: "Severance", fetch_oil_proration: "Oil proration schedule", fetch_completion_records: "Completions (W-2/G-1)", fetch_plugging_records: "Plugging status (GIS well layer)",
  fetch_orphan_well: "Orphan well list", fetch_injection_records: "Injection (H-10)", fetch_drilling_permits: "Drilling permits (W-1)", fetch_gis_plat: "GIS location and survey",
  fetch_coda_records: "Imaged well documents", search_by_operator: "Operator (P-5)", fetch_compliance_violations: "Compliance violations (RRC OIL)", fetch_county_records: "County records check", fetch_inactive_well_status: "Inactive well report",
};
function Regulatory({ inp }: { inp: DecisionRecordInput }) {
  return e(View, {}, Section("5. RRC AND REGULATORY DILIGENCE"),
    ...inp.deal.leases.map((l, i) => e(View, { key: i, style: { marginBottom: 10 } },
      Sub(`${leaseTitle(l)}${refs(l.sources.wells)}`),
      ...l.regulatory.critical.map((f, j) => Bullet(`Critical: ${f}`, `c${j}`, C.red)),
      ...l.regulatory.important.map((f, j) => Bullet(`Important: ${f}`, `m${j}`, C.yellow)),
      !l.regulatory.critical.length && !l.regulatory.important.length ? Body(l.regulatory.coverage?.length && l.regulatory.coverage.every(c => c.status === "verified") ? "No critical or important flags identified in the verified sources." : "Regulatory clearance is not established. Limited or unavailable checks are listed below; no flagged finding does not mean a clean result.") : null,
      ...(l.regulatory.coverage ?? []).filter(c => c.status !== "verified").map((c, j) => Bullet(`${c.api}: ${c.status.toUpperCase()} — ${c.reason} [${c.sourceId}]`, `gap${j}`, c.status === "unavailable" ? C.red : C.yellow)),
      e(Th, { cols: [["TRRC source", 170], ["Retrieved", 70, "right"], ["Last failure", 250]] }),
      ...l.coverage.map((c, j) => e(Tr, { key: j, i: j, cols: [[SOURCE_LABEL[c.source] ?? c.source, 170], [`${c.retrieved} of ${c.wells}`, 70, "right", c.retrieved < c.wells ? C.yellow : undefined], [c.retrieved < c.wells ? (c.lastError ?? "").slice(0, 90) : "—", 250]] })),
      Note("Compliance violations are searched by each well's API in TRRC's RRC OIL system (records from August 1, 2015). Plugging status comes from TRRC's GIS well layer; the online W-3 query is retired, so no W-3 certificate is asserted either way."))));
}

// 6 ─────────────────────────────────────────────────────────────────────────
function Title({ inp, only }: { inp: DecisionRecordInput; only: number }) {
  const l = inp.deal.leases[only];
  const r = leaseRec(inp, l);
  const t = l.title.analysis;
  const values = ownerValuesUnder(l, r.economics.assumptions);
  const clerk = t ? t.searchCoverage.filter(c => c.provider.startsWith("county:")) : [];
  const latest = new Map<string, typeof clerk[number]>(); for (const q of clerk) latest.set(`${q.queryType}|${q.queryValue}`, q);
  const ran = [...latest.values()].filter(q => q.status !== "skipped_bounded");
  return e(View, {},
    only === 0 ? Section("6. TITLE AND OWNERSHIP") : null,
    only === 0 ? Note("Title research is assembled from county clerk records; a chronology alone does not establish continuous ownership. \"Read\" instruments were extracted from the recorded image and cite their page; \"Index\" rows are the clerk's index entries. This is evidence of the record, not a title opinion; ownership fractions are never inferred from the chain.") : null,
    Sub(`${leaseTitle(l)} — title evidence and branches${refs(l.sources.title)}`),
    t ? e(View, {},
      kv("Tracts", t.tracts.filter(x => x.matchStatus === "confirmed").map(x => x.tractLabel).join("; ") || "No confirmed tract"),
      kv("Recordings", `${l.title.indexedInstruments} on the tract; ${l.title.readInstruments} read from the recorded image${refs(l.sources.title)}`),
      kv("Assessment", `${t.statusDisplay} (analysis v${t.version}, ${t.generatedAt.slice(0, 10)})`),
      Sub("Tract / interest branches"),
      Note("Earliest and apparent holders below are the graph's evidence states, not certified owners. Unsupported or partial transitions remain open; an earliest/root record does not prove earlier title."),
      ...(t.branches ?? []).map((b, j) => e(View, { key: `branch${j}`, style: { marginBottom: 8 } },
        Body(`${b.tractLabel} — ${b.interestType.replace(/_/g, " ")}`),
        Note(`Earliest evidenced: ${b.earliestEvidencedHolders.map(p => p.displayName).join("; ") || "Not established"}. Apparent holders: ${b.apparentHolders.map(h => `${h.parties.map(p => p.displayName).join(" & ")} (${h.status.replace(/_/g, " ")}; ${formatShare(h)})`).join("; ") || "Not established"}.`),
        Note(`${b.events.length} events; ${b.events.filter(e => e.support === "unsupported" || e.support === "partial" || e.support === "not_evaluated").length} unsupported, partial or unevaluated transitions; ${b.unresolvedAllocations.length} unresolved allocations.`))),
      Sub("Recording chronology"),
      Note("A recording may appear in several tract/interest branches. Each row identifies its branch and event support; Read means extracted text, not accepted ownership."),
      e(Th, { cols: [["Recorded", 58], ["Instrument", 104], ["Grantor  >  Grantee", 226], ["Evidence", 40], ["Reference", 82]] }),
      ...t.chronology.map((row, j) => {
        const cite = row.citations.find(c => c.sourceUrl) ?? row.citations[0];
        const ref = [row.recordingReference ?? cite?.label ?? "", row.contentVerified && cite?.page ? `p. ${cite.page}` : ""].filter(Boolean).join(" | ");
        const event = (t.branches ?? []).flatMap(b => b.events).find(ev => ev.eventId === row.rowId);
        const context = `${row.tractLabel} | ${row.interestType.replace(/_/g, " ")} | ${row.effect.replace(/_/g, " ")} | ${event?.support ?? "support not established"}`;
        return e(View, { key: j, style: j % 2 === 0 ? S.tableRow : S.tableRowAlt, wrap: false },
          e(Text, { style: [S.tableCell, { width: 58 }] }, row.recordedDate ?? row.executionDate ?? "—"),
          e(Text, { style: [S.tableCell, { width: 104, paddingRight: 4 }] }, row.clerkDocType ?? String(row.instrumentType).replace(/_/g, " ")),
          e(Text, { style: [S.tableCell, { width: 226, paddingRight: 4 }] }, `${context}\n${row.fromParties.map(p => p.displayName).join("; ") || "—"}  >  ${row.toParties.map(p => p.displayName).join("; ") || "—"}${row.fraction ? `  (interest stated: ${row.fraction})` : ""}`),
          e(Text, { style: [S.tableCell, { width: 40, color: row.contentVerified ? C.green : C.gray, fontFamily: "DecisionSans", fontWeight: row.contentVerified ? 700 : 400 }] }, row.contentVerified ? "Read" : "Index"),
          row.contentVerified && cite?.sourceUrl ? e(Link, { src: cite.sourceUrl, style: [S.tableCell, { width: 82, color: C.link }] }, ref || "Source") : e(Text, { style: [S.tableCell, { width: 82 }] }, ref || "—"));
      }),
      Note(`County clerk searches run: ${ran.length}; ${ran.filter(q => q.status === "success").length} returned recordings.`),
      ...t.limitations.map((x, j) => e(Text, { key: `l${j}`, style: S.noteText }, `Limitation: ${x}`)))
      : Bullet(`No chain of title: ${l.title.reason}`, "nt", C.yellow),
    Sub(`${leaseTitle(l)} — appraisal-roll cross-check${refs(l.sources.roll)}`),
    l.ownership.status === "matched"
      ? e(View, {},
          Note(`Owners and decimals as carried by the ${l.ownership.sources.map(s => `${s.county} County appraisal roll, tax year ${s.taxYear}`).join("; ")}. An appraisal roll does not establish legal title or the seller’s conveyable interest. Values are PV at ${r.economics.assumptions.discountRatePct}% under this record's assumptions. Mailing addresses are not printed.`),
          e(Th, { cols: [["Owner", 220], ["Interest", 90], ["Decimal", 80, "right"], ["Value (base)", 90, "right"]] }),
          ...l.ownership.tracts.flatMap(tr => tr.owners).map((o, j) => {
            const v = values.get(`${o.tractKey ?? o.cadLeaseNumber ?? ""}|${o.sourceRow}`);
            return e(Tr, { key: j, i: j, cols: [[o.ownerName, 220], [TYPE_LABEL[o.interestType], 90], [fmtDec(o.decimal), 80, "right"], [v === null || v === undefined ? "—" : fmtUsd(v), 90, "right"]] });
          }))
      : Bullet(`Appraisal-roll cross-check unavailable: ${(l.ownership.reason ?? "no roll matched").replace(/\.+$/, "")}. This is separate from the clerk-document ownership analysis above. The economics use the stated assumption; no seller interest is established by that assumption.`, "no", C.yellow));
}

// 7 ─────────────────────────────────────────────────────────────────────────
function Forecast({ inp }: { inp: DecisionRecordInput }) {
  return e(View, {}, Section("7. FORECAST"),
    ...inp.record.leases.map((r, i) => {
      const l = inp.deal.leases.find(x => x.key === r.leaseKey)!;
      const f = r.economics.forecast, s = r.economics.scenarios, p = refs(l.sources.production);
      return e(View, { key: i, style: { marginBottom: 10 } },
        Sub(leaseTitle(l)),
        Note(`Forecast origin: the month after the last reported production month (${l.lastReportedMonth ?? "unavailable"}). Values are conditional at that origin, not automatically rolled forward to the report date.${p}`),
        f.fit ? kv(`Decline fit (${f.phase})`, `qi ${num(f.fit.qi)}/month, initial decline ${f.fit.diAnnualPct.toFixed(1)}%/yr, b ${f.fit.b.toFixed(2)}, R² ${f.fit.rSquared.toFixed(2)}; current decline ${f.fit.currentAnnualDeclinePct.toFixed(1)}%/yr${p}`) : kv("Decline fit", "Unavailable"),
        s ? kv("Remaining (gross, base)", `${num(f.remainingGrossOilBbl)} bbl oil, ${num(f.remainingGrossGasMcf)} mcf gas over ${s.base.lifeMonths} months${s.base.atHorizonCap ? " (still economic at the 40-year cap)" : ""}`) : null,
        s ? kv("Economic life", `${s.downside.lifeMonths} months downside  |  ${s.base.lifeMonths} base  |  ${s.upside.lifeMonths} upside`) : null,
        s ? e(View, { style: { marginTop: 4 } },
          e(Th, { cols: [["Year (base)", 80], ["Gross oil, bbl", 110, "right"], ["Gross gas, mcf", 110, "right"]] }),
          ...s.base.annual.slice(0, 10).map((y, j) => e(Tr, { key: j, i: j, cols: [[`Year ${y.year}`, 80], [num(y.grossOilBbl), 110, "right"], [num(y.grossGasMcf), 110, "right"]] }))) : null,
        ...r.economics.disclosures.map((d, j) => e(Text, { key: `d${j}`, style: S.noteText }, d)));
    }));
}

// 8 ─────────────────────────────────────────────────────────────────────────
const ASSUMPTION_ROWS: [keyof EconomicsAssumptions, string, (v: unknown) => string][] = [
  ["oilPriceUsdBbl", "Oil price", v => `$${Number(v).toFixed(2)}/bbl`], ["gasPriceUsdMcf", "Gas price", v => `$${Number(v).toFixed(2)}/mcf`],
  ["gasDifferentialUsdMcf", "Gas differential (e.g. Waha)", v => `$${Number(v).toFixed(2)}/mcf`], ["nglYieldBblPerMmcf", "NGL yield", v => `${Number(v)} bbl/MMcf`], ["nglPriceUsdBbl", "NGL price", v => `$${Number(v).toFixed(2)}/bbl`],
  ["discountRatePct", "Discount rate", v => `${Number(v)}%`], ["oilSeverancePct", "Oil severance tax", v => `${Number(v)}%`], ["gasSeverancePct", "Gas severance tax", v => `${Number(v)}%`], ["adValoremPct", "Ad valorem tax", v => `${Number(v)}%`],
  ["loeUsdPerBoe", "Operating cost", v => `$${Number(v).toFixed(2)}/BOE`], ["fixedOpexUsdPerWellMonth", "Fixed cost per producing well", v => `$${num(Number(v))}/month`], ["workoverUsdPerBoe", "Workover reserve", v => `$${Number(v).toFixed(2)}/BOE`],
  ["interestType", "Interest type", v => v === "royalty" ? "Royalty" : "Working interest"], ["netRevenueInterest", "Net revenue interest", v => String(v)], ["workingInterest", "Working interest", v => String(v)],
  ["operatorNri", "Operator revenue share (economic limit)", v => String(v)], ["downsidePricePct", "Downside price change", v => `${Number(v)}%`], ["upsidePricePct", "Upside price change", v => `+${Number(v)}%`],
  ["holdYears", "Hold period", v => `${Number(v)} years`], ["askingPriceUsd", "Asking price", v => v === null ? "Not entered" : fmtUsd(Number(v))],
];
const ROYALTY_NOTE: Partial<Record<keyof EconomicsAssumptions, string>> = {
  loeUsdPerBoe: ". Not charged to a royalty; sets when the operator stops producing",
  fixedOpexUsdPerWellMonth: ". Not charged to a royalty; sets when the operator stops producing",
  workoverUsdPerBoe: ". Not charged to a royalty",
};
function Assumptions({ inp }: { inp: DecisionRecordInput }) {
  return e(View, {}, Section("8. SCENARIO ASSUMPTIONS"),
    Note("Every input to the economics, with its source. Values the user changed are marked. Downside and upside apply the stated price changes to oil, gas and NGL; costs are held."),
    ...inp.record.leases.map((r, i) => {
      const a = r.economics.assumptions, basis = inp.basisByLease[r.leaseKey], edited = new Set(inp.editedByLease[r.leaseKey] ?? []);
      const s = r.economics.scenarios;
      return e(View, { key: i, style: { marginBottom: 10 } },
        Sub(r.leaseName),
        Note(scenarioScope(a, r.economics.asset.lastReportedMonth)),
        e(Th, { cols: [["Assumption", 160], ["Value", 100], ["Basis", 260]] }),
        ...ASSUMPTION_ROWS.filter(([k]) => a.interestType === "working" || k !== "workingInterest").map(([k, label, fmt], j) => e(Tr, { key: j, i: j, cols: [[label, 160], [fmt(a[k]), 100], [edited.has(k) ? `Entered by user${a.interestType === "royalty" ? ROYALTY_NOTE[k] ?? "" : ""}` : `${basis?.[k] ?? "—"}${a.interestType === "royalty" ? ROYALTY_NOTE[k] ?? "" : ""}`, 260, "left", edited.has(k) ? C.accent : undefined]] })),
        s ? e(View, { style: { marginTop: 6 } },
          e(Th, { cols: [["Case", 100], ["Oil", 100, "right"], ["Gas", 100, "right"]] }),
          ...(["downside", "base", "upside"] as const).map((k, j) => e(Tr, { key: k, i: j, cols: [[k[0].toUpperCase() + k.slice(1), 100], [`$${s[k].oilPriceUsdBbl.toFixed(2)}/bbl`, 100, "right"], [`$${s[k].gasPriceUsdMcf.toFixed(2)}/mcf`, 100, "right"]] }))) : null);
    }),
    Note(`Price source: ${inp.deal.deckLabel}.${refs([deckRef(inp.deal), stdRef(inp.deal)])}`));
}

// 9 ─────────────────────────────────────────────────────────────────────────
function Economics({ inp }: { inp: DecisionRecordInput }) {
  const { deal } = inp;
  return e(View, {}, Section("9. ECONOMICS"),
    ...inp.record.leases.map((r, i) => {
      const s = r.economics.scenarios, a = r.economics.assumptions;
      const l = deal.leases.find(x => x.key === r.leaseKey)!;
      if (!s) return e(View, { key: i }, Sub(r.leaseName), Bullet(`Not calculated: ${r.economics.reason}`, "x", C.yellow));
      return e(View, { key: i, style: { marginBottom: 10 } },
        Sub(`${r.leaseName}${refs([deckRef(deal), stdRef(deal), ...l.sources.production])}`),
        Note(scenarioScope(a, l.lastReportedMonth)),
        kv("Provider", `${r.economics.provider.name} (EconomicsProvider "${r.economics.provider.id}", v${r.economics.provider.version})`),
        e(Th, { cols: [["", 150], ["Downside", 110, "right"], ["Base", 110, "right"], ["Upside", 110, "right"]] }),
        ...([
          [`Present value at ${a.discountRatePct}%`, (k: "downside" | "base" | "upside") => fmtUsd(s[k].presentValue)],
          ["Undiscounted net cash flow", (k: "downside" | "base" | "upside") => fmtUsd(s[k].undiscountedNet)],
          ["Net oil to the interest, bbl", (k: "downside" | "base" | "upside") => num(s[k].netOilBbl)],
          ["Net gas to the interest, mcf", (k: "downside" | "base" | "upside") => num(s[k].netGasMcf)],
          ["Economic life, months", (k: "downside" | "base" | "upside") => String(s[k].lifeMonths)],
        ] as const).map(([label, f], j) => e(Tr, { key: j, i: j, cols: [[label, 150], [f("downside"), 110, "right"], [f("base"), 110, "right"], [f("upside"), 110, "right"]] })),
        e(Text, { style: [S.subTitle, { marginTop: 8 }] }, "Base case by year"),
        e(Th, { cols: [["Year", 50], ["Revenue", 100, "right"], ["Taxes", 90, "right"], ["Costs", 90, "right"], ["Net cash flow", 100, "right"]] }),
        ...s.base.annual.slice(0, 10).map((y, j) => e(Tr, { key: j, i: j, cols: [[String(y.year), 50], [fmtUsd(y.revenue), 100, "right"], [fmtUsd(y.taxes), 90, "right"], [fmtUsd(y.costs), 90, "right"], [fmtUsd(y.net), 100, "right"]] })),
        s.base.annual.length > 10 ? Note(`Years 11–${s.base.annual.length}: ${fmtUsd(sum(s.base.annual.slice(10).map(y => y.net)))} further net cash flow.`) : null);
    }));
}

function OilSensitivity({ inp, only }: { inp: DecisionRecordInput; only: number }) {
  const l = inp.deal.leases[only], r = leaseRec(inp, l), a = r.economics.assumptions;
  const rows = oilSensitivity(r.economics.asset, a);
  return e(View, {}, Section("9. ECONOMICS — OIL PRICE SENSITIVITY"),
    Sub(`${leaseTitle(l)}${refs([...l.sources.production, stdRef(inp.deal)])}`),
    Note(scenarioScope(a, l.lastReportedMonth)),
    kv("Operator / location", `${l.operator ?? "Unavailable"} / ${l.county ?? "Unavailable"} County`),
    kv("Selected costs", `LOE $${a.loeUsdPerBoe}/BOE; fixed $${a.fixedOpexUsdPerWellMonth}/producing well/month; workover $${a.workoverUsdPerBoe}/BOE`),
    kv("Interest / hold / hurdle", `${a.interestType}; NRI ${a.netRevenueInterest}; WI ${a.workingInterest}; ${a.holdYears} years; ${a.discountRatePct}%`),
    Note("Costs use the location benchmark or user inputs disclosed in Section 8. No operator-specific actual expense is asserted. Lower/higher cost presets are illustrative ±20% sensitivities. Royalty interests bear no direct operating costs; costs affect the operator's economic limit."),
    Note(SENSITIVITY_DISCLOSURE),
    e(Th, { cols: [["Oil $/bbl", 55], ["Year 1 net", 90, "right"], ["Entry ceiling", 95, "right"], ["Hold cash", 90, "right"], ["Exit value", 95, "right"], ["IRR at asking", 65, "right"]] }),
    ...rows.map((row, i) => e(Tr, { key: i, i, cols: [[String(row.oilPriceUsdBbl), 55],
      ...([['annualNet',90],['ceiling',95],['holdCash',90],['exitValue',95]] as const).map(([k,w]): [string, number, "right"] => [row[k] === null ? "Unavailable" : fmtUsd(row[k]!), w, "right"]), [a.askingPriceUsd ? pct(row.irrPct) : "No asking price",65,"right"]] })),
    ...[...new Set(rows.map(row => row.reason).filter(Boolean))].map((reason, i) => Bullet(`Unavailable: ${reason}`, i, C.yellow)),
    Note("Conditional scenario results do not clear title gaps or authorize an acquisition. Entry/exit formulas and return basis are described in Sections 10–11."));
}

// 10 ────────────────────────────────────────────────────────────────────────
function Entry({ inp }: { inp: DecisionRecordInput }) {
  return e(View, {}, Section("10. MINERALFLOW ENTRY ANALYSIS"),
    Note("Recommended range: from the downside-case value to the base-case value at a hurdle 5 points above the discount rate. Walk-away ceiling: the base-case value at the discount rate. With an asking price, the IRR, payout and multiple are on the base-case cash flows."),
    ...inp.record.leases.map((r, i) => {
      const x = r.entry;
      if (!x) return e(View, { key: i }, Sub(r.leaseName), Bullet("Not calculated: the economics are unavailable.", "x", C.yellow));
      return e(View, { key: i, style: { marginBottom: 10 } }, Sub(r.leaseName),
        Note(scenarioScope(r.economics.assumptions, r.economics.asset.lastReportedMonth)),
        kv("Hurdle (discount rate)", `${x.hurdlePct}%`),
        kv("Recommended range", `${fmtUsd(x.rangeLow)} – ${fmtUsd(x.rangeHigh)}`),
        kv("Walk-away ceiling", fmtUsd(x.ceiling)),
        kv("Asking price", x.askingPriceUsd ? `${fmtUsd(x.askingPriceUsd)} (${x.position})` : "Not entered"),
        x.askingPriceUsd ? kv("IRR at asking", pct(x.askingIrrPct)) : null,
        x.askingPriceUsd ? kv("Payout", x.askingPayoutMonths ? `${x.askingPayoutMonths} months` : "Not within the forecast") : null,
        x.askingPriceUsd ? kv("Life multiple", x.askingMultiple ? `${x.askingMultiple.toFixed(2)}x undiscounted` : "—") : null);
    }));
}

// 11 ────────────────────────────────────────────────────────────────────────
function Exit({ inp }: { inp: DecisionRecordInput }) {
  return e(View, {}, Section("11. MINERALFLOW EXIT ANALYSIS"),
    Note("Hold for the stated period, then sell the remaining cash flow to a buyer at the same hurdle. Total = cash received in the hold + the exit value. Multiple and IRR are on the entry basis shown."),
    ...inp.record.leases.map((r, i) => {
      const x = r.exit;
      if (!x) return e(View, { key: i }, Sub(r.leaseName), Bullet("Not calculated: the economics are unavailable.", "x", C.yellow));
      return e(View, { key: i, style: { marginBottom: 10 } }, Sub(`${r.leaseName} — ${x.holdYears}-year hold from the ${x.entryBasisLabel} (${fmtUsd(x.entryBasisUsd)})`),
        e(Th, { cols: [["", 150], ["Downside", 110, "right"], ["Base", 110, "right"], ["Upside", 110, "right"]] }),
        ...([
          ["Cash received in the hold", (k: "downside" | "base" | "upside") => fmtUsd(x.byScenario[k].holdCash)],
          ["Exit value", (k: "downside" | "base" | "upside") => fmtUsd(x.byScenario[k].exitValue)],
          ["Total", (k: "downside" | "base" | "upside") => fmtUsd(x.byScenario[k].total)],
          ["Multiple", (k: "downside" | "base" | "upside") => x.byScenario[k].multiple === null ? "—" : `${x.byScenario[k].multiple!.toFixed(2)}x`],
          ["IRR", (k: "downside" | "base" | "upside") => pct(x.byScenario[k].irrPct)],
        ] as const).map(([label, f], j) => e(Tr, { key: j, i: j, cols: [[label, 150], [f("downside"), 110, "right"], [f("base"), 110, "right"], [f("upside"), 110, "right"]] })));
    }));
}

// 12 ────────────────────────────────────────────────────────────────────────
function Risks({ inp }: { inp: DecisionRecordInput }) {
  const list = (title: string, items: Finding[], key: string) => items.length ? e(View, { key },
    e(Text, { style: [S.flagLabel, { color: C.gray, marginTop: 4 }] }, title),
    ...items.map((f, j) => Bullet(`${f.text}${refs(f.sources)}`, `${key}${j}`, sevColor(f.severity)))) : null;
  return e(View, {}, Section("12. RISKS, CONTRADICTIONS AND MISSING DILIGENCE"),
    ...inp.record.leases.map((r: LeaseDecisionRecord, i) => e(View, { key: i, style: { marginBottom: 10 } }, Sub(r.leaseName),
      r.risks.length ? e(Text, { style: [S.flagLabel, { color: C.gray }] }, "RISKS") : null,
      ...r.risks.map((k, j) => Bullet(k.text, `r${j}`, sevColor(k.severity))),
      list("CONTRADICTIONS IN THE RECORD", r.contradictions, "c"),
      list("MISSING DILIGENCE", r.missing, "m"))),
    list("PACKAGE EVIDENCE AND EXCLUDED INPUTS", inp.record.dealFindings, "d"));
}

// 13 ────────────────────────────────────────────────────────────────────────
function Appendix({ inp }: { inp: DecisionRecordInput }) {
  const { deal } = inp;
  return e(View, {}, Section("13. SOURCE AND EVIDENCE APPENDIX"),
    Note("Every bracketed number in this record refers to a source below."),
    ...deal.sources.map((s, i) => e(View, { key: i, style: { marginBottom: 5 }, wrap: false },
      e(Text, { style: { fontSize: 8, fontFamily: "DecisionSans", fontWeight: 700 } }, `[${s.id}] ${s.label}`),
      e(Text, { style: S.flagItem }, `${s.detail.replace(/\.+$/, "")}${s.retrievedAt ? `. Retrieved ${s.retrievedAt.slice(0, 16).replace("T", " ")} UTC` : ""}.`),
      s.url ? e(Link, { src: s.url, style: S.trrcLink }, s.url) : null)),
    Sub("Economics provider"),
    ...[...new Set(inp.record.leases.map(r => `${r.economics.provider.name} (id "${r.economics.provider.id}", version ${r.economics.provider.version}). Supplied through MineralFlow's EconomicsProvider interface; a partner forecast and economics plug in at the same point.`))].map((t, i) => Bullet(t, `p${i}`)),
    Sub("Scope"),
    ...[
      "Production is lease-level as reported to TRRC; well-level allocation is not attempted.",
      "The chain of title reports county clerk records; only instruments marked Read were extracted from the recorded image. It is not a title opinion.",
      "Owner decimals, where shown, are reported by the appraisal district and require verification against conveyances and division orders.",
      "Forecasts are screening decline fits, not certified reserves; values are screening values, not an appraisal.",
      `Retrieval runs: ${deal.leases.flatMap(l => l.runIds).map(r => r.slice(0, 8)).join(", ") || "none"}.`,
    ].map((t, i) => Bullet(t, `s${i}`)));
}

export async function renderDecisionRecordPdf(inp: DecisionRecordInput): Promise<Buffer> {
  const { deal } = inp;
  const one = (C2: (p: { inp: DecisionRecordInput }) => React.ReactElement, key: string) => e(Chrome, { key, deal }, e(C2, { inp }));
  const perLease = (C2: (p: { inp: DecisionRecordInput; only: number }) => React.ReactElement, key: string) =>
    deal.leases.map((_, i) => e(Chrome, { key: `${key}${i}`, deal }, e(C2, { inp, only: i })));
  const doc = e(Document, { title: `MineralFlow Decision Record ${deal.packageId.slice(0, 8)}`, author: "MineralFlow AI" },
    one(Executive, "1"), one(Overview, "2"), one(Identity, "3"), ...perLease(Production, "4"), one(Regulatory, "5"), ...perLease(Title, "6"),
    one(Forecast, "7"), one(Assumptions, "8"), one(Economics, "9"), ...perLease(OilSensitivity, "9s"), e(Chrome, { key: "10-11", deal }, e(Entry, { inp }), e(View, { style: { marginTop: 18 } }, e(Exit, { inp }))), one(Risks, "12"), one(Appendix, "13"));
  return renderToBuffer(doc as never);
}
