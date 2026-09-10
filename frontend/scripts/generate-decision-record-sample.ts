/**
 * Generates the GOLD STANDARD Acquisition Decision Record by running the
 * real engine over the shared golden fixture.
 *
 * Emits three artefacts:
 *   golden-input.json            the exact DecisionInputs consumed
 *   golden-decision-record.json  the DecisionRecord produced
 *   jv-decision-record-v3.html   the report, rendered only from that record
 *
 * Presentation rule for this document: show, don't tell. A page states its
 * conclusion at a size readable across a room, supports it with a diagram or
 * chart that carries the actual numbers, and spends prose only where a figure
 * would mislead without it. No visual is decorative — each one answers a
 * question a reader would otherwise have to work out from a table.
 *
 * The decision figures come from `record`; nothing about the decision is
 * recomputed here. The surrounding technical evidence comes from
 * scripts/lib/decision-record-asset-detail.ts, declared once so no two pages
 * can draw different values for the same measurement.
 *
 *   npx tsx scripts/generate-decision-record-sample.ts <outDir>
 *   node ../worker/scripts/render-decision-record-pdf.mjs <html> <pdf>
 */

import fs from "node:fs";
import path from "node:path";
import { buildDecisionRecord } from "../lib/trrc/title/decision-record";
import { computePositionValue, provided } from "../lib/trrc/title/position-value";
import { defaultScenarioDefinitions } from "../lib/trrc/title/decision-inputs";
import {
  CONFIDENCE_DOMAIN_LABEL, NOT_PROVIDED_LABEL, NO_ASKING_PRICE_LABEL, POSTURE_DISPLAY, READINESS_DISPLAY,
} from "../lib/trrc/title/decision-types";
import { goldenInput } from "../lib/trrc/title/__tests__/fixtures/golden-asset";
import {
  COMPETING_CLAIM, COMPLETION, COSTS, INSTRUMENTS, Measure, PRODUCTION, PRODUCTION_KPIS,
  RECONCILED_ESTATE, RECONCILIATION, REGULATORY, SPACING, Src, SUBSURFACE,
} from "./lib/decision-record-asset-detail";

const outDir = process.argv[2] ?? ".";
const INPUT = goldenInput();
const record = buildDecisionRecord({ input: INPUT, scenarioDefinitions: defaultScenarioDefinitions(INPUT) });
const v = record.positionValue;
const c = v.cases;
const r4 = record.closingReadiness;

// ─── text helpers ───────────────────────────────────────────────────────────
const esc = (s: string) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const usd = (n: number | null | undefined, dash = "—") =>
  n == null ? dash : `${n < 0 ? "−" : ""}$${Math.round(Math.abs(n)).toLocaleString("en-US")}`;
/** Headline form. The exact value always travels with it, never replaced by it. */
const usdK = (n: number | null | undefined, dash = "—") => {
  if (n == null) return dash;
  const a = Math.abs(n);
  const s = a >= 1_000_000 ? `${(a / 1_000_000).toFixed(1)}M` : a >= 1000 ? `${(a / 1000).toFixed(1)}K` : `${Math.round(a)}`;
  return `${n < 0 ? "−" : ""}$${s}`;
};
const signed = (n: number | null | undefined, dash = "—") => n == null ? dash : `${n < 0 ? "−" : ""}$${Math.abs(n).toFixed(2)}`;
const pctS = (n: number | null) => n == null ? "—" : `${n < 0 ? "−" : ""}${Math.abs(n * 100).toFixed(1)}%`;
const num = (n: number) => n.toLocaleString("en-US");
const li = (xs: string[], empty = "None recorded.") =>
  xs.length ? `<ul class="tight">${xs.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : `<p class="none">${empty}</p>`;

const TONE: Record<string, string> = {
  PROCEED: "ok", CONDITIONAL_PROCEED: "warn", HOLD_FOR_DILIGENCE: "warn", PASS: "crit", INSUFFICIENT_DATA: "neutral",
};
const LEVEL_TONE: Record<string, string> = { HIGH: "ok", MEDIUM: "warn", LOW: "crit", INSUFFICIENT: "neutral" };

/**
 * Status marks. Colour never carries meaning alone: every mark pairs a glyph
 * with a word, so the page survives greyscale printing and colour blindness.
 */
const MARK = { ok: "✓", warn: "⚠", crit: "✕", none: "○", part: "◐" };
const pill = (tone: "ok" | "warn" | "crit" | "none" | "part", text: string) =>
  `<span class="pill pill-${tone}"><span class="pm">${MARK[tone]}</span>${esc(text)}</span>`;
const srcTag = (s: Src) => `<span class="stag stag-${s.toLowerCase()}">${s}</span>`;

// ─── svg helpers ────────────────────────────────────────────────────────────
const W = 710;                       // full printable width in CSS px
const svg = (h: number, body: string, w = W) =>
  `<svg class="viz" viewBox="0 0 ${w} ${h}" role="img" preserveAspectRatio="xMidYMid meet">${body}</svg>`;
const t = (x: number, y: number, s: string, cls = "vt", anchor = "start") =>
  `<text class="${cls}" x="${x}" y="${y}" text-anchor="${anchor}">${esc(s)}</text>`;
const rect = (x: number, y: number, w: number, h: number, fill: string, extra = "") =>
  `<rect x="${x}" y="${y}" width="${Math.max(0, w)}" height="${Math.max(0, h)}" fill="${fill}" ${extra}/>`;
/** Down arrow between stacked blocks — the report's one repeated flow glyph. */
const arrowDown = (x: number, y1: number, y2: number, stroke = "var(--ink-3)") =>
  `<line x1="${x}" y1="${y1}" x2="${x}" y2="${y2 - 7}" stroke="${stroke}" stroke-width="1.4"/>` +
  `<path d="M${x - 4},${y2 - 8} L${x},${y2 - 1} L${x + 4},${y2 - 8} Z" fill="${stroke}"/>`;

// ─── derived facts used by more than one page ───────────────────────────────
const admitted = record.scenarios.find(s => s.id === "admit-E-01");
const e01 = record.exceptionImpacts.find(i => i.findingId === "E-01");
const baseNri = record.evaluatedPosition.netRevenueInterest;
const OILS = [60, 70, 80];
const GASES = [2.5, 3.5, 4.5];
const baseDeck = v.criteria.baseDeck.value;

/**
 * PV of the reconciled position at an arbitrary headline deck, through the real
 * engine. Only the headline prices move: differentials come from the base deck,
 * so the grid varies the one thing it claims to vary.
 */
const deckPv = (oilUsdPerBbl: number, gasUsdPerMcf: number): number | null =>
  computePositionValue({
    basis: v.basis,
    criteria: {
      ...v.criteria,
      baseDeck: provided(baseDeck == null ? null : { ...baseDeck, oilUsdPerBbl, gasUsdPerMcf }, "Sensitivity grid", "DERIVED"),
    },
    remainingOilBbl: INPUT.remainingOilBbl,
    remainingGasMcf: INPUT.remainingGasMcf,
    annualDecline: INPUT.annualDecline,
    quantifiedAssetExposureUsd: 0,
    askingPriceUsd: null,
  }).cases.baseEconomicValueUsd;

// ════════════════════════════════════════════════════════════════════════════
// PAGE 1 — executive decision dashboard
// ════════════════════════════════════════════════════════════════════════════
const kpis: Array<{ big: string; exact: string; label: string; tone: string }> = [
  { big: usdK(c.baseEconomicValueUsd), exact: usd(c.baseEconomicValueUsd), label: "Base value", tone: "" },
  { big: usdK(c.evidenceAdjustedValueUsd), exact: usd(c.evidenceAdjustedValueUsd), label: "Evidence-adjusted", tone: "" },
  { big: usdK(-c.quantifiedAssetExposureUsd), exact: usd(-c.quantifiedAssetExposureUsd), label: "Measured exposure", tone: "crit" },
  { big: record.evaluatedPosition.netMineralAcres?.toFixed(1) ?? "—", exact: `${record.evaluatedPosition.netMineralAcres?.toFixed(2) ?? "—"} of 160 gross`, label: "Net mineral acres", tone: "" },
  { big: baseNri == null ? "—" : `${(baseNri * 100).toFixed(4)}%`, exact: baseNri?.toFixed(8) ?? "—", label: "Net revenue interest", tone: "" },
  { big: record.confidence.overall, exact: `capped by ${CONFIDENCE_DOMAIN_LABEL[record.confidence.cappedBy!] ?? "—"}`, label: "Confidence", tone: LEVEL_TONE[record.confidence.overall] },
  { big: READINESS_DISPLAY[r4.readiness], exact: `rule ${r4.ruleId}`, label: "Closing", tone: r4.readiness === "READY_FOR_FINAL_REVIEW" ? "ok" : "crit" },
  { big: v.askingPriceUsd == null ? "—" : usdK(v.askingPriceUsd), exact: v.askingPriceUsd == null ? NO_ASKING_PRICE_LABEL : usd(v.askingPriceUsd), label: "Asking price", tone: v.askingPriceUsd == null ? "flag" : "" },
];

const risksP1 = record.exceptionImpacts
  .filter(i => i.decisionMaterial || i.blocksClosing)
  .map(i => i.quantifiedValueImpactUsd != null
    ? `${usdK(i.quantifiedValueImpactUsd)} — ${i.issue.toLowerCase()}`
    : `${i.issue} — not yet priceable`)
  .slice(0, 3);
if (INPUT.reconciliationVariancePct != null && Math.abs(INPUT.reconciliationVariancePct) > INPUT.reconciliationThresholdPct) {
  risksP1.push(`Production variance ${INPUT.reconciliationVariancePct.toFixed(2)}% over ${INPUT.reconciliationThresholdPct.toFixed(2)}% threshold`);
}

const page1 = `
<section id="p1">
  <div class="verdict verdict-${TONE[record.posture]}">
    <div class="vlabel">Acquisition posture · rule ${esc(record.postureRuleId)} · ruleset ${esc(record.decisionRuleVersion)}</div>
    <div class="vvalue">${esc(record.postureDisplay)}</div>
    <p class="thesis">${esc(record.investmentThesis)}</p>
  </div>

  <div class="kpis">${kpis.map(k => `
    <div class="kpi">
      <div class="kpi-v ${k.tone}">${esc(k.big)}</div>
      <div class="kpi-k">${esc(k.label)}</div>
      <div class="kpi-x">${esc(k.exact)}</div>
    </div>`).join("")}</div>

  <div class="three">
    <div class="col-ok">
      <h3><span class="cm">${MARK.ok}</span>Why pursue</h3>
      <ul class="ticks t-ok">${record.strongestPositives.slice(0, 4).map(x => `<li>${esc(x)}</li>`).join("")}</ul>
    </div>
    <div class="col-warn">
      <h3><span class="cm">${MARK.warn}</span>Risks</h3>
      <ul class="ticks t-warn">${risksP1.map(x => `<li>${esc(x)}</li>`).join("")}</ul>
    </div>
    <div class="col-none">
      <h3><span class="cm">${MARK.none}</span>Before closing</h3>
      <ul class="ticks t-none">${(r4.actionsBeforeClosing.length ? r4.actionsBeforeClosing : ["No closing requirement outstanding."]).slice(0, 4).map(x => `<li>${esc(x)}</li>`).join("")}</ul>
    </div>
  </div>

  <p class="fine">Posture and closing readiness are independent states. ${esc(r4.disclaimer)}</p>
