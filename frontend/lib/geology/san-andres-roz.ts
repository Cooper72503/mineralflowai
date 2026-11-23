/**
 * San Andres residual oil zone (ROZ), Gaines County, as published by the U.S.
 * DOE National Energy Technology Laboratory: DOE/NETL-2020/2627, "A Four-County
 * Appraisal of the San Andres Residual Oil Zone (ROZ) 'Fairway' of the Permian
 * Basin" (Kuuskraa, Petrusak and Wallace, Advanced Resources International),
 * September 1, 2020. Every figure below is transcribed from the exhibit cited
 * beside it; nothing is interpolated.
 *
 * What it is: the appraisal divides Gaines County into five partitions and gives
 * each one log-derived average properties for an upper (ROZ 1) and lower (ROZ 2)
 * interval, split into higher quality (porosity > 8% and oil saturation >= 25%)
 * and lower quality. Its "fairway" EXCLUDES the area under existing San Andres
 * fields, so for a well or lease in one of those fields these are the averages
 * of the surrounding fairway, never a measurement at that well.
 *
 * How a field is placed in a partition: only by the fields the appraisal itself
 * names when it describes each partition (section 2.2, p. 29). Partition
 * boundaries exist only on its maps, so a field it does not name, or names in two
 * partitions (Hanford), is reported as "not established" rather than guessed.
 */

export const ROZ_DATASET = "doe-netl-2020-2627/gaines-v1" as const;

export const ROZ_SOURCE = {
  report: "DOE/NETL-2020/2627",
  title: "A Four-County Appraisal of the San Andres Residual Oil Zone (ROZ) “Fairway” of the Permian Basin",
  authors: "V. A. Kuuskraa, R. Petrusak and M. Wallace, Advanced Resources International, for the U.S. DOE National Energy Technology Laboratory",
  date: "September 1, 2020",
  /** Economic basis of the "commercially viable" volumes (section 2.5, p. 32). */
  economicBasis: "first-year WTI of $75/bbl, purchased CO2 at $1.50/Mcf ($28.35/metric ton), 10% after-tax hurdle rate",
} as const;

/** Average properties of one analytical ROZ unit, as the exhibit prints them. */
export interface RozUnit {
  depthFt: number; grossFt: number; netPayFt: number;
  porosity: number; oilSaturation: number;
  /** Formation volume factor, reservoir bbl per stock-tank bbl. */
  fvf: number;
  /** Published oil in place per acre-foot of net pay, stock-tank bbl. */
  oipBblPerAcreFt: number;
}

export interface RozPartition {
  id: 1 | 2 | 3 | 4 | 5;
  setting: string;
  totalAcres: number; excludedAcres: number; assessedAcres: number;
  /** The existing fields the appraisal excludes from this partition, as it names them. */
  excludedFields: string;
  roz1: { higher: RozUnit; lower: RozUnit };
  roz2: { higher: RozUnit; lower: RozUnit };
  /** Million stock-tank barrels in place in the assessed (fairway) area. */
  oipMMbbl: { higher: number; lower: number; total: number };
  technicallyRecoverableMMbbl: number; technicallyRecoverablePctOip: number;
  commerciallyViableMMbbl: number;
  /** Exhibit holding this partition's unit properties. */
  propertiesExhibit: string;
}

const u = (depthFt: number, grossFt: number, netPayFt: number, porosity: number, oilSaturation: number, fvf: number, oipBblPerAcreFt: number): RozUnit =>
  ({ depthFt, grossFt, netPayFt, porosity, oilSaturation, fvf, oipBblPerAcreFt });

