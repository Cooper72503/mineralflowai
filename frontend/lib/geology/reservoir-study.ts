/**
 * A volumetric study of one reservoir, built only from registered measurements
 * that apply to that reservoir, run through the engineering engine.
 *
 * Selection rules:
 *  - An input must be measured for this reservoir at its own scope: the field (or
 *    the named unit) and, except for area, the same interval.
 *  - A field or unit area applies to an interval inside it, with that stated.
 *  - Regional averages, other intervals, other scopes and single wells are listed
 *    as evidence that exists but is NOT substituted.
 *  - With an input missing, the calculation that needs it stops and the study says
 *    exactly what measurement would supply it.
 */
import { CALIBRATIONS, DOCUMENTS, EVIDENCE_VERSION, MEASUREMENTS, SEMINOLE_POROSITY_NOTES } from "./evidence/registry";
import type { Calibration, Measurement, Quantity, SourceLocation } from "./evidence/types";
import { GAINES_ROZ_PARTITIONS } from "./san-andres-roz";
import type { ReservoirDef } from "./reservoirs";
import type { Calc, Input, SourceRef } from "../engineering/evidence";
import { hydrocarbonPoreVolume, oilInPlace, type Envelope } from "../engineering/volumetrics";

export const ENGINE_VERSION = "volumetrics-1";

export interface Candidate { measurement: Measurement; usable: boolean; reason: string }
export interface Selection {
  key: "area" | "net_pay" | "porosity" | "saturation" | "formation_volume_factor";
  label: string;
  chosen: Measurement | null;
  /** Conditions attached to the chosen value. */
  notes: string[];
  candidates: Candidate[];
}
export interface MissingMeasurement { label: string; detail: string; needed: string }
export interface Comparison { label: string; value: string; source: SourceLocation; note: string }

export interface ReservoirStudy {
  reservoir: ReservoirDef;
  evidenceVersion: string; engineVersion: string;
  status: "oil_in_place" | "reservoir_volume_only" | "insufficient";
  selections: Selection[];
  hcpv: Calc<Envelope>;
  oilInPlace: Calc<Envelope>;
  missing: MissingMeasurement[];
  comparisons: Comparison[];
  calibrations: Calibration[];
  porosityNotes: { text: string; source: SourceLocation }[];
  /** Deterministic fingerprint of the evidence version, engine version and inputs used. */
  fingerprint: string;
}

const LABEL: Record<Selection["key"], string> = {
  area: "Reservoir area (A)", net_pay: "Net pay (h)", porosity: "Porosity (φ)", saturation: "Oil or water saturation (So / Sw)", formation_volume_factor: "Oil formation volume factor (Bo)",
};
const NEEDED: Record<Selection["key"], string> = {
  area: "a mapped reservoir boundary (or unit/field area) for this reservoir",
  net_pay: "net pay for this reservoir interval from logs or core with stated cutoffs, or a published reservoir average",
  porosity: "a representative porosity for this interval: core analyses or calibrated porosity logs across the reservoir, or a published reservoir average",
  saturation: "an initial (pre-production) water or oil saturation for this interval: logs from wells completed water-free, capillary-pressure data, or a published reservoir average",
  formation_volume_factor: "a PVT or fluid study for this reservoir's oil, or a published formation volume factor for this field",
};
const QUANTITIES: Record<Selection["key"], Quantity[]> = {
  area: ["area"], net_pay: ["net_pay"], porosity: ["porosity"], saturation: ["oil_saturation", "water_saturation"], formation_volume_factor: ["formation_volume_factor"],
};