</section>`;

// ════════════════════════════════════════════════════════════════════════════
// PAGE 2 — value and price
// ════════════════════════════════════════════════════════════════════════════
const wfBase = c.baseEconomicValueUsd ?? 0;
const wfExposure = c.quantifiedAssetExposureUsd;
const wfAdj = c.evidenceAdjustedValueUsd ?? 0;

/** Value waterfall. Bar length is proportional, so the deduction reads as small. */
const waterfallSvg = (() => {
  const x0 = 172, x1 = 640, h = 44, gap = 26;
  const scale = (n: number) => (wfBase === 0 ? 0 : (n / wfBase) * (x1 - x0));
  const rows: Array<[string, string, number, number, string, string]> = [
    ["Base value", usd(c.baseEconomicValueUsd), 0, wfBase, "var(--accent)", "Base deck · ownership as reconciled"],
    ["Ownership exposure", usd(-wfExposure), scale(wfAdj), wfExposure, "var(--crit)", "Measured, not estimated"],
    ["Evidence-adjusted", usd(c.evidenceAdjustedValueUsd), 0, wfAdj, "var(--ok)", "Base less measured exposure"],
  ];
  let y = 22, body = "";
  rows.forEach(([label, amount, offset, val, fill, note], i) => {
    const w = Math.max(2, scale(val));
    body += t(0, y + 18, label, "vt vt-b");
    body += t(0, y + 33, note, "vt vt-s");
    body += rect(x0 + offset, y, w, h, fill, i === 1 ? 'opacity="0.9"' : "");
    body += t(x0 + offset + w + 10, y + 28, amount, i === 1 ? "vt vt-n vt-crit" : "vt vt-n");
    if (i < rows.length - 1) body += arrowDown(x0 + 26, y + h + 3, y + h + gap - 2);
    y += h + gap;
  });
  return svg(y - gap + h - 22 + 30, body);
})();

const maxPriceBlock = v.maxAcquisitionPriceUsd == null
  ? `<div class="bigstat bigstat-flag">
       <div class="bs-k">Maximum buy price</div>
       <div class="bs-v">—</div>
       <div class="bs-n">${MARK.warn} Buyer return criterion required</div>
     </div>`
  : `<div class="bigstat">
       <div class="bs-k">Maximum buy price</div>
       <div class="bs-v">${esc(usdK(v.maxAcquisitionPriceUsd))}</div>
       <div class="bs-n">${esc(usd(v.maxAcquisitionPriceUsd))} at the stated return criterion</div>
     </div>`;

const page2 = `
<section id="p2">
  <div class="shead"><span class="n">02</span><h2>Value and price</h2><span class="tail">Commodity and asset risk kept apart</span></div>

  <div class="viz-wrap">${waterfallSvg}</div>

  <div class="scen3">
    <div class="sc sc-down"><div class="sc-k">Downside</div><div class="sc-v">${esc(usdK(c.downsideCommodityValueUsd))}</div><div class="sc-x">${esc(usd(c.downsideCommodityValueUsd))}</div><div class="sc-n">Commodity prices only</div></div>
    <div class="sc sc-base"><div class="sc-k">Base</div><div class="sc-v">${esc(usdK(c.baseEconomicValueUsd))}</div><div class="sc-x">${esc(usd(c.baseEconomicValueUsd))}</div><div class="sc-n">Stated deck</div></div>
    <div class="sc sc-up"><div class="sc-k">Upside</div><div class="sc-v">${esc(usdK(c.upsideCommodityValueUsd))}</div><div class="sc-x">${esc(usd(c.upsideCommodityValueUsd))}</div><div class="sc-n">Commodity prices only</div></div>
  </div>

  <div class="pair">
    ${maxPriceBlock}
    <div class="bigstat bigstat-crit">
      <div class="bs-k">Risk-adjusted value</div>
      <div class="bs-v">${esc(usdK(c.riskAdjustedValueUsd))}</div>
      <div class="bs-n">${esc(usd(c.riskAdjustedValueUsd))} — downside deck <em>and</em> measured exposure, both named</div>
    </div>
  </div>

  <p class="fine"><b>The three cards above move on commodity price alone.</b> The −${esc(usd(wfExposure).slice(1))} in the waterfall moves on ownership evidence alone. They are never combined into one adjusted number without both being named.</p>

  <h3 class="sub">Underwriting inputs behind these figures</h3>
  <div class="critgrid">${([
    ["Discount rate", v.criteria.discountRate],
    ["Minimum margin", v.criteria.minimumMarginPct],
    ["Underwrite against", v.criteria.underwriteAgainst],
    ["Horizon", v.criteria.forecastHorizonYears],
    ["Timing", v.criteria.timingConvention],
    ["Risk haircut", v.criteria.riskHaircutPct],
  ] as Array<[string, { value: unknown; classification: string }]>).map(([label, crit]) => {
    const np = crit.classification === "NOT_PROVIDED";
    const val = np ? NOT_PROVIDED_LABEL
      : label === "Discount rate" ? `${((crit.value as number) * 100).toFixed(1)}%`
      : label === "Risk haircut" ? `${((crit.value as number) * 100).toFixed(1)}%`
      : label === "Horizon" ? `${crit.value} yr`
      : String(crit.value).replace(/_/g, " ");
    return `<div class="cg ${np ? "cg-flag" : ""}">
      <div class="cg-k">${esc(label)}</div>
      <div class="cg-v">${esc(val)}</div>
      <div class="cg-c">${esc(crit.classification.replace(/_/g, " ").toLowerCase())}</div>
    </div>`;
  }).join("")}</div>
  <p class="fine">Base deck ${esc(baseDeck ? `$${baseDeck.oilUsdPerBbl.toFixed(2)}/bbl · $${baseDeck.gasUsdPerMcf.toFixed(2)}/mcf` : NOT_PROVIDED_LABEL)}, differentials ${esc(signed(baseDeck?.oilDifferentialUsdPerBbl))}/bbl · ${esc(signed(baseDeck?.gasDifferentialUsdPerMcf))}/mcf. A criterion marked <em>not provided</em> is never replaced by a house default; the outputs that depend on it are withheld.</p>
</section>`;

// ════════════════════════════════════════════════════════════════════════════
// PAGE 3 — decision sensitivity
// ════════════════════════════════════════════════════════════════════════════
const grid = OILS.map(o => GASES.map(g => deckPv(o, g) ?? 0));
const gridLo = Math.min(...grid.flat());
const gridHi = Math.max(...grid.flat());

const heatmapSvg = (() => {
  // Axis titles sit on their own row: putting them level with the column
  // headers overlapped the first gas price.
  const cw = 158, ch = 54, x0 = 118, y0 = 54;
  let body = t(0, 14, "WTI $/bbl  ×  Henry Hub $/mcf", "vt vt-h");
  body += t(0, y0 - 14, "WTI", "vt vt-h");
  GASES.forEach((g, j) => { body += t(x0 + j * cw + cw / 2, y0 - 14, `$${g.toFixed(2)}`, "vt vt-h", "middle"); });
  OILS.forEach((o, i) => {
    const y = y0 + i * ch;
    body += t(0, y + ch / 2 + 5, `$${o}`, "vt vt-b");
    GASES.forEach((g, j) => {
      const val = grid[i][j];
      const k = gridHi === gridLo ? 0.5 : (val - gridLo) / (gridHi - gridLo);
      const isBase = baseDeck != null && o === baseDeck.oilUsdPerBbl && g === baseDeck.gasUsdPerMcf;
      body += rect(x0 + j * cw, y, cw - 4, ch - 4, "var(--accent)", `opacity="${(0.10 + k * 0.42).toFixed(3)}"`);
      if (isBase) body += rect(x0 + j * cw, y, cw - 4, ch - 4, "none", 'stroke="var(--ink)" stroke-width="2"');
      body += t(x0 + j * cw + (cw - 4) / 2, y + ch / 2 + 5, usd(val), isBase ? "vt vt-n vt-b" : "vt vt-n", "middle");
      if (isBase) body += t(x0 + j * cw + (cw - 4) / 2, y + ch - 12, "BASE CASE", "vt vt-s", "middle");
    });
  });
  return svg(y0 + OILS.length * ch + 8, body);
})();

/** Where the posture flips, drawn on the axis the flip happens on. */
const breakpointAxisSvg = (() => {
  const x0 = 20, x1 = 690, y = 58;
  const flip = wfBase;
  const fx = x0 + (x1 - x0) * 0.62;
  let body = "";
  body += rect(x0, y - 12, fx - x0, 24, "var(--ok)", 'opacity="0.16"');
  body += rect(fx, y - 12, x1 - fx, 24, "var(--crit)", 'opacity="0.14"');
  body += `<line x1="${fx}" y1="${y - 22}" x2="${fx}" y2="${y + 22}" stroke="var(--ink)" stroke-width="2"/>`;
  body += t((x0 + fx) / 2, y + 5, "PURSUE — margin remains", "vt vt-b", "middle");
  body += t((fx + x1) / 2, y + 5, "PASS — no margin at base deck", "vt vt-b", "middle");
  body += t(fx, y - 30, usd(flip), "vt vt-n vt-b", "middle");
  body += t(fx, y + 38, "base economic value", "vt vt-s", "middle");
  body += t(x0, y + 38, "asking price →", "vt vt-s");
  return svg(96, body);
})();

const page3 = `
<section id="p3">
  <div class="shead"><span class="n">03</span><h2>Decision sensitivity</h2><span class="tail">What flips the decision</span></div>

  <h3 class="sub">PV-10 across the commodity deck</h3>
  <div class="viz-wrap">${heatmapSvg}</div>
  <p class="fine">Reconciled ownership held constant. Every cell is computed by the same engine that produced the decision. ${esc(`A dollar of gas moves this position further than a dollar of oil on remaining volumes of ${num(INPUT.remainingOilBbl ?? 0)} bbl and ${num(INPUT.remainingGasMcf ?? 0)} mcf.`)}</p>

  <h3 class="sub">Where the posture flips on price</h3>
  <div class="viz-wrap">${breakpointAxisSvg}</div>

  <h3 class="sub">Variables that can flip the decision</h3>
  <div class="bpcards">${v.breakpoints.map(b => `
    <div class="bp ${b.computable ? "" : "bp-flag"}">
      <div class="bp-var">${esc(b.variable)}</div>
      <div class="bp-flow">
        <span class="bp-now">${esc(b.currentValue)}</span>
        <span class="bp-arr">→</span>
        <span class="bp-at ${b.computable ? "" : "flag"}">${esc(b.flipsAt)}</span>
      </div>
      <div class="bp-con">${esc(b.consequence)}</div>
    </div>`).join("")}</div>
</section>`;

// ════════════════════════════════════════════════════════════════════════════
// PAGE 4 — risk map
// ════════════════════════════════════════════════════════════════════════════
/** 2×2: decision impact against how resolvable the exception is today. */
const riskMapSvg = (() => {
  const x0 = 118, y0 = 24, w = 500, h = 232;
  const cx = x0 + w / 2, cy = y0 + h / 2;
  let body = "";
  body += rect(x0, y0, w / 2, h / 2, "var(--warn)", 'opacity="0.07"');
  body += rect(cx, y0, w / 2, h / 2, "var(--crit)", 'opacity="0.08"');
  body += rect(x0, cy, w / 2, h / 2, "var(--ink-3)", 'opacity="0.05"');
  body += rect(cx, cy, w / 2, h / 2, "var(--warn)", 'opacity="0.05"');
  body += `<rect x="${x0}" y="${y0}" width="${w}" height="${h}" fill="none" stroke="var(--rule)" stroke-width="1"/>`;
  body += `<line x1="${cx}" y1="${y0}" x2="${cx}" y2="${y0 + h}" stroke="var(--rule)" stroke-width="1"/>`;
  body += `<line x1="${x0}" y1="${cy}" x2="${x0 + w}" y2="${cy}" stroke="var(--rule)" stroke-width="1"/>`;

  // Quadrant labels hug the outer corners so a plotted exception never lands on one.
  body += t(x0 + 8, y0 + 15, "PRICE IT IN", "vt vt-q");
  body += t(x0 + w - 8, y0 + 15, "MUST RESOLVE", "vt vt-q", "end");
  body += t(x0 + 8, y0 + h - 8, "MONITOR", "vt vt-q");
  body += t(x0 + w - 8, y0 + h - 8, "QUEUE", "vt vt-q", "end");

  body += t(0, y0 + 14, "HIGH", "vt vt-h");
  body += t(0, y0 + 30, "decision", "vt vt-s");
  body += t(0, y0 + 42, "impact", "vt vt-s");
  body += t(0, y0 + h - 2, "LOW", "vt vt-h");
  body += t(x0, y0 + h + 20, "◀ quantifiable today", "vt vt-s");
  body += t(x0 + w, y0 + h + 20, "not yet priceable ▶", "vt vt-s", "end");

  // Plot: x = quantifiable (left half) vs not (right half); y = decision impact.
  // Exceptions that score identically would otherwise stack into one mark, so
  // ties are fanned horizontally within their own half — the fan is cosmetic,
  // the half and the height are the data.
  const R = 17;
  const scored = record.exceptionImpacts.map(i => ({
    i,
    // Blocking closing is the single largest contributor: an unpriceable
    // blocker holds the deal outright, which outranks any combination that
    // only changes the price.
    impact: (i.blocksClosing ? 0.5 : 0) + (i.decisionMaterial ? 0.3 : 0) + (i.ownershipMaterial ? 0.2 : 0),
    left: i.quantifiable,
  }));
  const placed = scored.map(({ i, impact, left }) => ({
    id: i.findingId,
    blocks: i.blocksClosing,
    left,
    x: left ? x0 + w * 0.25 : cx + w * 0.25,
    y: y0 + h - 30 - (h - 60) * impact,
  }));
  // Marks whose scores land within a bubble of each other would overlap and
  // hide one another. Fan colliding marks apart horizontally inside their own
  // half: the half and the height carry the data, the fan only keeps both
  // readable.
  for (const group of [true, false]) {
    const inHalf = placed.filter(m => m.left === group).sort((a, b) => a.y - b.y);
    for (let a = 0; a < inHalf.length; a++) {
      for (let b = a + 1; b < inHalf.length; b++) {
        if (Math.abs(inHalf[a].y - inHalf[b].y) < R * 2 + 4 && Math.abs(inHalf[a].x - inHalf[b].x) < R * 2 + 4) {
          inHalf[a].x -= R + 9;
          inHalf[b].x += R + 9;
        }
      }
    }
  }
  const pts = placed.map(m => {
    const tone = m.blocks ? "var(--crit)" : "var(--warn)";
    return `<circle cx="${m.x}" cy="${m.y}" r="${R}" fill="${tone}" opacity="0.14"/>` +
      `<circle cx="${m.x}" cy="${m.y}" r="${R}" fill="none" stroke="${tone}" stroke-width="1.6"/>` +
      t(m.x, m.y + 4, m.id, "vt vt-n vt-b", "middle");
  }).join("");
  return svg(y0 + h + 30, body + pts);
})();

const page4 = `
<section id="p4">
  <div class="shead"><span class="n">04</span><h2>Risk map</h2><span class="tail">${record.exceptionImpacts.length} exceptions</span></div>
  <div class="viz-wrap">${riskMapSvg}</div>
  <p class="fine">Blocking closing, being decision-material, being quantifiable and requiring counsel are independent properties. An exception can block closing <em>and</em> carry a measured price at the same time — the two are not in conflict.</p>

  <div class="excards">${record.exceptionImpacts.map(i => `
    <div class="ex ex-${i.blocksClosing ? "block" : "warn"}">
      <div class="ex-h">
        <span class="ex-id">${esc(i.findingId)}</span>
        <span class="sev sev-${i.severity === "high" || i.severity === "critical" ? "high" : i.severity === "medium" ? "med" : "low"}">${esc(i.severity)}</span>
        <span class="ex-t">${esc(i.issue)}</span>
      </div>
      <div class="ex-chain">${i.affects.map(a => `<span>${esc(a.toUpperCase())}</span>`).join('<span class="ex-arr">→</span>')}</div>
      ${i.quantifiedValueImpactUsd != null && i.nriImpact ? `
      <div class="ex-meas">
        <span class="em">${esc(COMPETING_CLAIM.fraction)} claim</span><span class="ex-arr">↓</span>
        <span class="em">${esc(pctS(admitted?.deltaPct ?? null))} NRI</span><span class="ex-arr">↓</span>
        <span class="em em-crit">${esc(usd(i.quantifiedValueImpactUsd))} PV-10</span>
      </div>` : `
      <div class="ex-unq">${MARK.warn} ${esc(i.unquantifiedReason ?? "Not yet quantifiable.")}</div>`}
      <div class="ex-flags">
        ${pill(i.blocksClosing ? "crit" : "none", i.blocksClosing ? "Closing blocker" : "Not a blocker")}
        ${pill(i.quantifiable ? "ok" : "warn", i.quantifiable ? "Priceable" : "Not priceable")}
        ${pill(i.ownershipMaterial ? "warn" : "none", i.ownershipMaterial ? "Ownership" : "No ownership effect")}
        ${pill(i.requiresProfessionalReview ? "warn" : "none", i.requiresProfessionalReview ? "Counsel" : "No counsel needed")}
      </div>
      <div class="ex-next"><b>Next:</b> ${esc(i.resolution)}</div>
    </div>`).join("")}</div>
