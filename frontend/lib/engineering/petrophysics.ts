/**
 * Petrophysics: porosity, saturation and net pay from logs and core.
 * Calculation groups 1–3 of the MineralFlow engineering engine.
 */
import { asFraction, inUnit, stopped, used, type Calc, type Input, type SourceRef } from "./evidence";

// 1 ─ Density-log porosity ────────────────────────────────────────────────────

const DENSITY_EQ = "φD = (ρma − ρb) / (ρma − ρf)";

/**
 * Porosity from a bulk-density reading. The matrix density must be justified for
 * the lithology (dolomite, limestone and anhydrite differ), and in San Andres
 * carbonates the result should be calibrated to core: vugs and anhydrite bias it.
 */
export function densityPorosity(i: { matrixDensity?: Input; bulkDensity?: Input; fluidDensity?: Input }): Calc {
  const missing = (["matrixDensity", "bulkDensity", "fluidDensity"] as const).filter(k => !i[k]).map(k => ({ matrixDensity: "matrix density", bulkDensity: "bulk density", fluidDensity: "fluid density" })[k]);
  const invalid: string[] = [];
  const ma = inUnit("matrix density", i.matrixDensity, "g/cm3", invalid, [1.5, 3.5]);
  const b = inUnit("bulk density", i.bulkDensity, "g/cm3", invalid, [0.5, 3.5]);
  const f = inUnit("fluid density", i.fluidDensity, "g/cm3", invalid, [0.5, 1.5]);
  if (ma !== null && f !== null && ma <= f) invalid.push("matrix density must exceed fluid density");
  if (ma !== null && b !== null && b > ma) invalid.push(`bulk density ${b} exceeds the stated matrix density ${ma}: the matrix is wrong for this interval (anhydrite is denser than dolomite) or the reading is bad`);
  if (f !== null && b !== null && b < f) invalid.push(`bulk density ${b} is below the fluid density ${f}: the reading is not a formation measurement`);
  if (missing.length || invalid.length || ma === null || b === null || f === null) return stopped("density porosity", DENSITY_EQ, [...missing], invalid);
  const phi = (ma - b) / (ma - f);
  const flags = [i.matrixDensity!.source.kind === "core_analysis" ? null : "Matrix density is not from core grain density; in carbonates calibrate log porosity to core before using it in volumes."].filter((x): x is string => !!x);
  return { status: "calculated", quantity: "density porosity", value: phi, unit: "fraction", equation: DENSITY_EQ, method: "Bulk-density porosity",
    inputs: [used("matrix density", "ρma", i.matrixDensity!), used("bulk density", "ρb", i.bulkDensity!), used("fluid density", "ρf", i.fluidDensity!)], flags };
}

// 2 ─ Archie water and oil saturation ────────────────────────────────────────

const ARCHIE_EQ = "Sw = (a·Rw / (φ^m·Rt))^(1/n);  So = 1 − Sw";

/**
 * Water saturation by Archie's equation, at the time the resistivity log was run.
 * That is present-day saturation for that date, which is not the initial
 * saturation once a reservoir has produced or been flooded; the caller states which.
 */
export function archieSaturation(i: { a?: Input; m?: Input; n?: Input; rw?: Input; rt?: Input; porosity?: Input }): Calc<{ sw: number; so: number }> {
  const missing = (["a", "m", "n", "rw", "rt", "porosity"] as const).filter(k => !i[k]).map(k => ({ a: "tortuosity factor a", m: "cementation exponent m", n: "saturation exponent n", rw: "formation-water resistivity Rw", rt: "true resistivity Rt", porosity: "porosity" })[k]);
  const invalid: string[] = [];
  const a = inUnit("a", i.a, "dimensionless", invalid, [0.3, 3]);
  const m = inUnit("m", i.m, "dimensionless", invalid, [1, 5]);
  const n = inUnit("n", i.n, "dimensionless", invalid, [1, 6]);
  const rw = inUnit("Rw", i.rw, "ohm-m", invalid, [0.005, 10]);
  const rt = inUnit("Rt", i.rt, "ohm-m", invalid, [0.05, 100_000]);
  const phi = asFraction("porosity", i.porosity, invalid, [0.005, 0.5]);
  if (missing.length || invalid.length || a === null || m === null || n === null || rw === null || rt === null || phi === null) return stopped("water saturation", ARCHIE_EQ, missing, invalid);
  const raw = Math.pow((a * rw) / (Math.pow(phi, m) * rt), 1 / n);
  const flags: string[] = [];
  if (raw > 1) flags.push(`Archie gives Sw = ${raw.toFixed(2)} > 1: the interval is water-bearing at these parameters, or Rw, m or n do not fit this rock. Sw is reported as 1.`);
  if (![i.a, i.m, i.n].every(x => x!.source.kind === "core_analysis" || x!.source.kind === "published_study")) flags.push("a, m and n are not all from core or a published calibration for this reservoir; carbonate pore systems often need m and n above 2.");
  flags.push(`Saturation as of the resistivity log run${i.rt!.source.locator ? ` (${i.rt!.source.locator})` : ""}; not initial saturation unless the log predates production.`);
  const sw = Math.min(raw, 1);
  return { status: "calculated", quantity: "water and oil saturation", value: { sw, so: 1 - sw }, unit: "fraction", equation: ARCHIE_EQ, method: "Archie (clean formation, two-phase oil–water)",
    inputs: [used("tortuosity factor", "a", i.a!), used("cementation exponent", "m", i.m!), used("saturation exponent", "n", i.n!), used("formation-water resistivity", "Rw", i.rw!), used("true resistivity", "Rt", i.rt!), used("porosity", "φ", i.porosity!, phi, "fraction")], flags };
}

