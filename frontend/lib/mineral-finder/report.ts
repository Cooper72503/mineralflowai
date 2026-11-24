import React from "react";
import {
  Document,
  Page,
  Text,
  View,
  Link,
  Font,
  StyleSheet,
  renderToBuffer,
} from "@react-pdf/renderer";
import path from "node:path";
import type { FinderResult, Prospect } from "./types";
import { rozOf } from "./roz";
import { describeRoz, rozCitation } from "../geology/san-andres-roz";
import { buildReservoirStudy, type ReservoirStudy } from "../geology/reservoir-study";
import { reservoirsForField } from "../geology/reservoirs";
import { bigNumber, studyText } from "../geology/study-text";
import { DOCUMENTS } from "../geology/evidence/registry";
const e = React.createElement;
const fontDir = path.join(process.cwd(), "lib", "trrc", "gold", "fonts");
Font.register({
  family: "FinderSans",
  fonts: [
    { src: path.join(fontDir, "NimbusSans-Regular.otf"), fontWeight: 400 },
    { src: path.join(fontDir, "NimbusSans-Bold.otf"), fontWeight: 700 },
  ],
});
const styles = StyleSheet.create({
  page: {
    padding: 40,
    paddingBottom: 55,
    height: 792,
    fontSize: 9,
    fontFamily: "FinderSans",
    color: "#172b42",
    lineHeight: 1.5,
  },
  brand: { fontSize: 9, color: "#167a90", marginBottom: 15 },
  title: { fontSize: 23, fontWeight: 700, marginBottom: 8 },
  h2: { fontSize: 13, fontWeight: 700, marginTop: 16, marginBottom: 7 },
  body: { marginBottom: 6 },
  note: {
    backgroundColor: "#edf4f8",
    padding: 12,
    marginVertical: 10,
    fontSize: 9,
  },
  row: {
    paddingVertical: 8,
    borderBottomWidth: 0.5,
    borderBottomColor: "#cfdae4",
  },
  footer: {
    position: "absolute",
    top: 750,
    height: 20,
    left: 40,
    right: 40,
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 0.5,
    borderTopColor: "#cfdae4",
    paddingTop: 6,
  },
});
const t = (text: string, style: any = styles.body) => e(Text, { style }, text);

const small = { fontSize: 7.5, color: "#61758a", marginBottom: 3 };
const bold = { fontWeight: 700, marginBottom: 2 };
const TONE = { green: "#167a3a", yellow: "#9a6a00", red: "#b42318" } as const;