</section>`;

// ════════════════════════════════════════════════════════════════════════════
// PAGE 5 — scenario comparison
// ════════════════════════════════════════════════════════════════════════════
const scenarioStack = (title: string, sub: string, tone: string, rows: Array<[string, string]>) => `
  <div class="stack stack-${tone}">
    <div class="stack-h">${esc(title)}<span>${esc(sub)}</span></div>
    ${rows.map(([k, val], idx) => `
      <div class="stack-r">
        <div class="stack-k">${esc(k)}</div>
        <div class="stack-v">${esc(val)}</div>
      </div>${idx < rows.length - 1 ? '<div class="stack-a">↓</div>' : ""}`).join("")}
  </div>`;

const admittedNri = admitted?.netRevenueInterest ?? null;
const admittedNma = admittedNri != null && baseNri != null && record.evaluatedPosition.netMineralAcres != null
  ? record.evaluatedPosition.netMineralAcres * (admittedNri / baseNri) : null;

const page5 = `
<section id="p5">
  <div class="shead"><span class="n">05</span><h2>Scenario comparison</h2><span class="tail">Ownership axis · same prices throughout</span></div>

  <div class="scomp">
    ${scenarioStack("Record as reconciled", "primary", "ok", [
      ["Mineral fraction", `${record.evaluatedPosition.mineralFraction?.n ?? "—"}/${record.evaluatedPosition.mineralFraction?.d ?? "—"} of the minerals`],
      ["Net mineral acres", record.evaluatedPosition.netMineralAcres?.toFixed(2) ?? "—"],
      ["Net revenue interest", baseNri?.toFixed(8) ?? "—"],
      ["PV-10", usd(c.baseEconomicValueUsd)],
    ])}
    ${scenarioStack("Competing claim included", `${COMPETING_CLAIM.fraction} of ${COMPETING_CLAIM.claimant}`, "crit", [
      ["Mineral fraction", "2/9 after dilution"],
      ["Net mineral acres", admittedNma?.toFixed(2) ?? "—"],
      ["Net revenue interest", admittedNri?.toFixed(8) ?? "—"],
      ["PV-10", usd(admitted?.economicValueUsd ?? null)],
    ])}
    <div class="sdelta">
      <div class="sd-k">Delta</div>
      <div class="sd-v">${esc(usdK(admitted?.deltaUsd ?? null))}</div>
      <div class="sd-p">${esc(pctS(admitted?.deltaPct ?? null))}</div>
      <div class="sd-x">${esc(usd(admitted?.deltaUsd ?? null))}</div>
      <div class="sd-n">Measured by re-running the full chain, not estimated.</div>
    </div>
  </div>

  <h3 class="sub">Every scenario, both axes</h3>
  <div class="scroll"><table>
    <thead><tr><th>Scenario</th><th>Axis</th><th class="num">NRI</th><th class="num">Value</th><th class="num">Δ$</th><th class="num">Δ%</th><th>Posture</th><th>Closing</th></tr></thead>
    <tbody>${record.scenarios.map(s => `<tr${s.isPrimary ? ' class="sub"' : ""}>
      <td>${esc(s.label)}${s.isPrimary ? ' <span class="muted">(primary)</span>' : ""}</td>
      <td><span class="axis axis-${s.axis}">${esc(s.axis)}</span></td>
      <td class="num">${s.netRevenueInterest?.toFixed(8) ?? "—"}</td>
      <td class="num">${usd(s.economicValueUsd)}</td>
      <td class="num ${(s.deltaUsd ?? 0) < 0 ? "crit" : ""}">${s.deltaUsd == null ? "—" : usd(s.deltaUsd)}</td>
      <td class="num ${(s.deltaPct ?? 0) < 0 ? "crit" : ""}">${s.deltaPct == null ? "—" : pctS(s.deltaPct)}</td>
      <td>${esc(POSTURE_DISPLAY[s.posture])} <span class="muted mono">${esc(s.postureRuleId)}</span></td>
      <td>${esc(READINESS_DISPLAY[s.closingReadiness])}</td></tr>`).join("")}</tbody>
  </table></div>
  <p class="fine">Ownership scenarios hold prices constant; commodity scenarios hold ownership constant. A value change is therefore always attributable to one axis, never to both at once.</p>
</section>`;

// ════════════════════════════════════════════════════════════════════════════
// PAGE 6 — confidence and closing readiness
// ════════════════════════════════════════════════════════════════════════════
const LEVEL_FILL = (lvl: string) => lvl === "HIGH" ? 1 : lvl === "MEDIUM" ? 0.62 : lvl === "LOW" ? 0.3 : 0.12;

const page6 = `
<section id="p6">
  <div class="shead"><span class="n">06</span><h2>Confidence and closing readiness</h2><span class="tail">Two independent states</span></div>

  <div class="cbars">${record.confidence.components.map(x => {
    const tone = LEVEL_TONE[x.level];
    return `<div class="cbar">
      <div class="cb-k">${esc(CONFIDENCE_DOMAIN_LABEL[x.domain])}</div>
      <div class="cb-t"><div class="cb-f cb-${tone}" style="width:${(LEVEL_FILL(x.level) * 100).toFixed(0)}%"></div></div>
      <div class="cb-l cb-lt-${tone}">${esc(x.level)}</div>
      <div class="cb-d">${x.canChangeDecision ? `<span class="cb-can">${MARK.warn} can change decision</span>` : `<span class="muted">${MARK.none} cannot change decision</span>`}</div>
      <div class="cb-r">${esc(x.reason)}</div>
    </div>`;
  }).join("")}</div>

  <div class="pair">
    <div class="bigstat bigstat-${LEVEL_TONE[record.confidence.overall]}">
      <div class="bs-k">Overall confidence</div>
      <div class="bs-v">${esc(record.confidence.overall)}</div>
      <div class="bs-n">Capped by ${esc(CONFIDENCE_DOMAIN_LABEL[record.confidence.cappedBy!] ?? "—")}. The lowest level among domains that can change the decision.</div>
    </div>
    <div class="bigstat bigstat-crit">
      <div class="bs-k">Closing readiness</div>
      <div class="bs-v">${esc(READINESS_DISPLAY[r4.readiness])}</div>
      <div class="bs-n">Rule ${esc(r4.ruleId)}. ${esc(r4.rationale)}</div>
    </div>
  </div>

  <h3 class="sub">Required before closing</h3>
  <div class="actions">${(r4.actionsBeforeClosing.length ? r4.actionsBeforeClosing : ["No closing requirement outstanding."]).map((a, k) => `
    <div class="act">
      <div class="act-n">${k + 1}</div>
      <div class="act-t">${esc(a)}</div>
    </div>`).join("")}</div>

  <p class="fine">${esc(r4.independenceNote)} ${esc(r4.disclaimer)} The unresolved title, regulatory, economic and counsel items behind these actions are itemised in the evidence appendix.</p>
</section>`;

// ════════════════════════════════════════════════════════════════════════════
// PAGE 7 — why MineralFlow exists
// ════════════════════════════════════════════════════════════════════════════
const provenanceSvg = (() => {
  const colW = 214, gap = 34, y0 = 8, boxH = 214;
  const cols: Array<[string, string, string[]]> = [
    ["NOVI", "var(--src-vendor)", ["Production", "Forecast", "Completion", "Geology", "Spacing", "Economics"]],
    ["TRRC", "var(--src-reg)", ["Production truth", "Compliance", "Operator standing", "Permits", "Well records"]],
    ["COUNTY", "var(--ink-2)", ["Deeds", "Leases", "Probate", "Liens", "Ownership"]],
  ];
  let body = "";
  cols.forEach(([name, colour, items], i) => {
    const x = i * (colW + gap);
    body += rect(x, y0, colW, boxH, "var(--panel)", 'stroke="var(--rule)" stroke-width="1"');
    body += rect(x, y0, colW, 3, colour);
    body += t(x + 15, y0 + 32, name, "vt vt-src");
    items.forEach((it, k) => { body += t(x + 15, y0 + 62 + k * 25, `· ${it}`, "vt vt-item"); });
    if (i < 2) body += t(x + colW + gap / 2, y0 + boxH / 2 + 7, "+", "vt vt-plus", "middle");
  });

  const my = y0 + boxH;
  body += `<path d="M${colW / 2},${my} L${colW / 2},${my + 18} L${W / 2},${my + 18} L${W / 2},${my + 30}" fill="none" stroke="var(--ink-3)" stroke-width="1.2"/>`;
  body += `<path d="M${colW + gap + colW / 2},${my} L${colW + gap + colW / 2},${my + 30}" fill="none" stroke="var(--ink-3)" stroke-width="1.2"/>`;
  body += `<path d="M${2 * (colW + gap) + colW / 2},${my} L${2 * (colW + gap) + colW / 2},${my + 18} L${W / 2},${my + 18} L${W / 2},${my + 30}" fill="none" stroke="var(--ink-3)" stroke-width="1.2"/>`;
  body += `<path d="M${W / 2 - 5},${my + 30} L${W / 2},${my + 38} L${W / 2 + 5},${my + 30} Z" fill="var(--ink-3)"/>`;

  const ly = my + 46, lh = 60;
  body += rect(0, ly, W, lh, "var(--accent)", 'opacity="0.09"');
  body += `<rect x="0" y="${ly}" width="${W}" height="${lh}" fill="none" stroke="var(--accent)" stroke-width="1.4"/>`;
  body += t(W / 2, ly + 37, "MINERALFLOW AI · DECISION LAYER", "vt vt-lay", "middle");

  const steps = ["Reconcile", "Title", "Ownership", "NRI", "Risk", "Value", "Decision"];
  const sy = ly + lh + 36, sw = (W - (steps.length - 1) * 12) / steps.length;
  steps.forEach((s, i) => {
    const x = i * (sw + 12);
    body += rect(x, sy, sw, 44, "var(--panel)", 'stroke="var(--rule)" stroke-width="1"');
    body += t(x + sw / 2, sy + 28, s, "vt vt-b vt-item", "middle");
    if (i < steps.length - 1) {
      body += `<path d="M${x + sw + 2},${sy + 22} L${x + sw + 9},${sy + 22}" stroke="var(--ink-3)" stroke-width="1.2"/>`;
      body += `<path d="M${x + sw + 7},${sy + 18.5} L${x + sw + 11},${sy + 22} L${x + sw + 7},${sy + 25.5} Z" fill="var(--ink-3)"/>`;
    }
  });
  return svg(sy + 58, body);
})();

const page7 = `
<section id="p7">
  <div class="shead"><span class="n">07</span><h2>How the decision is produced</h2><span class="tail">Three sources, one output</span></div>
  <div class="viz-wrap">${provenanceSvg}</div>

  <div class="outcome3">
    <div class="oc oc-warn"><div class="oc-k">Posture</div><div class="oc-v">${esc(record.postureDisplay)}</div></div>
    <div class="oc oc-ok"><div class="oc-k">Evidence-adjusted value</div><div class="oc-v">${esc(usdK(c.evidenceAdjustedValueUsd))}</div><div class="oc-x">${esc(usd(c.evidenceAdjustedValueUsd))}</div></div>
    <div class="oc oc-crit"><div class="oc-k">Closing</div><div class="oc-v">${esc(READINESS_DISPLAY[r4.readiness])}</div></div>
  </div>

  <p class="fine">MineralFlow replaces none of the three sources. It converts them into an acquisition decision, which none of them produces alone: the vendor cannot see title, the regulator cannot see well-level allocation or subsurface, and the county records carry no economics.</p>