/** Exhibits 2-6 (acres), 2-7 (OIP), 2-8 (technically recoverable), 2-9 (commercially viable) and each partition's properties exhibit. */
export const GAINES_ROZ_PARTITIONS: readonly RozPartition[] = [
  { id: 1, setting: "northwest Gaines County, on the Northwest Shelf",
    totalAcres: 45_200, excludedAcres: 11_200, assessedAcres: 34_000, excludedFields: "the southern portion of the Wasson field",
    roz1: { higher: u(5370, 210, 190, 0.089, 0.40, 1.31, 211), lower: u(5370, 138, 68, 0.076, 0.31, 1.31, 140) },
    roz2: { higher: u(5540, 144, 133, 0.096, 0.46, 1.31, 262), lower: u(5540, 188, 73, 0.077, 0.22, 1.31, 100) },
    oipMMbbl: { higher: 850, lower: 260, total: 1110 }, technicallyRecoverableMMbbl: 300, technicallyRecoverablePctOip: 27, commerciallyViableMMbbl: 150,
    propertiesExhibit: "Exhibit 2-12, p. 34" },
  { id: 2, setting: "northwest Gaines County, in the San Simon Channel between the Northwest Shelf and the Central Basin Platform",
    totalAcres: 80_700, excludedAcres: 5_700, assessedAcres: 75_000, excludedFields: "the Russell South, Havemeyer and ODC fields",
    roz1: { higher: u(5630, 186, 179, 0.090, 0.44, 1.24, 248), lower: u(5630, 151, 104, 0.080, 0.36, 1.24, 180) },
    roz2: { higher: u(5780, 155, 151, 0.090, 0.40, 1.24, 225), lower: u(5780, 138, 123, 0.087, 0.25, 1.24, 136) },
    oipMMbbl: { higher: 3280, lower: 650, total: 3930 }, technicallyRecoverableMMbbl: 1150, technicallyRecoverablePctOip: 29, commerciallyViableMMbbl: 1030,
    propertiesExhibit: "Exhibit 2-17, p. 37" },
  { id: 3, setting: "western Gaines County, on the northern Central Basin Platform",
    totalAcres: 183_000, excludedAcres: 41_000, assessedAcres: 142_000, excludedFields: "the Seminole field and its extensions, the Blackwatch field and part of the Hanford field",
    roz1: { higher: u(5340, 272, 248, 0.120, 0.36, 1.39, 241), lower: u(5340, 235, 194, 0.092, 0.17, 1.39, 87) },
    // As published: the higher-quality ROZ 2 depth (6,070 ft) differs from the lower-quality ROZ 2 depth (5,580 ft).
    roz2: { higher: u(6070, 277, 252, 0.097, 0.36, 1.39, 195), lower: u(5580, 215, 185, 0.077, 0.15, 1.39, 64) },
    oipMMbbl: { higher: 10270, lower: 550, total: 10820 }, technicallyRecoverableMMbbl: 3360, technicallyRecoverablePctOip: 31, commerciallyViableMMbbl: 3240,
    propertiesExhibit: "Exhibit 2-22, p. 40" },
  { id: 4, setting: "southern Gaines County",
    totalAcres: 199_500, excludedAcres: 15_500, assessedAcres: 184_000, excludedFields: "the Robertson, North Robertson, Jenkins and Carm-Ann fields",
    roz1: { higher: u(4920, 248, 225, 0.106, 0.35, 1.38, 209), lower: u(4920, 192, 114, 0.086, 0.15, 1.38, 73) },
    roz2: { higher: u(5130, 198, 189, 0.107, 0.43, 1.38, 259), lower: u(5130, 218, 177, 0.096, 0.22, 1.38, 119) },
    oipMMbbl: { higher: 8780, lower: 1850, total: 10630 }, technicallyRecoverableMMbbl: 3200, technicallyRecoverablePctOip: 30, commerciallyViableMMbbl: 2700,
    propertiesExhibit: "Exhibit 2-27, p. 43" },
  { id: 5, setting: "the eastern half of Gaines County, beyond the current extent of the Central Basin Platform",
    totalAcres: 453_500, excludedAcres: 30_500, assessedAcres: 423_000, excludedFields: "the Hanford, GMK, Adair/TLOC, Cedar Lake and Homann fields",
    roz1: { higher: u(5270, 174, 153, 0.109, 0.30, 1.18, 215), lower: u(5270, 168, 122, 0.112, 0.17, 1.18, 125) },
    roz2: { higher: u(5430, 218, 198, 0.118, 0.31, 1.18, 240), lower: u(5430, 148, 89, 0.113, 0.16, 1.18, 119) },
    oipMMbbl: { higher: 8850, lower: 6030, total: 14880 }, technicallyRecoverableMMbbl: 4120, technicallyRecoverablePctOip: 28, commerciallyViableMMbbl: 2980,
    propertiesExhibit: "Exhibit 2-32, p. 46" },
];

