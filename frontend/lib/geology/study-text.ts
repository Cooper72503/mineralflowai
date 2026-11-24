/** Wording and number formatting for a reservoir study, shared by the web page and the PDFs. */
import type { Measurement } from "./evidence/types";
import { citeLocation, type ReservoirStudy } from "./reservoir-study";

export const STUDY_STATUS: Record<ReservoirStudy["status"], { label: string; tone: "green" | "yellow" | "red" }> = {
  oil_in_place: { label: "Oil in place calculated", tone: "green" },
  reservoir_volume_only: { label: "Reservoir-condition volume calculated; stock-tank conversion stopped", tone: "yellow" },
  insufficient: { label: "Insufficient measurements: calculation stopped", tone: "red" },
};

/** 1,622,715,414 → "1.62 billion"; keeps three significant figures, never rounds to zero. */
export function bigNumber(x: number): string {
  const abs = Math.abs(x);
  if (abs >= 1e9) return `${(x / 1e9).toPrecision(3)} billion`;
  if (abs >= 1e6) return `${(x / 1e6).toPrecision(3)} million`;
  return Math.round(x).toLocaleString("en-US");
}

function measurementValue(m: Measurement): string {
  const range = m.low !== undefined && m.high !== undefined ? ` (range ${m.low}–${m.high})` : "";
  const unit = m.unit === "percent" ? "%" : m.unit === "mi2" ? " square miles" : ` ${m.unit}`;
  return `${m.value.toLocaleString("en-US")}${unit}${range}${m.valueBasis === "range_midpoint" ? ", midpoint" : ""}${m.unit === "mi2" ? ` = ${(m.value * 640).toLocaleString("en-US")} acres` : ""}`;
}
const applies = (m: Measurement) => {
  const a = m.applicability;
  return [a.region ?? a.unit ?? (a.field ? `${a.field} field` : ""), a.interval, a.level === "regional" ? "regional average" : `${a.level} level`].filter(Boolean).join(" · ");
};

export interface StudyResultLine { label: string; unit: string; low: number | null; central: number; high: number | null }

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const span = (e: { low: number | null; central: number; high: number | null }, f: (x: number) => string) => `${f(e.central)}${e.low !== null && e.high !== null ? ` (${f(e.low)}–${f(e.high)})` : ""}`;
const stb = (x: number) => `${bigNumber(x)} stb`;

/** Groups 6–8 as one line each: the result, or exactly why it stopped. */
export function engineeringLines(s: ReservoirStudy): { group: string; label: string; ok: boolean; text: string }[] {
  const line = <T,>(group: string, label: string, c: { status: "calculated"; value: T; flags: string[] } | { status: "stopped"; reason: string }, show: (v: T) => string) =>
    ({ group, label, ok: c.status === "calculated", text: c.status === "calculated" ? show(c.value) : `Stopped: ${c.reason}` });
  const { depletion: d, recovery: r, eor: e } = s;
  const sc = e.screening;
  return [
    line("6", "Remaining oil in place", d.remaining, v => `${span(v, stb)} as of ${v.asOf}; inventory only, not a saturation distribution`),
    line("6", "Material-balance OOIP", d.materialBalance, v => span(v, stb)),
    line("7", "Historical recovery factor", r.historical, v => `${span(v, pct)} as of ${v.asOf}`),
    line("7", `Future recoverable (${r.process === "co2_eor" ? "CO2 EOR" : r.process})`, r.future, v => `EUR ${span(v.eur, stb)}; future ${span(v.future, stb)} after production to ${v.asOf}; not reserves`),
    { group: "8", label: "CO2 miscible-flood screen", ok: sc.status === "calculated", text: sc.status === "calculated" ? `${sc.value.overall}: ${sc.value.criteria.map(c => `${c.criterion} ${c.status}`).join("; ")}` : "Stopped" },
    line("8", "CO2 miscibility", e.miscibility, v => `${v.miscible ? "miscible" : "immiscible"}, margin ${Math.round(v.marginPsi)} psi`),
    line("8", "Displacement efficiency", e.displacement, v => span(v, pct)),
    line("8", "Volumetric sweep", e.sweep, v => span(v, pct)),
    line("8", "Incremental recoverable oil", e.incremental, v => `${span(v, stb)}; not reserves`),
  ];
}

export function studyText(s: ReservoirStudy) {
  const results: StudyResultLine[] = [];
  if (s.hcpv.status === "calculated") results.push({ label: s.reservoir.interval.includes("ROZ") || s.hcpv.inputs.some(i => i.symbol === "So") ? "Oil in place at reservoir conditions (hydrocarbon pore volume)" : "Hydrocarbon pore volume", unit: "reservoir barrels", ...s.hcpv.value });
  if (s.oilInPlace.status === "calculated") results.push({ label: s.oilInPlace.quantity.replace(/^./, c => c.toUpperCase()), unit: "stock-tank barrels", ...s.oilInPlace.value });
  const area = s.selections.find(x => x.key === "area")?.chosen;
  const perAcre = s.hcpv.status === "calculated" && area ? s.hcpv.value.central / (area.unit === "mi2" ? area.value * 640 : area.value) : null;
  return {
    status: STUDY_STATUS[s.status],
    results,
    perAcre: perAcre === null ? null : `${Math.round(perAcre).toLocaleString("en-US")} reservoir barrels per acre (central)`,
    equations: [s.hcpv.equation, s.oilInPlace.equation],
    stopped: [s.hcpv, s.oilInPlace].filter(c => c.status === "stopped").map(c => c.status === "stopped" ? `${c.quantity.replace(/^./, x => x.toUpperCase())}: ${c.reason}` : ""),
    flags: [...new Set([s.hcpv, s.oilInPlace].flatMap(c => (c.status === "calculated" ? c.flags : [])))],
    inputs: s.selections.filter(x => x.chosen).map(x => ({ label: x.label, value: measurementValue(x.chosen!), applies: applies(x.chosen!), source: citeLocation(x.chosen!.source), notes: [...x.notes, ...x.chosen!.limitations] })),
    notUsed: s.selections.flatMap(x => x.candidates.map(c => ({ label: x.label, value: measurementValue(c.measurement), applies: applies(c.measurement), source: citeLocation(c.measurement.source), reason: c.reason }))),
    missing: s.missing,
    comparisons: s.comparisons.map(c => ({ ...c, source: citeLocation(c.source) })),
    calibrations: s.calibrations.map(c => ({ name: c.name, expression: c.expression, sources: c.sources.map(citeLocation).join("; "), limitations: c.limitations })),
    context: [...s.reservoir.history.map(h => ({ text: h.text, source: citeLocation(h.source) })), ...s.porosityNotes.map(n => ({ text: n.text, source: citeLocation(n.source) }))],
    production: s.depletion.production ? `${s.depletion.production.value.toLocaleString("en-US")} ${s.depletion.production.unit} cumulative oil as of ${s.depletion.production.asOf} (${s.depletion.production.applicability.field} field, ${s.depletion.production.coverage === "since_first_production" ? "since first production" : "partial period"}) — ${citeLocation(s.depletion.production.source)}` : "No production record in the registered sources is attributed to this reservoir.",
    engineering: engineeringLines(s),
    processBasis: s.recovery.processBasis,
    interpretations: s.interpretations,
    reproducibility: `Evidence ${s.evidenceVersion} · engine ${s.engineVersion} · fingerprint ${s.fingerprint}. Rebuild and re-verify against the source PDFs with scripts/verify-geology-sources.mts.`,
  };
}