</section>`;

// ════════════════════════════════════════════════════════════════════════════
// PAGE 8 — production and reconciliation
// ════════════════════════════════════════════════════════════════════════════
const productionSvg = (() => {
  const x0 = 56, x1 = W - 12, y0 = 22, y1 = 210;
  const hi = Math.max(...PRODUCTION.map(p => p.oilBbl));
  const top = Math.ceil(hi / 10_000) * 10_000;
  const px = (i: number) => x0 + (x1 - x0) * (i / (PRODUCTION.length - 1));
  const py = (v2: number) => y1 - (y1 - y0) * (v2 / top);
  let body = "";
  for (let g = 0; g <= 4; g++) {
    const y = y0 + (y1 - y0) * (g / 4);
    body += `<line x1="${x0}" y1="${y}" x2="${x1}" y2="${y}" stroke="var(--rule-2)" stroke-width="1"/>`;
    body += t(x0 - 8, y + 4, num(Math.round(top * (1 - g / 4))), "vt vt-s", "end");
  }
  const firstF = PRODUCTION.findIndex(p => p.forecast);
  const obs = PRODUCTION.slice(0, firstF);
  const fc = PRODUCTION.slice(firstF - 1);
  const dObs = obs.map((p, i) => `${i === 0 ? "M" : "L"}${px(i).toFixed(1)},${py(p.oilBbl).toFixed(1)}`).join(" ");
  body += `<path d="${dObs} L${px(obs.length - 1).toFixed(1)},${y1} L${x0},${y1} Z" fill="var(--accent)" opacity="0.10"/>`;
  body += `<path d="${dObs}" fill="none" stroke="var(--accent)" stroke-width="2.2" stroke-linejoin="round"/>`;
  body += `<path d="${fc.map((p, i) => `${i === 0 ? "M" : "L"}${px(firstF - 1 + i).toFixed(1)},${py(p.oilBbl).toFixed(1)}`).join(" ")}" fill="none" stroke="var(--accent)" stroke-width="2.2" stroke-dasharray="6 4" stroke-linejoin="round"/>`;
  body += `<line x1="${px(firstF - 1).toFixed(1)}" y1="${y0}" x2="${px(firstF - 1).toFixed(1)}" y2="${y1}" stroke="var(--ink-3)" stroke-width="1" stroke-dasharray="2 3"/>`;
  PRODUCTION.forEach((p, i) => {
    body += `<circle cx="${px(i).toFixed(1)}" cy="${py(p.oilBbl).toFixed(1)}" r="3" fill="${p.forecast ? "var(--panel)" : "var(--accent)"}" stroke="var(--accent)" stroke-width="1.6"/>`;
    body += t(px(i), y1 + 18, p.period, "vt vt-s", "middle");
  });
  const ttm = PRODUCTION[firstF - 1];
  body += t(px(firstF - 1), py(ttm.oilBbl) - 11, num(ttm.oilBbl), "vt vt-n vt-b", "middle");
  body += t(px(1), py(PRODUCTION[1].oilBbl) - 11, num(PRODUCTION[1].oilBbl), "vt vt-n", "middle");
  body += t(x0, y0 - 8, "barrels of oil, annual", "vt vt-s");
  body += t(px(firstF - 1) + 8, y0 + 6, "◀ observed  ·  forecast ▶", "vt vt-s");
  return svg(y1 + 26, body);
})();

const reconSvg = (() => {
  const x0 = 132, x1 = 600, h = 30;
  const hi = RECONCILIATION.vendorSumBbl;
  const sc = (n: number) => (n / hi) * (x1 - x0);
  let body = "";
  body += t(0, 21, "Vendor sum, 12 wells", "vt vt-b");
  body += rect(x0, 4, sc(RECONCILIATION.vendorSumBbl), h, "var(--src-vendor)", 'opacity="0.85"');
  body += t(x1 + 10, 24, num(RECONCILIATION.vendorSumBbl), "vt vt-n");
  body += t(0, 63, "Regulator lease total", "vt vt-b");
  body += rect(x0, 46, sc(RECONCILIATION.regulatorLeaseBbl), h, "var(--src-reg)", 'opacity="0.85"');
  body += rect(x0 + sc(RECONCILIATION.regulatorLeaseBbl), 46, sc(RECONCILIATION.varianceBbl), h, "none",
    'stroke="var(--crit)" stroke-width="1.4" stroke-dasharray="3 2"');
  body += t(x1 + 10, 66, num(RECONCILIATION.regulatorLeaseBbl), "vt vt-n");
  body += t(0, 105, "Unreconciled gap", "vt vt-b");
  body += rect(x0, 88, sc(RECONCILIATION.varianceBbl), h, "var(--crit)", 'opacity="0.8"');
  body += t(x0 + sc(RECONCILIATION.varianceBbl) + 10, 108, `+${num(RECONCILIATION.varianceBbl)} bbl · +${RECONCILIATION.variancePct}%`, "vt vt-n vt-crit");
  body += t(x0, 134, `Threshold ${RECONCILIATION.thresholdPct.toFixed(2)}% — exceeded`, "vt vt-s");
  return svg(148, body);
})();

const page8 = `
<section id="p8">
  <div class="shead"><span class="n">08</span><h2>Production and forecast</h2><span class="tail">${srcTag("NOVI")} well-level &nbsp;·&nbsp; ${srcTag("TRRC")} lease truth</span></div>

  <div class="viz-wrap">${productionSvg}</div>

  <div class="kpis kpis-5">${PRODUCTION_KPIS.map(k => `
    <div class="kpi">
      <div class="kpi-v">${esc(k.value)}</div>
      <div class="kpi-k">${esc(k.label)}</div>
      <div class="kpi-x">${srcTag(k.src)} ${esc(k.cls.toLowerCase())}</div>
    </div>`).join("")}</div>

  <h3 class="sub">Completion design</h3>
  <div class="kpis kpis-5">${[
    ["9,850 ft", "Lateral"], ["48", "Stages"], ["1,780 lb/ft", "Proppant"], ["42 bbl/ft", "Fluid"], ["2019", "Vintage"],
  ].map(([val, k]) => `<div class="kpi"><div class="kpi-v">${esc(val)}</div><div class="kpi-k">${esc(k)}</div><div class="kpi-x">${srcTag("NOVI")} observed</div></div>`).join("")}</div>
  <p class="fine">A 2019 completion at this intensity is what the decline above is a decline <em>from</em>. None of it appears in the regulatory record at usable resolution.</p>

  <h3 class="sub">Vendor allocation against the filed lease total</h3>
  <div class="viz-wrap">${reconSvg}</div>
  <p class="fine">${esc(RECONCILIATION.window)}. The regulator reports oil at lease level only; well-level attribution comes solely from the vendor feed. This check is impossible with a single source — and the gap is why the production confidence domain is LOW.</p>
</section>`;

// ════════════════════════════════════════════════════════════════════════════
// PAGE 9 — geology and development geometry
// ════════════════════════════════════════════════════════════════════════════
/**
 * Stratigraphic column, full width.
 *
 * Drawn on its own row rather than beside the spacing schematic: at half the
 * printable width the labels fell below legible size, and this page had the
 * vertical room to give each drawing the whole measure. Type is set larger
 * here than elsewhere because these two figures carry the page.
 */
const stratSvg = (() => {
  const bx = 40, bw2 = 300;               // the bench block
  const cx = bx + bw2 / 2;
  let y = 34, body = "";
  body += t(0, 16, "STRATIGRAPHIC POSITION", "vt vt-q");
  body += t(bx, y, "SURFACE", "vt vt-h2");
  y += 12;
  body += `<line x1="${cx}" y1="${y}" x2="${cx}" y2="${y + 62}" stroke="var(--ink-3)" stroke-width="1.8" stroke-dasharray="4 4"/>`;
  body += t(bx + bw2 + 26, y + 30, `${num(SUBSURFACE.tvdFt)} ft TVD`, "vt vt-n vt-big");
  body += t(bx + bw2 + 26, y + 50, `subsea ${num(SUBSURFACE.subseaDatumFt)} ft`, "vt vt-m");
  y += 62;
  body += `<path d="M${cx - 7},${y - 3} L${cx},${y + 8} L${cx + 7},${y - 3} Z" fill="var(--ink-3)"/>`;
  y += 16;

  // The bench is drawn to the net-to-gross proportion it actually carries.
  const benchH = 168;
  const netH = benchH * (SUBSURFACE.netPayFt / SUBSURFACE.grossIntervalFt);
  body += rect(bx, y, bw2, benchH, "var(--accent)", 'opacity="0.13"');
  body += rect(bx, y + (benchH - netH) / 2, bw2, netH, "var(--accent)", 'opacity="0.4"');
  body += `<rect x="${bx}" y="${y}" width="${bw2}" height="${benchH}" fill="none" stroke="var(--accent)" stroke-width="2"/>`;
  body += t(cx, y + 28, `${SUBSURFACE.targetFormation} · ${SUBSURFACE.benchPosition} bench`, "vt vt-b vt-big", "middle");
  body += t(cx, y + benchH / 2 + 9, `NET PAY ${SUBSURFACE.netPayFt} ft`, "vt vt-n vt-b vt-huge", "middle");
  body += t(cx, y + benchH - 16, `gross interval ${SUBSURFACE.grossIntervalFt} ft`, "vt vt-m", "middle");

  const props: Array<[string, string]> = [
    ["Porosity", `${SUBSURFACE.porosityPct}%`],
    ["Water saturation", `${SUBSURFACE.waterSaturationPct}%`],
    ["Pressure gradient", `${SUBSURFACE.pressureGradientPsiFt} psi/ft`],
    ["Net-to-gross", `${((SUBSURFACE.netPayFt / SUBSURFACE.grossIntervalFt) * 100).toFixed(0)}%`],
  ];
  props.forEach(([k, val], i) => {
    const px = bx + bw2 + 26 + (i % 2) * 200;
    const py = y + 24 + Math.floor(i / 2) * 74;
    body += t(px, py, k, "vt vt-m");
    body += t(px, py + 26, val, "vt vt-n vt-b vt-big");
  });

  y += benchH + 10;
  body += rect(bx, y, bw2, 40, "var(--ink-3)", 'opacity="0.10"');
  body += t(cx, y + 26, `${SUBSURFACE.stackedBelow} — stacked below`, "vt vt-m", "middle");
  return svg(y + 52, body);
})();

/** Plan-view spacing, full width, at the scale the geometry deserves. */
const spacingSvg = (() => {
  const x0 = 24, len = W - x0 - 150, y0 = 52;
  let body = t(0, 16, "WELL SPACING — PLAN VIEW", "vt vt-q");
  const lateral = (yy: number, label: string, sub: string, tone: string, dashed: boolean) =>
    `<line x1="${x0}" y1="${yy}" x2="${x0 + len}" y2="${yy}" stroke="${tone}" stroke-width="10" ${dashed ? 'stroke-dasharray="14 8"' : ""} stroke-linecap="round"/>` +
    `<circle cx="${x0}" cy="${yy}" r="8" fill="${tone}"/>` +
    t(x0, yy - 18, label, "vt vt-b vt-big") +
    t(x0 + len + 14, yy + 5, sub, "vt vt-m");

  body += lateral(y0, `Parent well · ${SPACING.parentCompletionYear}`, "same bench", "var(--ink-3)", false);
  const midX = x0 + len * 0.42;
  body += `<line x1="${midX}" y1="${y0 + 10}" x2="${midX}" y2="${y0 + 96}" stroke="var(--crit)" stroke-width="1.8"/>`;
  body += `<path d="M${midX - 6},${y0 + 22} L${midX},${y0 + 11} L${midX + 6},${y0 + 22} Z" fill="var(--crit)"/>`;
  body += `<path d="M${midX - 6},${y0 + 84} L${midX},${y0 + 95} L${midX + 6},${y0 + 84} Z" fill="var(--crit)"/>`;
  body += rect(midX - 48, y0 + 36, 96, 34, "var(--paper)");
  body += t(midX, y0 + 60, `${SPACING.sameBenchOffsetFt} ft`, "vt vt-n vt-b vt-huge vt-crit", "middle");

  body += lateral(y0 + 106, `Subject well · ${SPACING.subjectCompletionYear}`, `9,850 ft lateral`, "var(--accent)", false);
  body += t(x0 + len + 14, y0 + 126, `azimuth ${SPACING.lateralAzimuthDeg}°`, "vt vt-m");

  body += lateral(y0 + 212, `${SUBSURFACE.stackedBelow} offset`, "different bench", "var(--ink-3)", true);
  const offX = x0 + len * 0.78;
  body += `<line x1="${offX}" y1="${y0 + 116}" x2="${offX}" y2="${y0 + 202}" stroke="var(--ink-3)" stroke-width="1.8"/>`;
  body += rect(offX - 48, y0 + 142, 96, 34, "var(--paper)");
  body += t(offX, y0 + 166, `${SPACING.anyBenchOffsetFt} ft`, "vt vt-n vt-b vt-big", "middle");

  body += t(x0, y0 + 258, "Plan view, not to horizontal scale. Bench separation is shown by position, not by distance.", "vt vt-m");
  return svg(y0 + 272, body);
})();

const page9 = `
<section id="p9">
  <div class="shead"><span class="n">09</span><h2>Subsurface and development geometry</h2><span class="tail">${srcTag("NOVI")} — no regulatory analogue</span></div>

  <div class="viz-wrap">${stratSvg}</div>
  <div class="viz-wrap">${spacingSvg}</div>

  <div class="statusrow">
    ${pill("warn", `Parent–child: ${SPACING.parentChildStatus}`)}
    ${pill("warn", `Interference: ${SPACING.depletionInterference}`)}
    ${pill("none", `Co-developed: ${SPACING.coDeveloped ? "Yes" : "No"}`)}
    ${pill("none", `${SPACING.wellsPerSectionSameBench} wells / section, same bench`)}
    ${pill("none", `Same-bench spacing ${SPACING.sameBenchOffsetFt} ft`)}
  </div>
  <p class="fine">${esc(SPACING.interferenceBasis)}. Parent–child position materially affects the forecast that drives base value, and is not derivable from any regulatory filing — it is the clearest single case of vendor data changing a valuation input.</p>

  <details class="more"><summary>Full completion and petrophysical record</summary>
    <div class="scroll"><table>
      <thead><tr><th>Measure</th><th>Source</th><th>Classification</th><th class="num">Value</th></tr></thead>
      <tbody>${(COMPLETION as Measure[]).map(m => `<tr><td>${esc(m.label)}</td><td>${srcTag(m.src)}</td><td>${esc(m.cls)}</td><td class="num">${esc(m.value)}</td></tr>`).join("")}
      <tr><td>Target formation</td><td>${srcTag("NOVI")}</td><td>Observed</td><td class="num">${esc(SUBSURFACE.targetFormation)}</td></tr>
      <tr><td>True vertical depth</td><td>${srcTag("NOVI")}</td><td>Observed</td><td class="num">${num(SUBSURFACE.tvdFt)} ft</td></tr>
      <tr><td>Gross interval</td><td>${srcTag("NOVI")}</td><td>Observed</td><td class="num">${SUBSURFACE.grossIntervalFt} ft</td></tr>
      <tr><td>Net pay</td><td>${srcTag("NOVI")}</td><td>Observed</td><td class="num">${SUBSURFACE.netPayFt} ft</td></tr>
      <tr><td>Porosity</td><td>${srcTag("NOVI")}</td><td>Observed</td><td class="num">${SUBSURFACE.porosityPct}%</td></tr>
      <tr><td>Water saturation</td><td>${srcTag("NOVI")}</td><td>Observed</td><td class="num">${SUBSURFACE.waterSaturationPct}%</td></tr>
      <tr><td>Pressure gradient</td><td>${srcTag("NOVI")}</td><td>Observed</td><td class="num">${SUBSURFACE.pressureGradientPsiFt} psi/ft</td></tr>
      <tr><td>Depletion interference</td><td>${srcTag("NOVI")}</td><td>Inferred</td><td class="num">${esc(SPACING.depletionInterference)}</td></tr>
      </tbody>
    </table></div>
  </details>