/** Gaines County totals (Exhibits 2-7, 2-8, 2-9). */
export const GAINES_ROZ_TOTALS = { assessedAcres: 858_000, oipMMbbl: { higher: 32_030, lower: 9_340, total: 41_370 }, technicallyRecoverableMMbbl: 12_130, commerciallyViableMMbbl: 10_100 } as const;

/**
 * Published values the appraisal cites for the ROZ below the Seminole field's
 * main pay zone (Exhibit 1-10, p. 16, citing its references 8 and 13).
 */
export const SEMINOLE_FIELD_ROZ = { grossFt: 246, netPayFt: 197, porosityPct: "13–15", oilSaturationPct: 32, exhibit: "Exhibit 1-10, p. 16" } as const;

// ── Field names ─────────────────────────────────────────────────────────────

const DIRECTIONS: Record<string, string> = {
  N: "N", NO: "N", NORTH: "N", S: "S", SO: "S", SOUTH: "S", E: "E", EAST: "E", W: "W", WEST: "W",
  NE: "NE", NW: "NW", SE: "SE", SW: "SW", NORTHEAST: "NE", NORTHWEST: "NW", SOUTHEAST: "SE", SOUTHWEST: "SW",
};

/** Reservoirs by position relative to the San Andres (Permian Basin stratigraphy, shallow to deep). */
const ABOVE = /\b(RUSTLER|SALADO|TANSILL|YATES|SEVEN RIVERS|QUEEN|GRAYBURG)\b/;
const SAN_ANDRES = /\bSAN[ -]?ANDRES\b/;
const BELOW = /\b(SAN ANGELO|GLORIETA|CLEAR ?FOR[KD]|LEONARD|PADDOCK|BLINEBRY|TUBB|DRINKARD|ABO|WICHITA|ALBANY|WOLFCAMP|WLFCMP|PENN(SYLVANIAN)?|CISCO|CANYON|STRAWN|ATOKA|MORROW|MISSISSIPPIAN|DEVONIAN|DEV|SILURIAN|FUSSELMAN|MONTOYA|SIMPSON|ELLENBURGER)\b/;
const FORMATION_WORDS = /\s((?:SAN[ -]?ANDRES|SAN ANGELO|CANYON|STRAWN|DEVONIAN|WOLFCAMP|YATES|QUEEN|GRAYBURG|GLORIETA|CLEAR ?FORK|SILURIAN|ELLENBURGER))$/;

export interface ParsedField { core: string; direction: string | null; reservoir: string | null }

/** "SEMINOLE  EAST (SAN ANDRES)" → core SEMINOLE, direction E, reservoir SAN ANDRES; "O D C (SAN ANDRES)" → ODC. */
export function parseFieldName(raw: string): ParsedField {
  const s = raw.toUpperCase().replace(/\s+/g, " ").trim();
  const open = s.indexOf("(");
  let base = open >= 0 ? s.slice(0, open) : s;
  let reservoir = open >= 0 ? s.slice(open + 1).replace(/\).*$/, "").trim() || null : null;
  if (!reservoir) {
    const m = base.match(FORMATION_WORDS);
    if (m && m.index !== undefined && m.index > 0) { reservoir = m[1]; base = base.slice(0, m.index); }
  }
  // Hyphens dropped (G-M-K → GMK) and runs of single letters joined (O D C → ODC, S. E. → SE).
  const tokens: string[] = [];
  let run = "";
  for (const t of base.replace(/[.,]/g, " ").split(" ").filter(Boolean).map(t => t.replace(/-/g, ""))) {
    if (t.length === 1) { run += t; continue; }
    if (run) { tokens.push(run); run = ""; }
    tokens.push(t);
  }
  if (run) tokens.push(run);
  let direction: string | null = null;
  if (tokens.length > 1 && DIRECTIONS[tokens[tokens.length - 1]]) direction = DIRECTIONS[tokens.pop()!];
  else if (tokens.length > 1 && DIRECTIONS[tokens[0]]) direction = DIRECTIONS[tokens.shift()!];
  return { core: tokens.join(" "), direction, reservoir };
}