/** A reservoir volumetric study as PDF content: the result, or exactly which measurements are missing. */
export function studySection(s: ReservoirStudy, full = false): React.ReactElement[] {
  const x = studyText(s);
  return [
    t("Reservoir volumetric study", styles.h2),
    t(s.reservoir.name, { fontSize: 11, fontWeight: 700, marginBottom: 3 }),
    t(x.status.label, { ...bold, color: TONE[x.status.tone] }),
    ...x.results.map((r) => t(`${r.label}: low ${r.low === null ? "—" : bigNumber(r.low)}  |  central ${bigNumber(r.central)}  |  high ${r.high === null ? "—" : bigNumber(r.high)} ${r.unit}`, bold)),
    ...(x.perAcre ? [t(x.perAcre)] : []),
    ...x.stopped.map((line) => t(line, { color: TONE.red, marginBottom: 4 })),
    t(`Equations: ${x.equations.join("   |   ")}`, { fontSize: 8, marginBottom: 4 }),
    ...x.flags.map((f) => t(f, small)),
    t("Measurements used", { ...bold, marginTop: 6 }),
    ...(x.inputs.length ? x.inputs.flatMap((i) => [t(`${i.label}: ${i.value}`), t(`${i.applies}. ${i.source}`, small), ...i.notes.map((n) => t(`- ${n}`, small))]) : [t("No measurement in the registered sources applies to this reservoir at its own scope.")]),
    ...(x.missing.length ? [t("Missing measurements", { ...bold, marginTop: 6, color: TONE.red }), ...x.missing.flatMap((m) => [t(m.label, bold), t(m.detail), t(`Needed: ${m.needed}.`, small)])] : []),
    t("Depletion and recovery", { ...bold, marginTop: 6 }),
    t(x.production, small),
    ...x.engineering.map((l) => t(`${l.label}: ${l.text}`, l.ok ? {} : { color: "#61758a" })),
    t(`Recovery process examined: ${x.processBasis}`, small),
    ...(x.interpretations.length ? [t("Engineering interpretation", { ...bold, marginTop: 6 }), ...x.interpretations.flatMap((i) => [t(i.text), t(i.basis.join("; "), small)])] : []),
    ...(full ? [
      ...(x.notUsed.length ? [t("Found but not used", { ...bold, marginTop: 6 }), ...x.notUsed.flatMap((u) => [t(`${u.label}: ${u.value} — ${u.reason}`), t(`${u.applies}. ${u.source}`, small)])] : []),
      ...(x.comparisons.length ? [t("Published comparison", { ...bold, marginTop: 6 }), ...x.comparisons.flatMap((c) => [t(`${c.label}: ${c.value}. ${c.note}`), t(c.source, small)])] : []),
      ...(x.calibrations.length ? [t("Calibrations held for this reservoir's log analysis", { ...bold, marginTop: 6 }), ...x.calibrations.flatMap((c) => [t(c.name, bold), t(c.expression, { fontSize: 8 }), t(c.sources, small), ...c.limitations.map((l) => t(`- ${l}`, small))])] : []),
      ...(x.context.length ? [t("Reservoir context", { ...bold, marginTop: 6 }), ...x.context.map((c) => t(`${c.text} (${c.source})`))] : []),
    ] : [t(`Full study: /mineral-finder/reservoir/${s.reservoir.id}`, small)]),
    t(x.reproducibility, { ...small, marginTop: 4 }),
  ];
}