</section>`;

// ════════════════════════════════════════════════════════════════════════════
// PAGE 10 — ownership flow
// ════════════════════════════════════════════════════════════════════════════
const ownershipSvg = (() => {
  const box = (x: number, y: number, w: number, h: number, name: string, share: string, tone: string, dashed = false) =>
    rect(x, y, w, h, tone === "crit" ? "var(--crit)" : tone === "ok" ? "var(--ok)" : "var(--ink-3)", 'opacity="0.09"') +
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${tone === "crit" ? "var(--crit)" : tone === "ok" ? "var(--ok)" : "var(--ink-3)"}" stroke-width="1.5" ${dashed ? 'stroke-dasharray="4 3"' : ""}/>` +
    t(x + w / 2, y + 20, name, "vt vt-b", "middle") +
    t(x + w / 2, y + 37, share, "vt vt-n vt-b", "middle");

  // The heirship split fans two boxes out from `lx`, so the tree needs clear
  // space to the left of its trunk. Earlier the leftmost box started at a
  // negative x and was clipped by the viewBox.
  const bw = 158, bh = 48;
  let body = "";
  const cx = 300;
  body += box(cx - bw / 2, 6, bw, bh, "E. J. Caldwell", "100%", "ok");
  body += t(cx + bw / 2 + 10, 26, "1962 deed", "vt vt-s");
  body += arrowDown(cx, 6 + bh, 78);
  body += box(cx - bw / 2, 78, bw, bh, "Ruth A. Caldwell", "100%", "ok");
  body += t(cx + bw / 2 + 10, 98, "1978 · reserves 1/2", "vt vt-s");

  // Split: reservation stays with Caldwell line, remainder passes to Prather.
  const lx = 146, rx = 454;
  body += `<path d="M${cx},${78 + bh} L${cx},${150} L${lx},${150} L${lx},${168}" fill="none" stroke="var(--ink-3)" stroke-width="1.3"/>`;
  body += `<path d="M${cx},${150} L${rx},${150} L${rx},${168}" fill="none" stroke="var(--ink-3)" stroke-width="1.3"/>`;
  body += `<path d="M${lx - 4},${161} L${lx},${168} L${lx + 4},${161} Z" fill="var(--ink-3)"/>`;
  body += `<path d="M${rx - 4},${161} L${rx},${168} L${rx + 4},${161} Z" fill="var(--ink-3)"/>`;

  body += box(rx - bw / 2, 168, bw, bh, "M. D. Prather", "1/2", "ok");
  body += t(rx + bw / 2 + 10, 188, "2004 mineral deed", "vt vt-s");
  body += arrowDown(rx, 168 + bh, 244);
  body += box(rx - bw / 2, 244, bw, bh, "Ashfords", "1/2 · 80.00 NMA", "warn");
  body += t(rx, 244 + bh + 15, "no stated split · E-03", "vt vt-s", "middle");

  body += box(lx - bw / 2, 168, bw, bh, "Caldwell heirs", "1/2", "ok");
  body += t(lx + bw / 2 + 8, 188, "2011 heirship", "vt vt-s");
  const l1 = lx - 60, l2 = lx + 60;
  body += `<path d="M${lx},${168 + bh} L${lx},${214} L${l1},${214} L${l1},${240}" fill="none" stroke="var(--ink-3)" stroke-width="1.3"/>`;
  body += `<path d="M${lx},${214} L${l2},${214} L${l2},${240}" fill="none" stroke="var(--ink-3)" stroke-width="1.3"/>`;
  body += `<path d="M${l1 - 4},${233} L${l1},${240} L${l1 + 4},${233} Z" fill="var(--ink-3)"/>`;
  body += `<path d="M${l2 - 4},${233} L${l2},${240} L${l2 + 4},${233} Z" fill="var(--ink-3)"/>`;
  body += box(l1 - 56, 240, 112, bh, "Janet C. Boyd", "1/4 · 40.00 NMA", "ok");
  body += `<rect x="${l1 - 60}" y="${236}" width="120" height="${bh + 8}" fill="none" stroke="var(--accent)" stroke-width="2"/>`;
  body += t(l1, 240 + bh + 20, "EVALUATED POSITION", "vt vt-q", "middle");
  body += box(l2 - 56, 240, 112, bh, "T. E. Caldwell", "1/4 · 40.00 NMA", "ok");

  // The competing claim never joins the tree; it is drawn against it.
  const sx = 672;
  body += box(sx - 74, 78, 148, bh, "H. W. Stiles", "no evidenced source", "crit", true);
  body += t(sx, 78 + bh + 16, "2016 deed · 1/8", "vt vt-s", "middle");
  body += `<path d="M${sx},${78 + bh + 24} L${sx},${300}" fill="none" stroke="var(--crit)" stroke-width="1.5" stroke-dasharray="5 4"/>`;
  body += `<path d="M${sx - 5},${292} L${sx},${300} L${sx + 5},${292} Z" fill="var(--crit)"/>`;
  body += t(sx, 320, "would dilute", "vt vt-s", "middle");
  body += t(sx, 334, "every holder", "vt vt-s", "middle");
  return svg(348, body, 780);
})();

const page10 = `
<section id="p10">
  <div class="shead"><span class="n">10</span><h2>How ownership was derived</h2><span class="tail">${srcTag("COUNTY")} instruments · exact fractions</span></div>
  <div class="viz-wrap">${ownershipSvg}</div>

  <div class="pair">
    <div class="bigstat bigstat-ok">
      <div class="bs-k">Reconciled estate</div>
      <div class="bs-v">${esc(COMPETING_CLAIM.excludedAllocation)}</div>
      <div class="bs-n">${MARK.ok} Allocates exactly, across three holdings</div>
    </div>
    <div class="bigstat bigstat-crit">
      <div class="bs-k">If the ${esc(COMPETING_CLAIM.fraction)} claim is included</div>
      <div class="bs-v">${esc(COMPETING_CLAIM.includedAllocation)}</div>
      <div class="bs-n">${MARK.crit} Over-allocates to ${COMPETING_CLAIM.includedPct}% — every holder above is diluted</div>
    </div>
  </div>

  <div class="estate">${RECONCILED_ESTATE.map(h => `
    <div class="est ${h.evaluated ? "est-sel" : ""}" style="flex:${h.decimal}">
      <div class="est-s">${esc(h.share)}</div>
      <div class="est-h">${esc(h.holder)}</div>
      <div class="est-n">${h.nma.toFixed(2)} NMA${h.note ? ` · ${esc(h.note)}` : ""}</div>
    </div>`).join("")}</div>

  <p class="fine">Fractions are exact rationals throughout — the evaluated ${esc(`${record.evaluatedPosition.mineralFraction?.n}/${record.evaluatedPosition.mineralFraction?.d}`)} interest becomes ${esc(record.evaluatedPosition.netRevenueInterest?.toFixed(8) ?? "—")} as ${esc(record.evaluatedPosition.derivation.replace(/\.\s*$/, ""))}. The collective holding is carried as one undivided position because the instrument states no split between the two grantees; equal shares are never assumed. Whether the competing claim burdens this position is a determination for counsel, not for this system.</p>

</section>`;

// ════════════════════════════════════════════════════════════════════════════
// PAGE 11 — regulatory standing
// ════════════════════════════════════════════════════════════════════════════
const FRESH_MARK: Record<string, "ok" | "warn" | "none" | "part"> = { current: "ok", stale: "warn", missing: "none", partial: "part" };
const freshnessBlock = `
<h3 class="sub">Source coverage and freshness</h3>
  <div class="freshcards">${record.sourceFreshness.map(f => `
    <div class="fc fc-${f.status}">
      <div class="fc-top">${pill(FRESH_MARK[f.status], f.status)}<span class="fc-age">${f.ageDays == null ? "—" : `${f.ageDays}d`} <span class="muted">/ ${f.staleAfterDays}d window</span></span></div>
      <div class="fc-k">${esc(f.source)}</div>
      <div class="fc-d mono">${esc(f.retrievedAt ?? NOT_PROVIDED_LABEL)}</div>
      <div class="fc-c">${esc(f.coverage)}</div>
      <div class="fc-n">${esc(f.note)}</div>
    </div>`).join("")}</div>
  <p class="fine">A gap that was never searched and a search that returned nothing are recorded differently. The pre-1962 window is marked missing rather than clean, and the chain's earliest evidenced holder reflects that boundary rather than a finding about original ownership.</p>
`;

const regRetrieved = record.sourceFreshness.find(f => f.role === "regulator");
const instrumentTable = `  <h3 class="sub">Instruments reviewed</h3>
  <div class="scroll"><table>
    <thead><tr><th>Recorded</th><th>Instrument</th><th>From → to</th><th class="num">Fraction</th><th>Support</th></tr></thead>
    <tbody>${INSTRUMENTS.map(i => `<tr>
      <td class="mono">${esc(i.recorded)}</td><td>${esc(i.kind)}</td>
      <td>${esc(i.from)} → ${esc(i.to)}</td><td class="num mono">${esc(i.fraction)}</td>
      <td>${pill(i.support === "unsupported" ? "crit" : i.support === "unresolved" ? "warn" : i.support === "earliest" ? "part" : "ok", i.supportLabel)}</td></tr>`).join("")}</tbody>
  </table></div>
  <p class="fine">Ordered by recording date, which arranges the table and does not determine legal effect or priority. Three further instruments are known from the county index only; their text was not reviewed and they are excluded from the reconstruction. Nothing before 1962 was searched, so the earliest evidenced holder marks the limit of the search, not the start of the chain.</p>
`;

const page11 = `
<section id="p11">
  <div class="shead"><span class="n">11</span><h2>Regulatory standing</h2><span class="tail">${srcTag("TRRC")} — no vendor coverage</span></div>
  <div class="statuscards">${REGULATORY.map(r => `
    <div class="stc stc-${r.status}">
      <div class="stc-m">${MARK[r.status === "ok" ? "ok" : r.status === "warn" ? "warn" : "none"]}</div>
      <div class="stc-k">${esc(r.record)}</div>
      <div class="stc-v">${esc(r.finding)}</div>
      <div class="stc-n">${esc(r.detail)}</div>
      <div class="stc-s">${srcTag(r.src)}</div>
    </div>`).join("")}</div>
  ${freshnessBlock}
  <p class="fine">Retrieved ${esc(regRetrieved?.retrievedAt ?? NOT_PROVIDED_LABEL)}${regRetrieved && regRetrieved.status !== "current" ? ` — ${esc(regRetrieved.status)} against its ${regRetrieved.staleAfterDays}-day window, and reported as such wherever these records are used` : ""}. These categories have no analogue in a vendor analytics feed and are the ones that most often surprise an acquirer after closing. A record this system could not obtain is reported as missing, with the attempted source and time: retrieval failure is never read as absence of an issue.</p>
</section>`;

// ════════════════════════════════════════════════════════════════════════════
// PAGE 12 — title becomes dollars
// ════════════════════════════════════════════════════════════════════════════
/**
 * The convergence: two sources that each produce nothing on their own.
 *
 * County instruments yield an ownership decimal but no dollars. Vendor
 * analytics yield dollars for a whole wellbore but cannot say whose they are.
 * Multiplied, they produce a position value — and re-running the left branch
 * against the competing claim prices the title exception. This is the one
 * drawing that shows why the product exists, so it owns its page.
 */
