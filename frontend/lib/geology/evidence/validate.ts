/** Checks every registered document, measurement and calibration before any calculation may use them. */
import type { Calibration, Measurement, SourceDocument, SourceLocation } from "./types";

const UNITS: Record<Measurement["quantity"], { units: string[]; range: Record<string, [number, number]> }> = {
  area: { units: ["acres", "mi2"], range: { acres: [1, 5_000_000], mi2: [0.001, 8_000] } },
  net_pay: { units: ["ft"], range: { ft: [0.1, 5_000] } },
  gross_thickness: { units: ["ft"], range: { ft: [0.1, 10_000] } },
  porosity: { units: ["fraction", "percent"], range: { fraction: [0.001, 0.5], percent: [0.1, 50] } },
  oil_saturation: { units: ["fraction", "percent"], range: { fraction: [0, 1], percent: [0, 100] } },
  water_saturation: { units: ["fraction", "percent"], range: { fraction: [0, 1], percent: [0, 100] } },
  formation_volume_factor: { units: ["rb/stb"], range: { "rb/stb": [1, 3] } },
  original_oil_in_place: { units: ["stb", "Mstb", "MMstb"], range: { stb: [1, 1e12], Mstb: [0.001, 1e9], MMstb: [0.000001, 1e6] } },
};

function checkLocation(where: string, loc: SourceLocation, docs: readonly SourceDocument[], errors: string[]) {
  const d = docs.find(x => x.id === loc.documentId);
  if (!d) { errors.push(`${where}: unknown document ${loc.documentId}`); return null; }
  if (!Number.isInteger(loc.pdfPage) || loc.pdfPage < 1 || loc.pdfPage > d.pdfPages) errors.push(`${where}: PDF page ${loc.pdfPage} is outside ${d.fileName} (1–${d.pdfPages})`);
  if (!loc.reportPage || !loc.locator) errors.push(`${where}: printed page and locator are required`);
  return d;
}

export function validateEvidence(docs: readonly SourceDocument[], measurements: readonly Measurement[], calibrations: readonly Calibration[]): string[] {
  const errors: string[] = [];
  const ids = [...docs.map(d => d.id), ...measurements.map(m => m.id), ...calibrations.map(c => c.id)];
  for (const id of new Set(ids)) if (ids.filter(x => x === id).length > 1) errors.push(`duplicate id ${id}`);
  for (const d of docs) if (!/^[0-9a-f]{64}$/.test(d.sha256) || d.pdfPages < 1) errors.push(`${d.id}: SHA-256 and page count are required`);

  for (const m of measurements) {
    const w = m.id, rule = UNITS[m.quantity];
    if (!rule.units.includes(m.unit)) errors.push(`${w}: ${m.quantity} cannot be stated in ${m.unit}`);
    else for (const [k, v] of [["value", m.value], ["low", m.low], ["high", m.high]] as const) {
      if (v === undefined) continue;
      const [lo, hi] = rule.range[m.unit];
      if (!Number.isFinite(v) || v < lo || v > hi) errors.push(`${w}: ${k} ${v} ${m.unit} is outside ${lo}–${hi}`);
    }
    if ((m.low !== undefined && m.low > m.value) || (m.high !== undefined && m.high < m.value)) errors.push(`${w}: range ${m.low}–${m.high} does not contain ${m.value}`);
    if (m.valueBasis === "range_midpoint" && (m.low === undefined || m.high === undefined || Math.abs((m.low + m.high) / 2 - m.value) > 1e-9)) errors.push(`${w}: a range midpoint needs low and high, and must equal their mean`);
    if ((m.quantity === "oil_saturation" || m.quantity === "water_saturation") && !m.saturationBasis) errors.push(`${w}: a saturation must state whether it is initial or present-day`);
    const a = m.applicability;
    if (a.level === "well" && !a.api10) errors.push(`${w}: a well-level value needs the well's API`);
    if (a.level === "regional" && !a.region) errors.push(`${w}: a regional value needs its region`);
    if ((a.level === "field" || a.level === "unit" || a.level === "interval") && !a.field) errors.push(`${w}: a ${a.level}-level value needs its field`);
    if (a.level === "unit" && !a.unit) errors.push(`${w}: a unit-level value needs its unit`);
    if (a.level === "interval" && !a.interval) errors.push(`${w}: an interval-level value needs its interval`);
    if (!m.method) errors.push(`${w}: method is required`);
    const d = checkLocation(w, m.source, docs, errors);
    if (d?.textLayer && (m.extraction.method !== "text_layer" || !m.extraction.verifyText?.length)) errors.push(`${w}: ${d.fileName} has a text layer, so the value needs the exact words to re-check`);
    if (d && !d.textLayer && m.extraction.method === "text_layer") errors.push(`${w}: ${d.fileName} has no text layer; the value was transcribed from the page image`);
  }
  for (const c of calibrations) {
    if (!c.sources.length) errors.push(`${c.id}: at least one source is required`);
    for (const s of c.sources) checkLocation(c.id, s, docs, errors);
    if (!c.parameters.length || c.parameters.some(p => !Number.isFinite(p.value))) errors.push(`${c.id}: parameters must be finite numbers`);
  }
  return errors;
}
