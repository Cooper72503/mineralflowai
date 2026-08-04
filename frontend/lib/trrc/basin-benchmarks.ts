/**
 * Basin-level LOE / decline-rate / oil-differential reference ranges, used
 * to (a) pick a more realistic default LOE than one flat number for every
 * well in Texas, and (b) flag when a well's computed decline rate falls
 * well outside what's typical for its play.
 *
 * IMPORTANT PROVENANCE NOTE: this is an internal reference table compiled
 * from general, widely-known industry characteristics of these specific
 * Texas plays (Permian horizontal wells decline faster than West Texas
 * conventional stripper wells; Barnett's LOE runs high because of
 * compression costs on an aging shale play; Eagle Ford declines faster
 * than the Permian; etc.) — NOT a live feed from any EIA API or dataset.
 * The landing page's marketing copy describes some of these ranges as
 * "EIA 2022-sourced" for the Gulf Coast/other-basins category — that
 * specific citation could not be verified against any real, findable EIA
 * report or dataset and is NOT reproduced here as a sourced citation. If
 * that copy needs to stay accurate, it should say "internal reference
 * range" rather than cite a specific EIA report, or a real EIA/other
 * source needs to be found and cited properly. Flagged to Cooper
 * separately — do not present this table as literally EIA-sourced
 * anywhere in the product.
 */

export interface BasinBenchmark {
  id: string;
  name: string;
  description: string;
  loeUsdPerBoeRange: [number, number];
  declineRatePctPerMonthRange: [number, number] | null;
  oilDifferentialUsdBblRange: [number, number] | null;
  // Field-name substrings (checked case-insensitively) that indicate this
  // basin. Order matters — more specific plays are checked before broader
  // catch-alls in classifyBasin().
  fieldNameKeywords: string[];
  countyKeywords: string[];
}

export const BASIN_BENCHMARKS: BasinBenchmark[] = [
  {
    id: "barnett_shale",
    name: "Barnett Shale",
    description: "Mature shale play. LOE driven up by compression and well age.",
    loeUsdPerBoeRange: [14, 30],
    declineRatePctPerMonthRange: [2.0, 2.0],
    oilDifferentialUsdBblRange: null,
    fieldNameKeywords: ["BARNETT"],
    countyKeywords: ["TARRANT", "JOHNSON", "WISE", "DENTON", "PARKER"],
  },
  {
    id: "eagle_ford",
    name: "Eagle Ford",
    description: "Oil window and gas/condensate window. Faster decline, lower disposal costs than the Permian.",
    loeUsdPerBoeRange: [6, 16],
    declineRatePctPerMonthRange: [4.5, 5.0],
    oilDifferentialUsdBblRange: null,
    fieldNameKeywords: ["EAGLE FORD", "EAGLEVILLE"],
    countyKeywords: ["KARNES", "DEWITT", "DE WITT", "LA SALLE", "MCMULLEN", "LIVE OAK", "GONZALES", "DIMMIT", "WEBB", "ATASCOSA"],
  },
  {
    id: "east_tx_haynesville",
    name: "East Texas / Haynesville",
    description: "Cotton Valley and Haynesville formations. High salt water disposal costs; strong Midcontinent gas infrastructure.",
    loeUsdPerBoeRange: [10, 25],
    declineRatePctPerMonthRange: null,
    oilDifferentialUsdBblRange: null,
    fieldNameKeywords: ["HAYNESVILLE", "COTTON VALLEY"],
    countyKeywords: ["PANOLA", "HARRISON", "SHELBY", "NACOGDOCHES", "SAN AUGUSTINE"],
  },
  {
    id: "permian_basin",
    name: "Permian Basin",
    description: "Midland and Delaware sub-basins.",
    loeUsdPerBoeRange: [7.5, 20],
    declineRatePctPerMonthRange: [2.5, 3.0],
    oilDifferentialUsdBblRange: [-4.0, -3.5],
    fieldNameKeywords: ["WOLFCAMP", "BONE SPRING", "AVALON", "DELAWARE", "MIDLAND"],
    countyKeywords: ["MIDLAND", "ECTOR", "REEVES", "LOVING", "WARD", "WINKLER", "ANDREWS", "MARTIN", "HOWARD", "GLASSCOCK", "UPTON", "REAGAN", "CRANE", "PECOS", "CULBERSON"],
  },
  {
    id: "west_tx_conventional",
    name: "West Texas Conventional",
    description: "Spraberry / Wolfcamp conventional — long-lived stripper wells with higher per-unit operating costs than the modern horizontal Permian play.",
    loeUsdPerBoeRange: [12, 32],
    declineRatePctPerMonthRange: [1.2, 1.2],
    oilDifferentialUsdBblRange: null,
    fieldNameKeywords: ["SPRABERRY"],
    countyKeywords: [],
  },
  {
    id: "gulf_coast_other",
    name: "Gulf Coast & Other Texas Basins",
    description: "Frio / Yegua / Austin Chalk and other Texas basins outside the five named plays above.",
    loeUsdPerBoeRange: [8, 20],
    declineRatePctPerMonthRange: null,
    oilDifferentialUsdBblRange: null,
    fieldNameKeywords: ["FRIO", "YEGUA", "AUSTIN CHALK"],
    countyKeywords: [],
  },
];