const convergenceSvg = (() => {
  const colW = 300, lx = 0, rx = W - colW;
  const chipH = 44, chipGap = 12;
  let body = "";

  const column = (x: number, title: string, tag: string, colour: string, rows: Array<[string, string]>) => {
    let out = rect(x, 0, colW, 3, colour);
    out += t(x, 24, title, "vt vt-src2");
    out += t(x + colW, 24, tag, "vt vt-m", "end");
    let yy = 38;
    rows.forEach(([k, val], i) => {
      out += rect(x, yy, colW, chipH, colour, 'opacity="0.07"');
      out += `<rect x="${x}" y="${yy}" width="${colW}" height="${chipH}" fill="none" stroke="${colour}" stroke-width="1" opacity="0.5"/>`;
      out += t(x + 14, yy + 18, k, "vt vt-m");
      out += t(x + colW - 14, yy + 31, val, "vt vt-n vt-b vt-big", "end");
      if (i < rows.length - 1) out += arrowDown(x + colW / 2, yy + chipH, yy + chipH + chipGap, colour);
      yy += chipH + chipGap;
    });
    return { out, bottom: yy - chipGap };
  };

  const left = column(lx, "COUNTY · TITLE", "instruments", "var(--ink-2)", [
    ["Mineral fraction", `${record.evaluatedPosition.mineralFraction?.n}/${record.evaluatedPosition.mineralFraction?.d}`],
    ["Net mineral acres", record.evaluatedPosition.netMineralAcres?.toFixed(2) ?? "—"],
    ["Tract participation", "25.0000%"],
    ["Lease royalty", "3/16"],
    ["Net revenue interest", baseNri?.toFixed(8) ?? "—"],
  ]);
  const right = column(rx, "NOVI · ECONOMICS", "vendor feed", "var(--src-vendor)", [
    ["Remaining oil", `${num(INPUT.remainingOilBbl ?? 0)} bbl`],
    ["Remaining gas", `${num(INPUT.remainingGasMcf ?? 0)} mcf`],
    ["Price deck", baseDeck ? `$${baseDeck.oilUsdPerBbl.toFixed(2)} · $${baseDeck.gasUsdPerMcf.toFixed(2)}` : "—"],
    ["Annual decline", pctS(INPUT.annualDecline)],
    ["PV factor", v.pvFactor?.toFixed(7) ?? "—"],
  ]);
  body += left.out + right.out;

  // Both columns turn inward into the decision layer.
  const joinY = Math.max(left.bottom, right.bottom) + 26;
  const barY = joinY + 22, barH = 50;
  body += `<path d="M${lx + colW / 2},${left.bottom} L${lx + colW / 2},${joinY} L${W / 2},${joinY} L${W / 2},${barY - 8}" fill="none" stroke="var(--ink-3)" stroke-width="1.6"/>`;
  body += `<path d="M${rx + colW / 2},${right.bottom} L${rx + colW / 2},${joinY} L${W / 2},${joinY} L${W / 2},${barY - 8}" fill="none" stroke="var(--ink-3)" stroke-width="1.6"/>`;
  body += `<path d="M${W / 2 - 6},${barY - 9} L${W / 2},${barY - 1} L${W / 2 + 6},${barY - 9} Z" fill="var(--ink-3)"/>`;
  body += t(lx + colW / 2 + 12, joinY - 10, "ownership decimal", "vt vt-m");
  body += t(rx + colW / 2 - 12, joinY - 10, "cash flow", "vt vt-m", "end");

  body += rect(0, barY, W, barH, "var(--accent)", 'opacity="0.10"');
  body += `<rect x="0" y="${barY}" width="${W}" height="${barH}" fill="none" stroke="var(--accent)" stroke-width="1.6"/>`;
  body += t(W / 2, barY + 32, "MINERALFLOW AI · DECISION LAYER", "vt vt-lay", "middle");

  // Primary outcome, then the same chain re-run against the competing claim.
  const outY = barY + barH + 30, outH = 86, outW = 330;
  body += arrowDown(W / 2, barY + barH, outY);
  body += rect((W - outW) / 2, outY, outW, outH, "var(--ok)", 'opacity="0.10"');
  body += `<rect x="${(W - outW) / 2}" y="${outY}" width="${outW}" height="${outH}" fill="none" stroke="var(--ok)" stroke-width="2"/>`;
  body += t(W / 2, outY + 24, "POSITION VALUE, PV-10", "vt vt-q", "middle");
  body += t(W / 2, outY + 62, usd(c.baseEconomicValueUsd), "vt vt-n vt-b vt-mega", "middle");

  // The competing-claim branch sits below and right of the primary outcome. The
  // caption sits above the routing line rather than across it, and every label
  // inside the box is anchored to an edge so none can overlap another.
  const brY = outY + outH + 62, brH = 82, brW = 330;
  const brX = W - brW, brMid = brX + brW / 2;
  body += t(0, brY - 46, `Re-run the title branch with the ${COMPETING_CLAIM.fraction} claim included`, "vt vt-m");
  body += `<path d="M${W / 2},${outY + outH} L${W / 2},${brY - 26} L${brMid},${brY - 26} L${brMid},${brY - 9}" fill="none" stroke="var(--crit)" stroke-width="1.6" stroke-dasharray="5 4"/>`;
  body += `<path d="M${brMid - 6},${brY - 10} L${brMid},${brY - 1} L${brMid + 6},${brY - 10} Z" fill="var(--crit)"/>`;
  body += rect(brX, brY, brW, brH, "var(--crit)", 'opacity="0.08"');
  body += `<rect x="${brX}" y="${brY}" width="${brW}" height="${brH}" fill="none" stroke="var(--crit)" stroke-width="1.6" stroke-dasharray="5 4"/>`;
  body += t(brX + 18, brY + 24, `NRI ${admittedNri?.toFixed(8) ?? "—"}`, "vt vt-n vt-m");
  body += t(brX + 18, brY + 60, usd(admitted?.economicValueUsd ?? null), "vt vt-n vt-b vt-huge");
  body += t(brX + brW - 18, brY + 40, usd(admitted?.deltaUsd ?? null), "vt vt-n vt-b vt-big vt-crit", "end");
  body += t(brX + brW - 18, brY + 62, pctS(admitted?.deltaPct ?? null), "vt vt-n vt-b vt-big vt-crit", "end");
  body += t(0, brY + 34, "MEASURED TITLE EXPOSURE", "vt vt-q");
  body += t(0, brY + 56, "the difference between two full", "vt vt-m");
  body += t(0, brY + 74, "engine runs, not an estimate", "vt vt-m");

  return svg(brY + brH + 14, body);
})();

const page12 = `
<section id="p12">
  <div class="shead"><span class="n">12</span><h2>Title becomes dollars</h2><span class="tail">The one calculation neither party makes alone</span></div>
  <div class="viz-wrap">${convergenceSvg}</div>
  <p class="fine">The vendor supplies volumes, prices and cost structure. The title chain supplies the decimal that says what fraction of that cash flow belongs to the evaluated position. Neither input produces a number by itself.</p>

</section>`;

// ════════════════════════════════════════════════════════════════════════════
// PAGE 13 — sources and freshness
// ════════════════════════════════════════════════════════════════════════════


// ════════════════════════════════════════════════════════════════════════════
// PAGE 14 — audit trail
// ════════════════════════════════════════════════════════════════════════════
const page13 = `
<section id="p13">
  <div class="shead"><span class="n">13</span><h2>Audit trail</h2><span class="tail">Source → fact → derivation → rule → output</span></div>

  <div class="tracestrip">${record.ruleTrace.map(tr => `
    <div class="tr ${tr.matched ? "tr-hit" : ""}">
      <span class="tr-id">${esc(tr.ruleId)}</span>
      <span class="tr-o">${tr.matched ? `${MARK.ok} MATCH` : "no match"}</span>
    </div>`).join("")}</div>
  <p class="fine">Rules evaluate in precedence order and the first match wins. Every rule reached is shown with its own outcome, so what was ruled out on the way to ${esc(record.postureRuleId)} is visible. Ruleset ${esc(record.decisionRuleVersion)}.</p>

  ${record.auditTrail.map(a => `
  <div class="audit">
    <div class="audit-q">${esc(a.question)}</div>
    <dl class="qa">
      <dt>Source</dt><dd>${esc(a.source)}${a.sourceTimestamp ? ` <span class="muted mono">${esc(a.sourceTimestamp)}</span>` : ""}</dd>
      <dt>Raw fact</dt><dd>${esc(a.rawFact)}</dd>
      <dt>Classification</dt><dd><span class="cls cls-${a.classification.toLowerCase()}">${esc(a.classification.replace(/_/g, " "))}</span></dd>
      <dt>Derivation</dt><dd>${esc(a.derivation)}</dd>
      <dt>Effect</dt><dd>${esc(a.effect)}</dd>
      <dt>Decision rule</dt><dd class="mono">${esc(a.decisionRule)}</dd>
      <dt>Output</dt><dd><b>${esc(a.output)}</b></dd>
    </dl>
  </div>`).join("")}
</section>`;

const appendixDetail = `
  <h3 class="sub">Closing requirements, itemised</h3>
  <div class="checkcols">
    ${([
      ["Unresolved title", r4.unresolvedTitleIssues],
      ["Missing instruments", r4.missingInstruments],
      ["Regulatory", r4.unresolvedRegulatoryIssues],
      ["Economic assumptions", r4.unresolvedEconomicAssumptions],
      ["Requires counsel", r4.requiredProfessionalReview],
      ["Actions before closing", r4.actionsBeforeClosing],
    ] as Array<[string, string[]]>).map(([label, items]) => `
      <div class="cc">
        <h4>${esc(label)} <span class="cc-n">${items.length}</span></h4>
        ${items.length
          ? `<ul class="ticks t-none">${items.map(x => `<li>${esc(x)}</li>`).join("")}</ul>`
          : `<p class="none">${MARK.ok} None outstanding</p>`}
      </div>`).join("")}
  </div>

  <h3 class="sub">Cost and tax assumptions</h3>
  <div class="scroll"><table>
    <thead><tr><th>Assumption</th><th>Source</th><th class="num">Value</th><th>Note</th></tr></thead>
    <tbody>${COSTS.map(m => `<tr><td>${esc(m.label)}</td><td>${srcTag(m.src)}</td><td class="num">${esc(m.value)}</td><td class="muted">${esc(m.note ?? "")}</td></tr>`).join("")}</tbody>
  </table></div>
  <p class="fine">Capital is sunk; operating cost is carried for completeness and does not burden a royalty position. Present value uses a ${esc(pctS(v.criteria.discountRate.value))} discount rate with ${esc(String(v.criteria.timingConvention.value ?? "").toLowerCase())} over ${esc(String(v.criteria.forecastHorizonYears.value ?? "—"))} years, giving a factor of ${v.pvFactor?.toFixed(7) ?? "—"} derived from the ${esc(pctS(INPUT.annualDecline))} annual decline — not asserted as a round number.</p>
`;

// ════════════════════════════════════════════════════════════════════════════
// assemble
// ════════════════════════════════════════════════════════════════════════════
const prior = fs.readFileSync(path.join(outDir, "jv-decision-record.html"), "utf8");
const style = prior.slice(prior.indexOf("<style>"), prior.indexOf("</style>") + 8);
const notice = prior.slice(prior.indexOf('<div class="notice">'), prior.indexOf("</div></div>") + 12);
const legacy = prior.slice(prior.indexOf("<!-- 2 -->"));

/**
 * Evidence appendix.
 *
 * The visual pages above now carry every headline the long-form report used to
 * assert, so only the sections that still add evidence a reader could not get
 * from them are retained: the wellbore-level reconciliation table and the
 * source inventory. Everything else was superseded, and keeping it would put
 * two presentations of the same figure in one document — which is how the
 * earlier draft ended up disagreeing with its own engine.
 */
const sectionOf = (id: string) => {
  const start = legacy.indexOf(`<section id="${id}">`);
  if (start < 0) return "";
  const end = legacy.indexOf("</section>", start);
  return end < 0 ? "" : legacy.slice(start, end + 10);
};
// The closing legal block carries the title-opinion disclaimers and must
// survive every restructure of what sits above it.
const footStart = legacy.indexOf('<div class="foot">');
if (footStart < 0) throw new Error("Closing legal block not found; the report must not ship without its disclaimers.");
const closing = legacy.slice(footStart);

let detail = `
<section id="appendix">
  <div class="shead"><span class="n">A</span><h2>Evidence appendix</h2><span class="tail">Detail behind the pages above</span></div>
  <p class="lede">The instruments the ownership reconstruction was built from, the closing requirements itemised, the cost and tax assumptions, the wellbore-level production reconciliation, and the full source inventory. Every figure here also appears on a page above; nothing in this appendix is computed separately.</p>
${instrumentTable}
${appendixDetail}
</section>
${sectionOf("s2").replace('<span class="n">02</span>', '<span class="n">A1</span>')}
${sectionOf("s9").replace('<span class="n">09</span>', '<span class="n">A2</span>')}
${closing}`;

// The retained sections were authored by hand. Anything they still assert has
// to agree with the engine, so the corrections applied to them are explicit.
{
  const reg = record.sourceFreshness.find(f => f.role === "regulator");
  if (reg?.retrievedAt) {
    // One regulatory dataset cannot carry two retrieval dates. The rows take
    // theirs from the same freshness entry that grades them.
    detail = detail.split(`<td class="mono" style="font-size:11.5px">${INPUT.asOfDate}</td>`)
      .join(`<td class="mono" style="font-size:11.5px">${esc(reg.retrievedAt)}</td>`);
  }
  detail = detail
    .split("Claim admitted as valid").join("Claim included in the estate")
    .split("If the claim is good, every holder above is diluted and the estate over-allocates.")
    .join("If that claim is ultimately determined to burden this position, every holder above is diluted and the estate over-allocates.");
}

// Guards. These are the figures and codes the legacy markup used to assert on
// its own; if any survives a future edit, the build stops rather than shipping
// a record that contradicts itself.
const MUST_NOT_CONTAIN = ["$48,500", "$43,100", "$67,300", "$59,800", "$7,500", "$5,400",
  "E-05", "E-06", "E-07", "admitted as valid", `>${INPUT.asOfDate}</td>`];
for (const stale of MUST_NOT_CONTAIN) {
  if (detail.includes(stale)) {
    throw new Error(`Evidence appendix still carries the hand-authored value or code "${stale}". It must be derived from the decision record.`);
  }
}