interface FieldRule { core: string; directions: "any" | (string | null)[]; partition: RozPartition["id"]; reportName: string }
/** Section 2.2, p. 29: the fields each partition excludes, i.e. the fields the appraisal locates in it. */
const FIELD_RULES: FieldRule[] = [
  { core: "WASSON", directions: [null], partition: 1, reportName: "Wasson (southern portion)" },
  { core: "RUSSELL", directions: ["S"], partition: 2, reportName: "Russell South" },
  { core: "HAVEMEYER", directions: [null], partition: 2, reportName: "Havemeyer" },
  { core: "ODC", directions: [null], partition: 2, reportName: "ODC" },
  { core: "SEMINOLE", directions: "any", partition: 3, reportName: "Seminole and its extensions" },
  { core: "BLACKWATCH", directions: [null], partition: 3, reportName: "Blackwatch" },
  { core: "ROBERTSON", directions: [null, "N"], partition: 4, reportName: "Robertson / North Robertson" },
  { core: "JENKINS", directions: [null], partition: 4, reportName: "Jenkins" },
  { core: "CARMANN", directions: [null], partition: 4, reportName: "Carm-Ann" },
  { core: "GMK", directions: [null], partition: 5, reportName: "GMK" },
  { core: "ADAIR", directions: [null], partition: 5, reportName: "Adair/TLOC" },
  { core: "TLOC", directions: [null], partition: 5, reportName: "Adair/TLOC" },
  { core: "CEDAR LAKE", directions: [null], partition: 5, reportName: "Cedar Lake" },
  { core: "HOMANN", directions: [null], partition: 5, reportName: "Homann" },
];
/** Fields the appraisal names in more than one partition. */
const SPLIT_FIELDS: Record<string, string> = { HANFORD: "The appraisal places parts of the Hanford field in both Partition #3 and Partition #5" };

export type ReservoirPosition = "san_andres" | "above" | "below" | "unknown";

export function reservoirPosition(reservoir: string | null): { position: ReservoirPosition; formation: string | null } {
  if (!reservoir) return { position: "unknown", formation: null };
  const r = reservoir.toUpperCase();
  if (SAN_ANDRES.test(r)) return { position: "san_andres", formation: "San Andres" };
  const a = r.match(ABOVE); if (a) return { position: "above", formation: title(a[1]) };
  const b = r.match(BELOW); if (b) return { position: "below", formation: title(b[1] === "DEV" ? "Devonian" : b[1] === "WLFCMP" ? "Wolfcamp" : /^CLEAR ?FOR/.test(b[1]) ? "Clear Fork" : b[1]) };
  return { position: "unknown", formation: null };
}
const title = (s: string) => s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());

// ── Context for one well or lease ───────────────────────────────────────────

export interface RozContext {
  dataset: typeof ROZ_DATASET;
  fieldName: string;
  status: "assigned" | "not_established";
  partition: RozPartition | null;
  /** The appraisal's own name for the field that placed it, when assigned. */
  matchedAs: string | null;
  reason: string | null;
  reservoir: { position: ReservoirPosition; formation: string | null };
  seminoleField: typeof SEMINOLE_FIELD_ROZ | null;
}

/** Null outside Gaines County or without a field name: the dataset says nothing there. */
export function sanAndresRozContext(county: string | null | undefined, fieldName: string | null | undefined): RozContext | null {
  if (!fieldName || !/^GAINES$/i.test((county ?? "").replace(/\s*COUNTY$/i, "").trim())) return null;
  const parsed = parseFieldName(fieldName);
  const base = { dataset: ROZ_DATASET, fieldName: fieldName.replace(/\s+/g, " ").trim(), reservoir: reservoirPosition(parsed.reservoir) };
  if (SPLIT_FIELDS[parsed.core]) return { ...base, status: "not_established", partition: null, matchedAs: null, reason: `${SPLIT_FIELDS[parsed.core]}; which part this one lies in is shown only on the appraisal's maps.`, seminoleField: null };
  const rule = FIELD_RULES.find(r => r.core === parsed.core && (r.directions === "any" || r.directions.includes(parsed.direction)));
  if (!rule) return { ...base, status: "not_established", partition: null, matchedAs: null, reason: "The appraisal covers all of Gaines County but names only some fields when it describes its partitions, and it does not name this one; its partition boundaries are drawn only on maps.", seminoleField: null };
  return { ...base, status: "assigned", partition: GAINES_ROZ_PARTITIONS.find(p => p.id === rule.partition)!, matchedAs: rule.reportName, reason: null, seminoleField: rule.core === "SEMINOLE" ? SEMINOLE_FIELD_ROZ : null };
}