/**
 * Classifies a well's basin from its TRRC field name (checked first — more
 * specific and reliable) and county (fallback). Returns null when nothing
 * matches rather than guessing — an unclassified well falls back to the
 * generic flat LOE default in economics.ts, not a wrong basin's range.
 */
export function classifyBasin(fieldName: string | null, county: string | null): BasinBenchmark | null {
  const field = (fieldName ?? "").toUpperCase();
  const cty = (county ?? "").toUpperCase();

  if (field) {
    for (const basin of BASIN_BENCHMARKS) {
      if (basin.fieldNameKeywords.some(kw => field.includes(kw))) return basin;
    }
  }
  if (cty) {
    for (const basin of BASIN_BENCHMARKS) {
      if (basin.countyKeywords.some(kw => cty.includes(kw))) return basin;
    }
  }
  return null;
}

export function loeMidpoint(basin: BasinBenchmark): number {
  return (basin.loeUsdPerBoeRange[0] + basin.loeUsdPerBoeRange[1]) / 2;
}

/**
 * Checks whether a computed effective annual decline rate is within (or
 * reasonably close to) the basin's typical monthly-decline-derived range —
 * mirrors the landing page's "if the numbers don't match, flag it" claim.
 * Returns null when the basin has no decline range to compare against.
 */
export function checkDeclineAgainstBasin(basin: BasinBenchmark, diAnnualPct: number): { inRange: boolean; typicalAnnualRangePct: [number, number] } | null {
  if (!basin.declineRatePctPerMonthRange) return null;
  const [loMo, hiMo] = basin.declineRatePctPerMonthRange;
  // Convert typical monthly nominal decline to an annual effective range,
  // same formula used for diAnnualPct elsewhere (1 - (1-d)^12), for an
  // apples-to-apples comparison against the fitted well's own annual figure.
  const toAnnual = (moPct: number) => (1 - Math.pow(1 - moPct / 100, 12)) * 100;
  const typicalAnnualRangePct: [number, number] = [toAnnual(loMo), toAnnual(hiMo)];
  // Allow some slack either side — this is a sanity check against a broad
  // industry range, not a precise per-well prediction.
  const slack = (typicalAnnualRangePct[1] - typicalAnnualRangePct[0]) * 0.5 + 5;
  const inRange = diAnnualPct >= typicalAnnualRangePct[0] - slack && diAnnualPct <= typicalAnnualRangePct[1] + slack;
  return { inRange, typicalAnnualRangePct };
}