const extra = `<style>
/* ── page-1 verdict ─────────────────────────────────────────────────────── */
.verdict{border:1px solid var(--rule);border-left-width:6px;padding:20px 22px;margin-bottom:16px;background:var(--panel)}
.verdict-ok{border-left-color:var(--ok)} .verdict-warn{border-left-color:var(--warn)}
.verdict-crit{border-left-color:var(--crit)} .verdict-neutral{border-left-color:var(--ink-3)}
.vlabel{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-3);font-weight:600}
.vvalue{font-family:"IBM Plex Serif",Georgia,serif;font-size:42px;font-weight:600;line-height:1.02;margin:6px 0 10px;letter-spacing:-.015em}
.thesis{font-size:14px;line-height:1.45;color:var(--ink-2);margin:0;max-width:96ch}

/* ── KPI tiles ──────────────────────────────────────────────────────────── */
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--rule);border:1px solid var(--rule);margin-bottom:16px}
.kpis-5{grid-template-columns:repeat(5,1fr)}
.kpi{background:var(--panel);padding:12px 14px}
.kpi-v{font-family:"IBM Plex Mono",monospace;font-size:23px;font-weight:600;line-height:1.1;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.kpi-v.crit{color:var(--crit)} .kpi-v.ok{color:var(--ok)} .kpi-v.warn{color:var(--warn)}
.kpi-v.flag{color:var(--warn)} .kpi-v.neutral{color:var(--ink-3)}
.kpi-k{font-size:9.5px;letter-spacing:.11em;text-transform:uppercase;color:var(--ink-3);font-weight:600;margin-top:5px}
.kpi-x{font-size:10px;color:var(--ink-3);margin-top:3px;font-family:"IBM Plex Mono",monospace}

/* ── three answer columns ───────────────────────────────────────────────── */
.three{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;margin-bottom:4px}
.three h3{font-size:10.5px;letter-spacing:.11em;text-transform:uppercase;font-weight:600;
  border-bottom:2px solid var(--rule);padding-bottom:6px;margin:0 0 9px;display:flex;gap:7px;align-items:center}
.col-ok h3{border-bottom-color:var(--ok);color:var(--ok)}
.col-warn h3{border-bottom-color:var(--warn);color:var(--warn)}
.col-none h3{border-bottom-color:var(--ink-3);color:var(--ink-2)}
.cm{font-size:12px}
ul.ticks{list-style:none;margin:0;padding:0;font-size:11.5px;line-height:1.4;color:var(--ink-2)}
ul.ticks li{position:relative;padding-left:15px;margin-bottom:6px}
ul.ticks li::before{position:absolute;left:0;top:0;font-weight:600}
.t-ok li::before{content:"✓";color:var(--ok)}
.t-warn li::before{content:"⚠";color:var(--warn)}
.t-none li::before{content:"○";color:var(--ink-3)}

/* ── visuals ────────────────────────────────────────────────────────────── */
.viz-wrap{margin:6px 0 14px;overflow-x:auto}
svg.viz{display:block;width:100%;height:auto;max-width:100%}
.vt{font-family:"IBM Plex Sans",sans-serif;font-size:11px;fill:var(--ink-2)}
.vt-b{font-weight:600;fill:var(--ink)}
.vt-s{font-size:9.5px;fill:var(--ink-3)}
.vt-h{font-size:10px;font-weight:600;fill:var(--ink-3);letter-spacing:.09em}
.vt-q{font-size:9.5px;font-weight:600;fill:var(--ink-3);letter-spacing:.13em}
.vt-n{font-family:"IBM Plex Mono",monospace;font-variant-numeric:tabular-nums}
.vt-crit{fill:var(--crit)}
.vt-plus{font-size:19px;fill:var(--ink-3)}
.vt-item{font-size:13px}
.vt-m{font-size:13px;fill:var(--ink-3)}
.vt-h2{font-size:12px;font-weight:600;fill:var(--ink-3);letter-spacing:.11em}
.vt-big{font-size:15px}
.vt-huge{font-size:19px}
.vt-mega{font-size:30px}
.vt-src2{font-family:"IBM Plex Mono",monospace;font-size:13px;font-weight:600;letter-spacing:.11em;fill:var(--ink)}
.vt-src{font-family:"IBM Plex Mono",monospace;font-size:15px;font-weight:600;letter-spacing:.1em;fill:var(--ink)}
.vt-lay{font-family:"IBM Plex Mono",monospace;font-size:16px;font-weight:600;letter-spacing:.14em;fill:var(--accent)}

/* ── scenario / stat cards ──────────────────────────────────────────────── */
.scen3{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:14px}
.sc{border:1px solid var(--rule);border-top-width:4px;padding:12px 14px;background:var(--panel)}
.sc-down{border-top-color:var(--crit)} .sc-base{border-top-color:var(--accent)} .sc-up{border-top-color:var(--ok)}
.sc-k{font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-3);font-weight:600}
.sc-v{font-family:"IBM Plex Mono",monospace;font-size:26px;font-weight:600;margin:4px 0 2px;letter-spacing:-.02em}
.sc-x{font-family:"IBM Plex Mono",monospace;font-size:10px;color:var(--ink-3)}
.sc-n{font-size:10.5px;color:var(--ink-2);margin-top:5px}

.pair{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px}
.bigstat{border:1px solid var(--rule);border-left-width:4px;border-left-color:var(--ink-3);padding:13px 15px;background:var(--panel)}
.bigstat-flag{border-left-color:var(--warn);background:var(--warn-soft)}
.bigstat-crit{border-left-color:var(--crit)} .bigstat-ok{border-left-color:var(--ok)} .bigstat-warn{border-left-color:var(--warn)}
.bs-k{font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-3);font-weight:600}
.bs-v{font-family:"IBM Plex Serif",Georgia,serif;font-size:28px;font-weight:600;line-height:1.1;margin:3px 0 4px}
.bs-n{font-size:10.5px;color:var(--ink-2);line-height:1.4}

/* ── criteria chips ─────────────────────────────────────────────────────── */
.critgrid{display:grid;grid-template-columns:repeat(6,1fr);gap:1px;background:var(--rule);border:1px solid var(--rule);margin-bottom:8px}
.cg{background:var(--panel);padding:9px 10px}
.cg-flag{background:var(--warn-soft)}
.cg-k{font-size:9px;letter-spacing:.09em;text-transform:uppercase;color:var(--ink-3);font-weight:600}
.cg-v{font-family:"IBM Plex Mono",monospace;font-size:12.5px;font-weight:600;margin:3px 0 2px;line-height:1.2}
.cg-flag .cg-v{color:var(--warn);font-size:9.5px}
.cg-c{font-size:9px;color:var(--ink-3);text-transform:uppercase;letter-spacing:.06em}

/* ── breakpoint cards ───────────────────────────────────────────────────── */
.bpcards{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.bp{border:1px solid var(--rule);border-top:3px solid var(--accent);padding:11px 13px;background:var(--panel)}
.bp-flag{border-top-color:var(--warn);background:var(--warn-soft)}
.bp-var{font-size:11px;font-weight:600;margin-bottom:7px}
.bp-flow{display:flex;flex-wrap:wrap;gap:6px;align-items:baseline;font-family:"IBM Plex Mono",monospace;font-size:10.5px;margin-bottom:6px}
.bp-now{color:var(--ink-3)} .bp-arr{color:var(--ink-3)} .bp-at{font-weight:600}
.bp-at.flag{color:var(--warn);font-size:9px}
.bp-con{font-size:10.5px;color:var(--ink-2);line-height:1.4}

/* ── exception cards ────────────────────────────────────────────────────── */
.excards{display:grid;grid-template-columns:1fr 1fr;gap:11px}
.ex{border:1px solid var(--rule);border-left:4px solid var(--warn);padding:12px 14px;background:var(--panel)}
.ex-block{border-left-color:var(--crit)}
.ex-h{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;margin-bottom:8px}
.ex-id{font-family:"IBM Plex Mono",monospace;font-size:12px;font-weight:600;color:var(--ink-3)}
.ex-t{font-size:12.5px;font-weight:600;flex:1 1 100%}
.ex-chain{display:flex;gap:6px;flex-wrap:wrap;font-family:"IBM Plex Mono",monospace;font-size:9px;
  letter-spacing:.09em;color:var(--ink-3);margin-bottom:8px}
.ex-arr{color:var(--ink-3)}
.ex-meas{display:flex;gap:7px;align-items:center;flex-wrap:wrap;margin-bottom:8px}
.em{font-family:"IBM Plex Mono",monospace;font-size:11px;background:var(--neutral-soft);padding:3px 7px;border-radius:2px}
.em-crit{color:var(--crit);background:var(--crit-soft);font-weight:600}
.ex-unq{font-size:10.5px;color:var(--warn);background:var(--warn-soft);padding:6px 8px;margin-bottom:8px;line-height:1.4}
.ex-flags{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:8px}
.ex-next{font-size:10.5px;color:var(--ink-2);line-height:1.4;border-top:1px solid var(--rule-2);padding-top:7px}

.pill{display:inline-flex;align-items:center;gap:4px;font-size:9.5px;font-weight:600;letter-spacing:.04em;
  padding:2px 7px;border-radius:2px;border:1px solid;white-space:nowrap}
.pm{font-size:10px}
.pill-ok{color:var(--ok);border-color:var(--ok);background:var(--ok-soft)}
.pill-warn{color:var(--warn);border-color:var(--warn);background:var(--warn-soft)}
.pill-crit{color:var(--crit);border-color:var(--crit);background:var(--crit-soft)}
.pill-none{color:var(--ink-3);border-color:var(--rule);background:var(--neutral-soft)}
.pill-part{color:var(--accent);border-color:var(--accent);background:var(--accent-soft)}

/* ── scenario comparison ────────────────────────────────────────────────── */
.scomp{display:grid;grid-template-columns:1fr 1fr 0.75fr;gap:14px;align-items:start;margin-bottom:16px}
.stack{border:1px solid var(--rule);background:var(--panel)}
.stack-h{font-size:11.5px;font-weight:600;padding:9px 12px;border-bottom:1px solid var(--rule);display:flex;justify-content:space-between;gap:8px}
.stack-h span{font-size:9.5px;font-weight:400;color:var(--ink-3);text-transform:uppercase;letter-spacing:.08em}
.stack-ok .stack-h{border-top:3px solid var(--ok)} .stack-crit .stack-h{border-top:3px solid var(--crit)}
.stack-r{padding:8px 12px}
.stack-k{font-size:9px;letter-spacing:.09em;text-transform:uppercase;color:var(--ink-3);font-weight:600}
.stack-v{font-family:"IBM Plex Mono",monospace;font-size:14px;font-weight:600;margin-top:2px}
.stack-a{text-align:center;color:var(--ink-3);font-size:12px;line-height:1}
.sdelta{border:1px solid var(--crit);background:var(--crit-soft);padding:14px}
.sd-k{font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--crit);font-weight:600}
.sd-v{font-family:"IBM Plex Serif",Georgia,serif;font-size:30px;font-weight:600;color:var(--crit);line-height:1.05;margin-top:4px}
.sd-p{font-family:"IBM Plex Mono",monospace;font-size:15px;font-weight:600;color:var(--crit)}
.sd-x{font-family:"IBM Plex Mono",monospace;font-size:10px;color:var(--ink-3);margin-top:3px}
.sd-n{font-size:10px;color:var(--ink-2);margin-top:7px;line-height:1.4}
.axis{font-size:9.5px;letter-spacing:.07em;text-transform:uppercase;padding:1px 6px;border-radius:2px;font-weight:600}
.axis-ownership{background:var(--accent-soft);color:var(--accent)}
.axis-commodity{background:var(--neutral-soft);color:var(--ink-2)}

/* ── confidence bars ────────────────────────────────────────────────────── */
.cbars{display:grid;gap:1px;background:var(--rule);border:1px solid var(--rule);margin-bottom:14px}
.cbar{background:var(--panel);display:grid;grid-template-columns:150px 150px 62px 148px 1fr;gap:12px;align-items:center;padding:9px 13px}
.cb-k{font-size:11.5px;font-weight:600}
.cb-t{height:10px;background:var(--neutral-soft);border:1px solid var(--rule-2)}
.cb-f{height:100%}
.cb-ok{background:var(--ok)} .cb-warn{background:var(--warn)} .cb-crit{background:var(--crit)} .cb-neutral{background:var(--ink-3)}
.cb-l{font-family:"IBM Plex Mono",monospace;font-size:10.5px;font-weight:600;letter-spacing:.05em}
.cb-lt-ok{color:var(--ok)} .cb-lt-warn{color:var(--warn)} .cb-lt-crit{color:var(--crit)} .cb-lt-neutral{color:var(--ink-3)}
.cb-can{font-size:9.5px;color:var(--warn);font-weight:600}
.cb-d{font-size:9.5px}
.cb-r{font-size:10px;color:var(--ink-3);line-height:1.35}

.checkcols{display:grid;grid-template-columns:repeat(3,1fr);gap:14px 20px}
.cc h4{font-size:9.5px;letter-spacing:.11em;text-transform:uppercase;color:var(--ink-3);font-weight:600;
  margin:0 0 6px;border-bottom:1px solid var(--rule);padding-bottom:4px;display:flex;justify-content:space-between}
.cc-n{font-family:"IBM Plex Mono",monospace;color:var(--ink-2)}
.cc .none{font-size:10.5px;color:var(--ok);margin:0}

/* ── required actions ───────────────────────────────────────────────────── */
.actions{display:grid;grid-template-columns:repeat(3,1fr);gap:11px}
.act{border:1px solid var(--rule);border-top:3px solid var(--ink-2);background:var(--panel);padding:13px 15px;display:grid;grid-template-columns:auto 1fr;gap:11px;align-items:start}
.act-n{font-family:"IBM Plex Mono",monospace;font-size:16px;font-weight:600;color:var(--ink-3);line-height:1.1}
.act-t{font-size:11.5px;line-height:1.45;color:var(--ink-2)}

/* ── provenance outcome ─────────────────────────────────────────────────── */
.outcome3{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:12px}
.oc{border:1px solid var(--rule);border-top-width:4px;padding:18px 14px;text-align:center;background:var(--panel)}
.oc-ok{border-top-color:var(--ok)} .oc-warn{border-top-color:var(--warn)} .oc-crit{border-top-color:var(--crit)}
.oc-k{font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-3);font-weight:600}
.oc-v{font-family:"IBM Plex Serif",Georgia,serif;font-size:25px;font-weight:600;margin-top:4px;line-height:1.15}
.oc-x{font-family:"IBM Plex Mono",monospace;font-size:10px;color:var(--ink-3);margin-top:2px}

/* ── source tags ────────────────────────────────────────────────────────── */
.stag{display:inline-block;font-family:"IBM Plex Mono",monospace;font-size:8.5px;font-weight:600;letter-spacing:.09em;
  padding:1px 5px;border:1px solid;border-radius:2px;vertical-align:1px}
.stag-novi{color:var(--src-vendor);border-color:var(--src-vendor)}
.stag-trrc{color:var(--src-reg);border-color:var(--src-reg)}
.stag-county{color:var(--ink-2);border-color:var(--ink-2)}
.stag-derived{color:var(--src-derived);border-color:var(--src-derived)}

/* ── geology ────────────────────────────────────────────────────────────── */
.statusrow{display:flex;flex-wrap:wrap;gap:7px;margin:12px 0 4px}
details.more{margin-top:12px;border-top:1px solid var(--rule);padding-top:8px}
details.more summary{font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;color:var(--ink-3);font-weight:600;cursor:pointer}
details.more[open] summary{margin-bottom:8px}

/* ── ownership estate bar ───────────────────────────────────────────────── */
.estate{display:flex;gap:2px;margin:10px 0 6px}
.est{background:var(--neutral-soft);border:1px solid var(--rule);padding:9px 11px;min-width:0}
.est-sel{background:var(--accent-soft);border-color:var(--accent);border-width:2px}
.est-s{font-family:"IBM Plex Mono",monospace;font-size:17px;font-weight:600}
.est-h{font-size:10.5px;font-weight:600;margin-top:2px}
.est-n{font-size:9.5px;color:var(--ink-3);margin-top:2px}

/* ── regulatory status cards ────────────────────────────────────────────── */
.statuscards{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
.stc{border:1px solid var(--rule);border-top-width:4px;padding:11px 13px;background:var(--panel);position:relative}
.stc-ok{border-top-color:var(--ok)} .stc-warn{border-top-color:var(--warn)} .stc-none{border-top-color:var(--ink-3)}
.stc-m{position:absolute;top:9px;right:11px;font-size:14px;font-weight:600}
.stc-ok .stc-m{color:var(--ok)} .stc-warn .stc-m{color:var(--warn)} .stc-none .stc-m{color:var(--ink-3)}
.stc-k{font-size:9.5px;letter-spacing:.09em;text-transform:uppercase;color:var(--ink-3);font-weight:600;padding-right:20px;min-height:24px}
.stc-v{font-size:15px;font-weight:600;margin:4px 0 3px;line-height:1.2}
.stc-n{font-size:10px;color:var(--ink-2);line-height:1.35;min-height:26px}
.stc-s{margin-top:5px}

/* ── freshness cards ────────────────────────────────────────────────────── */
.freshcards{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}
.fc{border:1px solid var(--rule);padding:12px 14px;background:var(--panel)}
.fc-stale{background:var(--warn-soft)} .fc-missing{background:var(--neutral-soft)}
.fc-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:7px}
.fc-age{font-family:"IBM Plex Mono",monospace;font-size:10.5px;font-weight:600}
.fc-k{font-size:12.5px;font-weight:600}
.fc-d{font-size:11px;color:var(--ink-3);margin-top:2px}
.fc-c{font-size:10.5px;color:var(--ink-2);margin-top:6px;line-height:1.4}
.fc-n{font-size:10px;color:var(--ink-3);margin-top:4px;line-height:1.35}

/* ── audit ──────────────────────────────────────────────────────────────── */
.tracestrip{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:8px}
.tr{border:1px solid var(--rule);padding:5px 9px;background:var(--neutral-soft);min-width:74px}
.tr-hit{border-color:var(--ok);background:var(--ok-soft);border-width:2px}
.tr-id{display:block;font-family:"IBM Plex Mono",monospace;font-size:11.5px;font-weight:600}
.tr-o{display:block;font-size:8.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-3);margin-top:1px}
.tr-hit .tr-o{color:var(--ok);font-weight:600}
.audit{border:1px solid var(--rule);background:var(--panel);padding:12px 14px;margin-bottom:9px}
.audit-q{font-size:12.5px;font-weight:600;margin-bottom:7px;padding-bottom:6px;border-bottom:1px solid var(--rule-2)}
dl.qa{display:grid;grid-template-columns:112px 1fr;gap:4px 14px;margin:0;font-size:11px}
dl.qa dt{font-size:9px;letter-spacing:.09em;text-transform:uppercase;color:var(--ink-3);font-weight:600;padding-top:1px}
dl.qa dd{margin:0;color:var(--ink-2);line-height:1.45}
.cls{font-family:"IBM Plex Mono",monospace;font-size:9px;letter-spacing:.06em;padding:1px 5px;border:1px solid var(--rule);border-radius:2px}
.cls-derived{color:var(--src-derived)} .cls-observed{color:var(--src-reg)}
.cls-not_provided{color:var(--warn);border-color:var(--warn);background:var(--warn-soft)}
.cls-system_default,.cls-user_input{color:var(--ink-2)}

/* ── shared ─────────────────────────────────────────────────────────────── */
h3.sub{font-size:11.5px;font-weight:600;letter-spacing:.02em;margin:18px 0 8px}
.fine{font-size:10.5px;color:var(--ink-3);line-height:1.5;margin:8px 0 0;max-width:104ch}
.mono{font-family:"IBM Plex Mono",monospace}
.crit{color:var(--crit)} .flag{color:var(--warn)}
ul.tight{margin:0;padding-left:15px;font-size:11px;color:var(--ink-2)} ul.tight li{margin-bottom:4px}
.none{color:var(--ink-3);font-size:11px}

@media(max-width:900px){
  .kpis,.kpis-5,.critgrid{grid-template-columns:repeat(2,1fr)}
  .three,.scen3,.bpcards,.excards,.scomp,.pair,.checkcols,.statuscards,.freshcards,.outcome3,.actions{grid-template-columns:1fr}
  .cbar{grid-template-columns:1fr;gap:5px}
  .estate{flex-direction:column}
}

@media print{
  /* Page 1 is a fixed-height decision screen: posture, numbers and the three
     answer columns must land on one sheet at Letter with 0.5in/0.72in margins
     (9.78in usable; see worker/scripts/render-decision-record-pdf.mjs). These
     rules buy vertical space on the printed page only. */
  .notice{padding:6px 0 6px 9px;font-size:8pt;line-height:1.3} .notice .in{gap:6px}
  .mast{padding:10px 0 7px} .mast .org{font-size:8pt} .mast h1{font-size:19pt;margin:2px 0 3px}
  .mast .sub{font-size:8.6pt;line-height:1.32;max-width:78ch} .mast .rule-note{margin-top:6px;font-size:8pt}
  .meta{margin-bottom:10px} .meta div{padding:6px 12px 6px 0}
  .verdict{padding:11px 13px;margin-bottom:10px}
  .vlabel{font-size:7.6pt} .vvalue{font-size:26pt;margin:3px 0 5px}
  .thesis{font-size:9.6pt;line-height:1.34}
  .kpis{margin-bottom:10px} .kpi{padding:7px 10px}
  .kpi-v{font-size:15pt} .kpi-k{font-size:7.2pt;margin-top:3px} .kpi-x{font-size:7pt}
  .three h3{font-size:8pt;padding-bottom:4px;margin-bottom:6px}
  ul.ticks{font-size:8.4pt} ul.ticks li{margin-bottom:4px}
  .fine{font-size:8pt;margin-top:8px}

  /* Grids collapse below 900px, which is narrower than the paper. Restore the
     layouts the pages were composed for. */
  .kpis{grid-template-columns:repeat(4,1fr)} .kpis-5{grid-template-columns:repeat(5,1fr)}
  .three,.scen3,.bpcards,.checkcols,.outcome3,.actions{grid-template-columns:repeat(3,1fr)}
  .excards,.pair,.freshcards{grid-template-columns:1fr 1fr}
  .scomp{grid-template-columns:1fr 1fr 0.75fr}
  .critgrid{grid-template-columns:repeat(6,1fr)}
  .statuscards{grid-template-columns:repeat(4,1fr)}
  .cbar{grid-template-columns:150px 150px 62px 148px 1fr;gap:12px}
  .estate{flex-direction:row}
  details.more{display:none}   /* secondary evidence: on screen, not on paper */

  /* Four exception cards and the risk map share one sheet; six confidence
     rows and their checklist share another. Both were spilling a single short
     row onto a near-empty page. */
  .ex{padding:9px 11px} .ex-h{margin-bottom:6px} .ex-t{font-size:10.5pt}
  .ex-chain,.ex-meas,.ex-unq,.ex-flags{margin-bottom:6px}
  .ex-unq{padding:5px 7px;font-size:8.2pt} .ex-next{font-size:8.2pt;padding-top:5px}
  .excards{gap:8px}
  .cbar{padding:6px 12px;grid-template-columns:132px 122px 58px 132px 1fr;gap:10px}
  .cb-k{font-size:9.5pt} .cb-r{font-size:7.8pt;line-height:1.3}
  .checkcols{gap:10px 18px} .cc h4{font-size:8pt;margin-bottom:5px}
  .bigstat{padding:10px 13px} .bs-v{font-size:21pt}

  .verdict,.kpis,.sc,.bigstat,.bp,.ex,.stack,.sdelta,.cbar,.oc,.stc,.fc,.audit,.tracestrip,.viz-wrap,.estate,.cc,.act{break-inside:avoid}
  .three{break-inside:auto} .three>div{break-inside:avoid}
  h3.sub,h4,.shead{break-after:avoid}
  section{break-before:page}
  #p1{break-before:auto}
}
</style>`;