/** DOE ROZ partition averages as regional evidence (never substituted for a field value). */
function regionalMeasurements(partition: number | null): Measurement[] {
  const p = GAINES_ROZ_PARTITIONS.find(x => x.id === partition);
  if (!p) return [];
  const printed = Number(p.propertiesExhibit.match(/p\. (\d+)/)![1]);
  const source: SourceLocation = { documentId: "doe-netl-2020-2627", reportPage: String(printed), pdfPage: printed + 16, locator: `${p.propertiesExhibit.split(",")[0]}, ROZ 1 higher quality` };
  const applicability = { level: "regional" as const, county: "GAINES" as const, reservoir: "San Andres", interval: "ROZ 1 (upper), higher quality", region: `DOE ROZ Partition #${p.id}` };
  const base = { valueBasis: "as_printed" as const, applicability, source, method: `Average across the appraisal's study wells in Partition #${p.id}.`, limitations: ["A regional partition average over the ROZ fairway, which excludes the area under existing fields."], extraction: { method: "text_layer" as const, checkedOn: "2026-11-23" } };
  return [
    { ...base, id: `doe-p${p.id}-roz1-net-pay`, quantity: "net_pay", value: p.roz1.higher.netPayFt, unit: "ft" },
    { ...base, id: `doe-p${p.id}-roz1-porosity`, quantity: "porosity", value: p.roz1.higher.porosity, unit: "fraction" },
    { ...base, id: `doe-p${p.id}-roz1-oil-saturation`, quantity: "oil_saturation", value: p.roz1.higher.oilSaturation, unit: "fraction", saturationBasis: "present" },
    { ...base, id: `doe-p${p.id}-roz1-fvf`, quantity: "formation_volume_factor", value: p.roz1.higher.fvf, unit: "rb/stb" },
  ];
}

const scopeName = (r: ReservoirDef) => r.unit ?? `${r.field} field`;

function judge(r: ReservoirDef, m: Measurement): Candidate {
  const a = m.applicability;
  if (a.level === "regional") return { measurement: m, usable: false, reason: `Regional average (${a.region}), not a measurement of the ${scopeName(r)}; regional values are never substituted.` };
  if (a.level === "well") return { measurement: m, usable: false, reason: "A single well's value; it does not represent the reservoir without a mapped distribution." };
  if (a.field !== r.field) return { measurement: m, usable: false, reason: `Measured for the ${a.field} field, not ${r.field}.` };
  if (r.unit ? !(a.level === "unit" && a.unit === r.unit) : a.level !== "field") return { measurement: m, usable: false, reason: r.unit ? `A ${a.level}-level value for the ${a.field} field, not the ${r.unit}.` : `A value for the ${a.unit ?? a.level}, not the whole ${r.field} field.` };
  if (a.interval && a.interval !== r.interval) return { measurement: m, usable: false, reason: `Measured for the ${a.interval}, not the ${r.interval}.` };
  return { measurement: m, usable: true, reason: a.interval ? "Measured for this reservoir interval at the study's scope." : `The ${scopeName(r)}'s area; applies to the ${r.interval} inside it.` };
}