// 3 ─ Net pay by interval ────────────────────────────────────────────────────

const NET_PAY_EQ = "h_net = Σ Δz_i · I_i,  I_i = 1 when the interval meets every stated cutoff";

/** One evaluated depth interval; properties are fractions except permeability (md). */
export interface PayInterval { topFt: number; baseFt: number; porosity?: number; sw?: number; vshale?: number; permeabilityMd?: number; source: SourceRef }
/** A cutoff is only usable with the evidence that justifies it. */
export interface Cutoff { value: number; source: SourceRef; basis: string }
export interface PayCutoffs { porosityMin?: Cutoff; swMax?: Cutoff; vshaleMax?: Cutoff; permeabilityMinMd?: Cutoff }

export interface NetPay {
  grossFt: number; netFt: number; netToGross: number;
  /** Thickness-weighted porosity of the net intervals. */
  netPorosity: number;
  /** Pore-volume-weighted water saturation of the net intervals, when Sw was evaluated. */
  netSw: number | null;
  intervals: (PayInterval & { pay: boolean; failed: string[] })[];
}

/** Net pay interval by interval. It never classifies a whole formation as pay. */
export function netPay(intervals: PayInterval[], cutoffs: PayCutoffs): Calc<NetPay> {
  const invalid: string[] = [], missing: string[] = [];
  const active = (Object.entries(cutoffs) as [keyof PayCutoffs, Cutoff | undefined][]).filter((e): e is [keyof PayCutoffs, Cutoff] => !!e[1]);
  if (!intervals.length) missing.push("evaluated depth intervals");
  if (!active.length) missing.push("at least one justified net-pay cutoff");
  const sorted = [...intervals].sort((x, y) => x.topFt - y.topFt);
  sorted.forEach((iv, k) => {
    if (!(iv.baseFt > iv.topFt)) invalid.push(`interval ${iv.topFt}–${iv.baseFt} ft has no thickness`);
    if (k && iv.topFt < sorted[k - 1].baseFt) invalid.push(`intervals ${sorted[k - 1].topFt}–${sorted[k - 1].baseFt} and ${iv.topFt}–${iv.baseFt} ft overlap`);
    for (const [key, v] of [["porosity", iv.porosity], ["Sw", iv.sw], ["Vshale", iv.vshale]] as const) if (v !== undefined && !(v >= 0 && v <= 1)) invalid.push(`${key} ${v} at ${iv.topFt} ft is not a fraction`);
  });
  const property = { porosityMin: "porosity", swMax: "sw", vshaleMax: "vshale", permeabilityMinMd: "permeabilityMd" } as const;
  for (const [key] of active) {
    const lacking = sorted.filter(iv => iv[property[key]] === undefined);
    if (lacking.length) missing.push(`${property[key]} for ${lacking.length} interval(s) (first at ${lacking[0].topFt} ft), needed by the ${key} cutoff`);
  }
  if (!active.some(([k]) => k === "porosityMin") && sorted.some(iv => iv.porosity === undefined)) missing.push("porosity for every interval (needed for net-pay averages)");
  if (missing.length || invalid.length) return stopped("net pay", NET_PAY_EQ, missing, invalid);

  const evaluated = sorted.map(iv => {
    const failed: string[] = [];
    if (cutoffs.porosityMin && iv.porosity! < cutoffs.porosityMin.value) failed.push(`porosity ${iv.porosity} < ${cutoffs.porosityMin.value}`);
    if (cutoffs.swMax && iv.sw! > cutoffs.swMax.value) failed.push(`Sw ${iv.sw} > ${cutoffs.swMax.value}`);
    if (cutoffs.vshaleMax && iv.vshale! > cutoffs.vshaleMax.value) failed.push(`Vshale ${iv.vshale} > ${cutoffs.vshaleMax.value}`);
    if (cutoffs.permeabilityMinMd && iv.permeabilityMd! < cutoffs.permeabilityMinMd.value) failed.push(`permeability ${iv.permeabilityMd} md < ${cutoffs.permeabilityMinMd.value} md`);
    return { ...iv, pay: failed.length === 0, failed };
  });
  const h = (iv: PayInterval) => iv.baseFt - iv.topFt;
  const gross = evaluated.reduce((s, iv) => s + h(iv), 0);
  const pay = evaluated.filter(iv => iv.pay);
  const net = pay.reduce((s, iv) => s + h(iv), 0);
  const phiH = pay.reduce((s, iv) => s + h(iv) * iv.porosity!, 0);
  const swKnown = pay.every(iv => iv.sw !== undefined);
  const flags = net === 0 ? ["No interval meets the stated cutoffs; net pay is zero."] : [];
  return { status: "calculated", quantity: "net pay", unit: "ft", equation: NET_PAY_EQ, method: `Interval cutoffs: ${active.map(([k, c]) => `${k} ${c.value} (${c.basis})`).join("; ")}`,
    value: { grossFt: gross, netFt: net, netToGross: gross ? net / gross : 0, netPorosity: net ? phiH / net : 0, netSw: net && swKnown && phiH ? pay.reduce((s, iv) => s + h(iv) * iv.porosity! * iv.sw!, 0) / phiH : null, intervals: evaluated },
    inputs: active.map(([k, c]) => ({ name: `${k} cutoff`, symbol: k, value: c.value, unit: k === "permeabilityMinMd" ? "md" : "fraction", source: c.source, basis: c.basis })),
    flags };
}