const html = `<title>Acquisition Decision Record</title>
${prior.slice(prior.indexOf('<link rel="preconnect"'), prior.indexOf("<style>"))}${style}${extra}
${notice}
<div class="wrap">
<header class="mast">
  <div class="org">MineralFlow AI &nbsp;·&nbsp; Decision Layer</div>
  <h1>Acquisition Decision Record</h1>
  <p class="sub">Vendor analytics and the authoritative regulatory record reconciled, mineral title reconstructed from county instruments, and a deterministic acquisition posture applied to both.</p>
  <p class="rule-note">Gold-standard reference implementation &nbsp;·&nbsp; schema ${record.goldenSchemaVersion} &nbsp;·&nbsp; ruleset ${record.decisionRuleVersion} &nbsp;·&nbsp; as of ${record.asOfDate}</p>
</header>
<dl class="meta">
  <div><dt>Subject API</dt><dd>${esc(record.assetIdentity.apiNumber ?? "—")}</dd></div>
  <div><dt>County / State</dt><dd>${esc(record.assetIdentity.county ?? "—")}, ${esc(record.assetIdentity.state)}</dd></div>
  <div><dt>Subject tract</dt><dd>${esc(record.assetIdentity.tractLabel ?? "—")}</dd></div>
  <div><dt>Position</dt><dd>${esc(record.evaluatedPosition.label)}</dd></div>
  <div><dt>Interest scope</dt><dd>${esc(record.assetIdentity.interestScope.join(", "))}</dd></div>
  <div><dt>As-of date</dt><dd>${esc(record.asOfDate ?? "—")}</dd></div>
</dl>
${page1}${page2}${page3}${page4}${page5}${page6}${page7}${page8}${page9}${page10}${page11}${page12}${page13}
${detail}`;

fs.writeFileSync(path.join(outDir, "golden-input.json"), JSON.stringify(INPUT, null, 2));
fs.writeFileSync(path.join(outDir, "golden-decision-record.json"), JSON.stringify(record, null, 2));
fs.writeFileSync(path.join(outDir, "jv-decision-record-v3.html"), html);

console.log(`posture=${record.posture} (${record.postureRuleId})  confidence=${record.confidence.overall} capped-by=${record.confidence.cappedBy}`);
console.log(`readiness=${record.closingReadiness.readiness} (${record.closingReadiness.ruleId})`);
console.log(`nri=${record.evaluatedPosition.netRevenueInterest}  nma=${record.evaluatedPosition.netMineralAcres}`);
console.log(`base=${Math.round(c.baseEconomicValueUsd ?? 0)} downCommodity=${Math.round(c.downsideCommodityValueUsd ?? 0)} exposure=${Math.round(c.quantifiedAssetExposureUsd)} evidenceAdj=${Math.round(c.evidenceAdjustedValueUsd ?? 0)} riskAdj=${Math.round(c.riskAdjustedValueUsd ?? 0)}`);
console.log(`maxPrice=${v.maxAcquisitionPriceUsd == null ? "WITHHELD" : Math.round(v.maxAcquisitionPriceUsd)}  scenarios=${record.scenarios.length} exceptions=${record.exceptionImpacts.length} audit=${record.auditTrail.length}`);