/** cyrb53: a deterministic 53-bit string hash, identical in the browser and on the server. */
function fingerprintOf(s: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

export function sourceRef(loc: SourceLocation): SourceRef {
  const d = DOCUMENTS.find(x => x.id === loc.documentId)!;
  return { kind: "published_study", citation: `${d.authors}, ${d.published ?? "n.d."}, ${d.title}${d.reportNumber ? ` (${d.reportNumber})` : ""}`, locator: `printed p. ${loc.reportPage} (PDF p. ${loc.pdfPage}), ${loc.locator}${loc.citesFurther ? `; citing ${loc.citesFurther}` : ""}` };
}

function toInput(m: Measurement): Input {
  const base = { source: sourceRef(m.source), basis: m.valueBasis === "range_midpoint" ? `midpoint of the printed range ${m.low}–${m.high} ${m.unit}` : "as printed" };
  if (m.unit === "mi2") return { ...base, value: m.value * 640, unit: "acres", basis: `${m.value} square miles as printed × 640 acres per square mile` };
  return { ...base, value: m.value, unit: m.unit, ...(m.low !== undefined ? { low: m.low } : {}), ...(m.high !== undefined ? { high: m.high } : {}) };
}

export function buildReservoirStudy(r: ReservoirDef, measurements: readonly Measurement[] = MEASUREMENTS): ReservoirStudy {
  const pool = [...measurements, ...regionalMeasurements(r.regionalPartition)];
  const selections: Selection[] = (Object.keys(LABEL) as Selection["key"][]).map(key => {
    const candidates = pool.filter(m => QUANTITIES[key].includes(m.quantity) && (m.applicability.field === r.field || m.applicability.level === "regional")).map(m => judge(r, m));
    const usable = candidates.filter(c => c.usable);
    // Exactly one applicable value is used; two conflicting ones would be a stop, never an average.
    const chosen = usable.length === 1 ? usable[0].measurement : null;
    const notes = chosen && !chosen.applicability.interval && key === "area" ? [`This is the ${scopeName(r)}'s area; the sources do not map the ${r.interval}'s own areal extent, so the volume assumes the interval underlies the whole area.`] : [];
    if (usable.length > 1) notes.push(`${usable.length} applicable values conflict (${usable.map(c => `${c.measurement.value} ${c.measurement.unit}`).join(", ")}); none is chosen.`);
    return { key, label: LABEL[key], chosen, notes, candidates: candidates.filter(c => c.measurement !== chosen) };
  });

  const get = (k: Selection["key"]) => selections.find(s => s.key === k)!.chosen;
  const sat = get("saturation");
  const engineInputs = {
    area: get("area") ? toInput(get("area")!) : undefined,
    netPay: get("net_pay") ? toInput(get("net_pay")!) : undefined,
    porosity: get("porosity") ? toInput(get("porosity")!) : undefined,
    ...(sat ? (sat.quantity === "oil_saturation" ? { oilSaturation: toInput(sat) } : { waterSaturation: toInput(sat) }) : {}),
    fvf: get("formation_volume_factor") ? toInput(get("formation_volume_factor")!) : undefined,
    saturationBasis: sat?.saturationBasis,
  };
  const hcpv = hydrocarbonPoreVolume(engineInputs);
  const oip = oilInPlace(engineInputs);

  const missing: MissingMeasurement[] = selections.filter(s => !s.chosen).map(s => {
    const other = s.candidates.map(c => `${c.measurement.value} ${c.measurement.unit} (${c.measurement.applicability.region ?? c.measurement.applicability.interval ?? c.measurement.applicability.unit ?? c.measurement.applicability.field}): ${c.reason}`);
    return { label: s.label, needed: NEEDED[s.key],
      detail: `No measurement of ${s.label.toLowerCase().replace(/ \(.*\)$/, "")} for the ${r.interval} of the ${scopeName(r)} in the registered sources.${other.length ? ` Found but not usable — ${other.join(" ")}` : ""}${s.notes.length ? ` ${s.notes.join(" ")}` : ""}` };
  });
  if (sat && !sat.saturationBasis) missing.push({ label: "Saturation basis", detail: "The saturation's source does not state whether it is initial or present-day.", needed: "the date or condition of the saturation measurement" });

  const comparisons: Comparison[] = measurements.filter(m => m.quantity === "original_oil_in_place" && judge(r, m).usable).map(m => ({
    label: "Published original oil in place", value: `${m.value.toLocaleString("en-US")} ${m.unit} as printed`, source: m.source, note: m.limitations.join(" "),
  }));

  const calibrations = CALIBRATIONS.filter(c => c.applicability.field === r.field && (!r.unit || c.applicability.unit === r.unit || !c.applicability.unit));
  const fingerprint = fingerprintOf(JSON.stringify([EVIDENCE_VERSION, ENGINE_VERSION, r.id, selections.map(s => s.chosen && [s.chosen.id, s.chosen.value, s.chosen.low ?? null, s.chosen.high ?? null, s.chosen.unit])]));
  const status = oip.status === "calculated" ? "oil_in_place" : hcpv.status === "calculated" ? "reservoir_volume_only" : "insufficient";
  return { reservoir: r, evidenceVersion: EVIDENCE_VERSION, engineVersion: ENGINE_VERSION, status, selections, hcpv, oilInPlace: oip, missing, comparisons, calibrations,
    porosityNotes: r.field === "Seminole" ? SEMINOLE_POROSITY_NOTES.map(n => ({ text: n.text, source: n.source })) : [], fingerprint };
}

/** A source location as one readable citation line. */
export function citeLocation(loc: SourceLocation): string {
  const d = DOCUMENTS.find(x => x.id === loc.documentId)!;
  const authors = d.authors.replace(/\s*\(.*\)$/, "").split(/,\s*| and /).map(a => a.trim()).filter(Boolean);
  const first = authors[0].split(" ").at(-1);
  return `${first}${authors.length > 1 ? " et al." : ""} ${d.published?.slice(0, 4) ?? "n.d."}${d.reportNumber ? `, ${d.reportNumber}` : ""}, p. ${loc.reportPage} (PDF p. ${loc.pdfPage}), ${loc.locator}`;
}
