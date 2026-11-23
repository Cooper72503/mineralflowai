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
    reproducibility: `Evidence ${s.evidenceVersion} · engine ${s.engineVersion} · fingerprint ${s.fingerprint}. Rebuild and re-verify against the source PDFs with scripts/verify-geology-sources.mts.`,
  };
}