// ── Wording shared by the Mineral Finder page, its PDF and the Decision Record ──

const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
const n = (x: number) => x.toLocaleString("en-US");
const unitLine = (x: RozUnit) => `about ${n(x.depthFt)} ft; ${n(x.netPayFt)} ft net pay; ${pct(x.porosity)} porosity; ${pct(x.oilSaturation)} oil saturation`;

export function rozCitation(ctx: RozContext): string {
  const parts = ["section 2.2, p. 29", "Exhibits 2-6 and 2-7, p. 30", "Exhibit 2-8, p. 31", "Exhibit 2-9, p. 32"];
  if (ctx.partition) parts.push(ctx.partition.propertiesExhibit);
  if (ctx.seminoleField) parts.push(ctx.seminoleField.exhibit);
  return `U.S. DOE National Energy Technology Laboratory, ${ROZ_SOURCE.report}, "${ROZ_SOURCE.title}" (${ROZ_SOURCE.authors}), ${ROZ_SOURCE.date}: ${parts.join("; ")}.`;
}

export interface RozDescription {
  summary: string;
  figures: { label: string; value: string }[];
  reservoirNote: string;
  caveat: string;
}

/** `subject` is "well" for a Mineral Finder lead, "lease" for a Decision Record lease. */
export function describeRoz(ctx: RozContext, subject: "well" | "lease"): RozDescription {
  const r = ctx.reservoir;
  const reservoirNote = r.position === "san_andres"
    ? `Completed in the San Andres. Whether ${subject === "well" ? "this well was" : "this lease's wells were"} drilled below the main pay into the residual oil zone is not established; RRC's wellbore records carry no total depth.`
    : r.position === "below"
      ? `Produces from the ${r.formation}, which lies below the San Andres, so ${subject === "well" ? "this well was" : "these wells were"} drilled through the San Andres interval that holds the residual oil zone.`
      : r.position === "above"
        ? `Produces from the ${r.formation}, above the San Andres; ${subject === "well" ? "this well" : "these wells"} may not reach the residual oil zone.`
        : "The field name does not state the producing reservoir, so the relation to the San Andres is not established.";
  const caveat = "Partition averages are not measurements at this " + subject + ". The residual oil zone holds oil left behind by a natural waterflood; recovering it requires CO2 flooding, not conventional pumping. This context establishes no reserves, rights or value.";
  if (ctx.status !== "assigned" || !ctx.partition) {
    return { summary: `Gaines County San Andres residual oil zone partition not established for ${ctx.fieldName}. ${ctx.reason ?? ""}`.trim(), figures: [], reservoirNote, caveat };
  }
  const p = ctx.partition;
  const figures = [
    { label: "ROZ 1 (upper), higher quality", value: unitLine(p.roz1.higher) },
    { label: "ROZ 2 (lower), higher quality", value: unitLine(p.roz2.higher) },
    { label: "Partition oil in place", value: `${n(p.oipMMbbl.total)} million bbl (${n(p.oipMMbbl.higher)} million higher quality) across ${n(p.assessedAcres)} assessed acres` },
    { label: "Recoverable with CO2 EOR", value: `${n(p.technicallyRecoverableMMbbl)} million bbl (${p.technicallyRecoverablePctOip}% of in place)` },
    { label: "Commercially viable (study)", value: `${n(p.commerciallyViableMMbbl)} million bbl, at ${ROZ_SOURCE.economicBasis}` },
  ];
  if (ctx.seminoleField) figures.push({ label: "Seminole field ROZ (published)", value: `upper ROZ ${n(ctx.seminoleField.grossFt)} ft gross, ${n(ctx.seminoleField.netPayFt)} ft net pay, ${ctx.seminoleField.porosityPct}% porosity, ${ctx.seminoleField.oilSaturationPct}% oil saturation, below the field's main pay zone` });
  const summary = `${ctx.fieldName} is in Partition #${p.id} of the DOE/NETL San Andres residual oil zone appraisal (${p.setting}), which names ${ctx.matchedAs} among that partition's fields. The appraisal excludes the area under existing fields, so the partition figures describe the surrounding residual oil zone, not this ${subject}.`;
  return { summary, figures, reservoirNote, caveat };
}