/** The standalone reservoir study PDF, with its source documents listed. */
export async function renderReservoirStudyPdf(s: ReservoirStudy): Promise<Buffer> {
  const docs = DOCUMENTS.filter((d) => JSON.stringify(s).includes(`"${d.id}"`));
  const footer = e(View, { fixed: true, style: styles.footer },
    t("MineralFlow volumetric study | Published measurements only - professional review required", { fontSize: 7, color: "#61758a" }),
    e(Text, { style: { fontSize: 7, color: "#61758a", width: 35, height: 12, textAlign: "right" }, render: ({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}` }));
  return renderToBuffer(e(Document, { title: `MineralFlow volumetric study - ${s.reservoir.name}`, author: "MineralFlow AI" },
    e(Page, { size: "LETTER", wrap: true, style: styles.page },
      t("MINERALFLOW AI / RESERVOIR VOLUMETRIC STUDY", styles.brand),
      t(s.reservoir.name, styles.title),
      t(`${s.reservoir.county} County, Texas | ${s.reservoir.formation} | ${s.reservoir.interval}. ${s.reservoir.description}`),
      t("Inputs are only measurements published for this reservoir at its own scope; regional averages are never substituted. Oil in place is not recoverable oil and not reserves.", styles.note),
      ...studySection(s, true),
      t("Source documents", styles.h2),
      ...docs.flatMap((d) => [t(`${d.authors}, ${d.published ?? "n.d."}. ${d.title}. ${d.publisher}${d.reportNumber ? `, ${d.reportNumber}` : ""}.`), t(`File ${d.fileName}; SHA-256 ${d.sha256}; ${d.pdfPages} pages; ${d.textLayer ? "text layer re-checked by machine" : "scanned, values transcribed from page images"}. ${d.rights}`, small)]),
      footer)) as never);
}

/** Published San Andres ROZ context for the lead's field; context only, never scored. */
function rozSection(p: Prospect) {
  const ctx = rozOf(p);
  if (!ctx) return [];
  const d = describeRoz(ctx, "well");
  return [
    t("San Andres residual oil zone - published context", styles.h2),
    t(d.summary),
    ...d.figures.map((f) => t(`${f.label}: ${f.value}.`)),
    t(d.reservoirNote),
    t(d.caveat, styles.note),
    t(`Source: ${rozCitation(ctx)}`, { fontSize: 7.5, color: "#61758a", marginBottom: 6 }),
  ];
}

export async function renderFinderReport(
  result: FinderResult,
  selectedApi?: string,
): Promise<Buffer> {
  const prospects = selectedApi
    ? result.prospects.filter((p) => p.api === selectedApi)
    : result.prospects;
  if (selectedApi && !prospects.length)
    throw Error("Prospect not found in this run");
  const footer = () =>
    e(
      View,
      { fixed: true, style: styles.footer },
      t("Mineral Finder | Research screening - professional review required", {
        fontSize: 7,
        color: "#61758a",
      }),
      e(Text, {
        style: {
          fontSize: 7,
          color: "#61758a",
          width: 35,
          height: 12,
          textAlign: "right",
        },
        render: ({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`,
      }),
    );
  const page = (key: string, children: React.ReactNode[]) =>
    e(
      Page,
      { key, size: "LETTER", wrap: true, style: styles.page },
      ...children,
      footer(),
    );
  const body = [
    page("summary", [
      t("MINERALFLOW AI / MINERAL FINDER", styles.brand),
      t(`${result.criteria.county} County research`, styles.title),
      t(`Generated ${result.generatedAt}. ${result.version}.`),
      t(result.query),
      t(
        `County wells indexed: ${result.wells}. Eligible historical leads: ${result.eligible}. Ranked leads in this report: ${prospects.length}.`,
      ),
      t(
        `Before ${result.criteria.beforeYear}; statuses ${result.criteria.statuses.join(", ")}; radius ${result.criteria.radiusMiles} miles. Score is a transparent research priority, not expected return.`,
        styles.note,
      ),
      ...prospects.map((p) =>
        e(
          View,
          { key: p.api, style: styles.row, wrap: false },
          t(
            `#${p.rank}  ${p.api} | ${p.well.status} | ${p.score}/90 research score`,
          ),
          t(
            `${p.well.association?.fieldName ?? "Field unavailable"} | ${p.offsets.length} reservoir proxy offsets | ${p.catalog.length} catalog items`,
          ),
        ),
      ),
      ...result.warnings.map((w) => t(w)),
    ]),
  ];
  for (const p of prospects)
    body.push(
      page(p.api, [
        t("MINERAL FINDER / PROSPECT EVIDENCE", styles.brand),
        t(p.api, styles.title),
        t(
          `County: ${p.well.county} | Operator: ${p.well.association?.operator ?? "Unavailable"} | Lease: ${p.well.association?.district ?? "unavailable"}/${p.well.association?.lease ?? "unavailable"}`,
        ),
        t(`Location: ${p.well.lat}, ${p.well.lng}. [rrc-gis]`),
        t(
          `Historical age: ${p.ageEvidence.date}, ${p.ageEvidence.basis}. [${p.ageEvidence.sourceId}]`,
        ),
        t(
          `Formation: ${p.formation ?? "Unavailable"}. ${p.formationBasis} [rrc-wellbore]`,
        ),
        t("Geological research assessment", styles.h2),
        t(p.geologicalAssessment, styles.note),
        t(
          `Geological confidence: ${p.geologicalConfidence}. No read/interpreted logs, verified completion intervals, reservoir pressure or recoverable volumes in this screen.`,
        ),
        t("Historical production", styles.h2),
        t(
          p.production?.status === "success"
            ? `${p.production.rows.length} returned monthly slots, ${p.production.rows[0]?.month} to ${p.production.rows.at(-1)?.month}; ${p.production.rows.filter((r) => r.oil !== null || r.gas !== null || r.water !== null).length} contain reported volumes. Unreported months remain unavailable. [${p.production.sourceId}] Lease volumes are not attributed to the subject well.`
            : `Unavailable: ${p.production?.reason ?? "Not requested in this pass"}.`,
        ),
        t(
          p.decline
            ? `Existing lease Arps screening fit: annual decline ${p.decline.annualPct.toFixed(1)}%, R-squared ${p.decline.rSquared.toFixed(2)}. Not a restart forecast.`
            : "Decline fit unavailable or inappropriate; no restart forecast supplied.",
        ),
        ...rozSection(p),
        ...reservoirsForField(p.well.county, p.well.association?.fieldName).flatMap((r) => studySection(buildReservoirStudy(r))),
        t("Offset comparisons", styles.h2),
        ...(p.offsets.length
          ? p.offsets.map((o) =>
              t(
                `${o.api}: ${o.distanceMiles} miles; ${o.formation}; same RRC field proxy. Positive reported offset lease production: ${o.historicallyProductive === null ? "unverified" : o.historicallyProductive ? "yes" : "not in returned period"}. [rrc-gis, rrc-wellbore${o.productionKey ? `, production:${o.productionKey}` : ""}]`,
              ),
            )
          : [t("No compatible offset established.")]),
        t("Available catalog materials", styles.h2),
        ...(p.catalog.length
          ? p.catalog.map((c) =>
              e(
                View,
                { key: c.id, style: styles.row, wrap: false },
                t(
                  `BEG item ${c.id}; ${c.logTypes ?? c.material ?? "Type unavailable"}; ${c.topFt ?? "unavailable"}-${c.bottomFt ?? "unavailable"} ft. Catalog formation ${c.formation ?? "unavailable"}. Unread.`,
                ),
                e(
                  Link,
                  { src: c.url, style: { fontSize: 7, color: "#167a90" } },
                  c.url,
                ),
              ),
            )
          : [t("No exact API match; catalog coverage is incomplete.")]),
        t("Recommended data purchases - human approval required", styles.h2),
        ...(p.purchases.length
          ? p.purchases.map((r) =>
              t(
                `BEG item ${r.itemId}: ${r.estimatedUsd === null ? "Quote required" : `$${r.estimatedUsd} published per-log scan estimate`}. ${r.purpose} ${r.scope} [${r.pricingUrl}, checked ${r.pricingCheckedAt ?? "unavailable"}]`,
              ),
            )
          : [t("No useful catalog item selected with sufficient metadata.")]),
        t("Economics", styles.h2),
        t(`INSUFFICIENT DATA. ${p.economics.reason}`),
        t("Score calculation", styles.h2),
        ...p.scoreExplanation.map((s) =>
          t(
            `+${s.points}: ${s.criterion}. ${s.evidence.length ? `[${s.evidence.join(", ")}]` : "No supporting signal scored."}`,
          ),
        ),
        t("Required geological, legal and regulatory review", styles.h2),
        ...[...p.gaps, ...p.risks].map((g) => t(`- ${g}`)),
        t(
          `RRC wellbore source row(s): ${p.well.associations.map((a) => a.sourceRow).join(", ")}. Normalized values and original source fields are retained in the research JSON.`,
        ),
      ]),
    );
  const neededSources = new Set([
    "rrc-wellbore",
    "rrc-gis",
    "beg-catalog",
    "beg-pricing",
    ...prospects.flatMap((p) => [
      p.production?.sourceId ?? "",
      ...p.offsets.map((o) => `production:${o.productionKey}`),
    ]),
  ]);
  body.push(
    page("sources", [
      t("SOURCE REGISTER AND EXCLUSIONS", styles.title),
      ...result.sources
        .filter((s) => !selectedApi || neededSources.has(s.id))
        .flatMap((s) => [
          t(`${s.id} | ${s.provider}`, styles.h2),
          t(
            `${s.status}; ${s.count} records; query coverage ${s.complete ? "complete" : "limited"}; retrieved ${s.retrievedAt}.`,
          ),
          e(
            Link,
            { src: s.url, style: { fontSize: 8, color: "#167a90" } },
            s.url,
          ),
          ...(s.sha256 ? [t(`SHA256: ${s.sha256}`)] : []),
          ...s.warnings.map((w) => t(w)),
        ]),
      t("Exclusions", styles.h2),
      ...Object.entries(result.excluded).map(([k, v]) => t(`${k}: ${v}`)),
    ]),
  );
  return renderToBuffer(
    e(
      Document,
      {
        title: `Mineral Finder - ${result.criteria.county} - research prospects`,
        author: "MineralFlow AI",
      },
      ...body,
    ),
  );
}
