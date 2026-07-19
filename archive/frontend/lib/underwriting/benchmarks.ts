/**
 * Texas Basin Benchmarks
 *
 * Maps Texas county FIPS codes (first 3 digits of 8-digit API number) to
 * oil & gas basin/region and provides EIA-sourced LOE benchmarks, typical
 * price differentials, and formation characteristics.
 *
 * Data sources:
 *   - EIA Form EIA-23L (2022 Annual Survey of Domestic Oil and Gas Reserves)
 *   - EIA U.S. crude oil and natural gas average wellhead prices
 *   - TRRC district/basin knowledge
 */

export type BasinBenchmark = {
  basin: string;               // e.g. "Permian Basin"
  sub_basin?: string;          // e.g. "Midland Basin"
  trrc_district: string;       // TRRC district code(s)
  // EIA 2022 average lifting costs (operating expenses / BOE produced)
  loe_low_per_boe: number;     // $/BOE low end
  loe_high_per_boe: number;    // $/BOE high end
  loe_median_per_boe: number;  // $/BOE median (use as estimate)
  // Water disposal typical cost
  disposal_cost_per_bbl: number; // $/BBL water disposed
  // Typical oil price differential vs WTI benchmark (negative = discount)
  oil_differential_per_bbl: number;
  // Typical gas price differential vs Henry Hub
  gas_differential_per_mmbtu: number;
  // Formation characteristics
  typical_water_cut_pct_range: [number, number];   // e.g. [20, 60]
  typical_decline_rate_monthly: number;             // median %/month
  // Typical plugging cost per well
  plug_cost_per_well: number;
  notes: string;
};

// ─── County → Basin mapping ───────────────────────────────────────────────────
// Key: 3-digit county code (first 3 digits of 8-digit Texas API number)
// Value: basin key

const COUNTY_TO_BASIN: Record<string, string> = {
  // Permian Basin — Midland Basin
  "227": "permian_midland",  // Howard
  "317": "permian_midland",  // Martin
  "329": "permian_midland",  // Midland
  "461": "permian_midland",  // Upton
  "335": "permian_midland",  // Mitchell
  "115": "permian_midland",  // Dawson
  "165": "permian_midland",  // Gaines
  "173": "permian_midland",  // Glasscock

  // Permian Basin — Delaware Basin / West Texas
  "389": "permian_delaware", // Reeves
  "475": "permian_delaware", // Ward
  "301": "permian_delaware", // Loving
  "495": "permian_delaware", // Winkler
  "135": "permian_delaware", // Ector
  "003": "permian_delaware", // Andrews
  "105": "permian_delaware", // Crane
  "501": "permian_delaware", // Yoakum

  // Permian adjacent / West Texas conventional
  "151": "west_texas_conv",  // Fisher
  "415": "west_texas_conv",  // Scurry
  "033": "west_texas_conv",  // Borden
  "263": "west_texas_conv",  // Kent
  "441": "west_texas_conv",  // Stonewall
  "189": "west_texas_conv",  // Haskell
  "207": "west_texas_conv",  // Jones

  // Eagle Ford — Core (oil window)
  "255": "eagle_ford_oil",   // Karnes
  "123": "eagle_ford_oil",   // DeWitt
  "177": "eagle_ford_oil",   // Gonzales
  "311": "eagle_ford_oil",   // McMullen
  "283": "eagle_ford_oil",   // La Salle
  "127": "eagle_ford_oil",   // Dimmit
  "507": "eagle_ford_oil",   // Zavala
  "163": "eagle_ford_oil",   // Frio

  // Eagle Ford — Gas/Condensate window
  "479": "eagle_ford_gas",   // Webb
  "131": "eagle_ford_gas",   // Duval
  "297": "eagle_ford_gas",   // Live Oak

  // Barnett Shale
  "121": "barnett",           // Denton
  "439": "barnett",           // Tarrant
  "251": "barnett",           // Johnson
  "367": "barnett",           // Parker
  "497": "barnett",           // Wise
  "221": "barnett",           // Hood

  // East Texas / Haynesville
  "183": "east_texas",        // Gregg
  "401": "east_texas",        // Rusk
  "423": "east_texas",        // Smith
  "365": "east_texas",        // Panola
  "347": "east_texas",        // Nacogdoches
  "203": "east_texas",        // Houston (county)
  "005": "east_texas",        // Anderson

  // Panhandle / Anadarko
  "211": "panhandle",         // Hemphill
  "233": "panhandle",         // Hutchinson
  "341": "panhandle",         // Moore
  "393": "panhandle",         // Roberts
  "065": "panhandle",         // Castro
  "069": "panhandle",         // Castro
  "357": "panhandle",         // Ochiltree

  // South Texas conventional
  "025": "south_texas",       // Bee
  "047": "south_texas",       // Brooks
  "249": "south_texas",       // Jim Wells
  "273": "south_texas",       // Kleberg

  // Gulf Coast / Southeast Texas
  "157": "gulf_coast",        // Fort Bend
  "201": "gulf_coast",        // Harris
  "039": "gulf_coast",        // Brazoria
  "071": "gulf_coast",        // Chambers
  "245": "gulf_coast",        // Jefferson
};

// ─── Basin benchmark data ─────────────────────────────────────────────────────

export const BASIN_BENCHMARKS: Record<string, BasinBenchmark> = {
  permian_midland: {
    basin: "Permian Basin",
    sub_basin: "Midland Basin",
    trrc_district: "8, 8A",
    loe_low_per_boe: 7.50,
    loe_high_per_boe: 18.00,
    loe_median_per_boe: 11.50,
    disposal_cost_per_bbl: 0.65,
    oil_differential_per_bbl: -3.50,
    gas_differential_per_mmbtu: -0.50,
    typical_water_cut_pct_range: [30, 75],
    typical_decline_rate_monthly: 2.5,
    plug_cost_per_well: 35_000,
    notes: "EIA 2022 Form EIA-23L. Permian Midland Basin tight oil. Active workover market keeps LOE moderate.",
  },
  permian_delaware: {
    basin: "Permian Basin",
    sub_basin: "Delaware Basin",
    trrc_district: "8",
    loe_low_per_boe: 8.00,
    loe_high_per_boe: 20.00,
    loe_median_per_boe: 13.00,
    disposal_cost_per_bbl: 0.75,
    oil_differential_per_bbl: -4.00,
    gas_differential_per_mmbtu: -0.75,
    typical_water_cut_pct_range: [40, 85],
    typical_decline_rate_monthly: 3.0,
    plug_cost_per_well: 38_000,
    notes: "Delaware Basin. Higher water production and disposal costs than Midland Basin.",
  },
  west_texas_conv: {
    basin: "West Texas Conventional",
    sub_basin: "Spraberry / Wolfcamp Conventional",
    trrc_district: "7B, 7C",
    loe_low_per_boe: 12.00,
    loe_high_per_boe: 32.00,
    loe_median_per_boe: 19.50,
    disposal_cost_per_bbl: 0.85,
    oil_differential_per_bbl: -5.00,
    gas_differential_per_mmbtu: -1.00,
    typical_water_cut_pct_range: [20, 70],
    typical_decline_rate_monthly: 1.2,
    plug_cost_per_well: 28_000,
    notes: "EIA 2022. West Texas conventional pumping wells. Lower decline, higher LOE/BOE than Permian tight oil.",
  },
  eagle_ford_oil: {
    basin: "Eagle Ford Shale",
    sub_basin: "Oil Window",
    trrc_district: "1, 2",
    loe_low_per_boe: 6.00,
    loe_high_per_boe: 16.00,
    loe_median_per_boe: 9.50,
    disposal_cost_per_bbl: 0.55,
    oil_differential_per_bbl: -3.00,
    gas_differential_per_mmbtu: -0.25,
    typical_water_cut_pct_range: [10, 50],
    typical_decline_rate_monthly: 4.5,
    plug_cost_per_well: 45_000,
    notes: "Eagle Ford oil window. Fast initial decline but low LOE/BOE at peak.",
  },
  eagle_ford_gas: {
    basin: "Eagle Ford Shale",
    sub_basin: "Gas/Condensate Window",
    trrc_district: "1",
    loe_low_per_boe: 5.00,
    loe_high_per_boe: 14.00,
    loe_median_per_boe: 8.00,
    disposal_cost_per_bbl: 0.40,
    oil_differential_per_bbl: -2.50,
    gas_differential_per_mmbtu: -0.15,
    typical_water_cut_pct_range: [5, 30],
    typical_decline_rate_monthly: 5.0,
    plug_cost_per_well: 48_000,
    notes: "Eagle Ford gas/condensate. Efficient operations, lower disposal.",
  },
  barnett: {
    basin: "Barnett Shale",
    sub_basin: undefined,
    trrc_district: "9",
    loe_low_per_boe: 14.00,
    loe_high_per_boe: 30.00,
    loe_median_per_boe: 20.00,
    disposal_cost_per_bbl: 0.70,
    oil_differential_per_bbl: -3.00,
    gas_differential_per_mmbtu: -0.30,
    typical_water_cut_pct_range: [15, 55],
    typical_decline_rate_monthly: 2.0,
    plug_cost_per_well: 52_000,
    notes: "Barnett mature shale play. LOE higher due to well age and compression costs.",
  },
  east_texas: {
    basin: "East Texas Basin",
    sub_basin: "Cotton Valley / Haynesville",
    trrc_district: "6",
    loe_low_per_boe: 10.00,
    loe_high_per_boe: 25.00,
    loe_median_per_boe: 16.00,
    disposal_cost_per_bbl: 0.75,
    oil_differential_per_bbl: -4.00,
    gas_differential_per_mmbtu: -0.20,
    typical_water_cut_pct_range: [25, 65],
    typical_decline_rate_monthly: 1.8,
    plug_cost_per_well: 32_000,
    notes: "East Texas conventional and tight gas. Significant salt water disposal costs.",
  },
  panhandle: {
    basin: "Texas Panhandle / Anadarko",
    sub_basin: undefined,
    trrc_district: "10",
    loe_low_per_boe: 8.00,
    loe_high_per_boe: 20.00,
    loe_median_per_boe: 13.00,
    disposal_cost_per_bbl: 0.60,
    oil_differential_per_bbl: -4.50,
    gas_differential_per_mmbtu: -0.40,
    typical_water_cut_pct_range: [15, 60],
    typical_decline_rate_monthly: 1.5,
    plug_cost_per_well: 25_000,
    notes: "Panhandle conventional. Mostly gas, moderate LOE.",
  },
  south_texas: {
    basin: "South Texas",
    sub_basin: "Lobo / Olmos",
    trrc_district: "4",
    loe_low_per_boe: 10.00,
    loe_high_per_boe: 28.00,
    loe_median_per_boe: 17.00,
    disposal_cost_per_bbl: 0.80,
    oil_differential_per_bbl: -4.00,
    gas_differential_per_mmbtu: -0.35,
    typical_water_cut_pct_range: [20, 70],
    typical_decline_rate_monthly: 1.5,
    plug_cost_per_well: 30_000,
    notes: "South Texas conventional. Mature fields, higher disposal costs.",
  },
  gulf_coast: {
    basin: "Gulf Coast",
    sub_basin: "Frio / Yegua / Austin Chalk",
    trrc_district: "3",
    loe_low_per_boe: 12.00,
    loe_high_per_boe: 30.00,
    loe_median_per_boe: 19.00,
    disposal_cost_per_bbl: 0.90,
    oil_differential_per_bbl: -3.50,
    gas_differential_per_mmbtu: 0.10,
    typical_water_cut_pct_range: [30, 80],
    typical_decline_rate_monthly: 1.5,
    plug_cost_per_well: 42_000,
    notes: "Gulf Coast conventional. High water production, coastal infrastructure costs.",
  },
};

// Default / statewide fallback (EIA Texas average 2022)
const TEXAS_DEFAULT: BasinBenchmark = {
  basin: "Texas (Statewide Average)",
  trrc_district: "All",
  loe_low_per_boe: 10.00,
  loe_high_per_boe: 28.00,
  loe_median_per_boe: 16.00,
  disposal_cost_per_bbl: 0.75,
  oil_differential_per_bbl: -4.00,
  gas_differential_per_mmbtu: -0.35,
  typical_water_cut_pct_range: [20, 65],
  typical_decline_rate_monthly: 2.0,
  plug_cost_per_well: 35_000,
  notes: "EIA 2022 Texas statewide average. County-to-basin mapping not available for this well.",
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Look up basin benchmarks from the first API number's county code.
 * api8 = 8-digit form (no "42" prefix), e.g. "15131926"
 */
export function getBenchmarkFromApi(api8: string): BasinBenchmark {
  const county3 = api8.slice(0, 3);
  const basinKey = COUNTY_TO_BASIN[county3];
  return basinKey ? BASIN_BENCHMARKS[basinKey] : TEXAS_DEFAULT;
}

/**
 * Look up basin benchmarks from a county name.
 */
export function getBenchmarkFromCounty(county: string): BasinBenchmark | null {
  const normalized = county.toLowerCase().replace(/\s+county$/i, "").trim();
  // Try to find county code by name
  const COUNTY_NAMES: Record<string, string> = {
    "fisher": "151", "howard": "227", "midland": "329", "martin": "317",
    "reeves": "389", "ward": "475", "loving": "301", "ector": "135",
    "andrews": "003", "crane": "105", "upton": "461", "glasscock": "173",
    "mitchell": "335", "dawson": "115", "gaines": "165", "winkler": "495",
    "scurry": "415", "borden": "033", "kent": "263",
    "karnes": "255", "dewitt": "123", "gonzales": "177", "mcmullen": "311",
    "la salle": "283", "dimmit": "127", "zavala": "507", "frio": "163",
    "webb": "479", "duval": "131", "live oak": "297",
    "denton": "121", "tarrant": "439", "johnson": "251", "parker": "367",
    "wise": "497", "hood": "221",
    "gregg": "183", "rusk": "401", "smith": "423", "panola": "365",
    "hemphill": "211", "hutchinson": "233", "moore": "341", "roberts": "393",
  };
  const code = COUNTY_NAMES[normalized];
  if (!code) return null;
  const basinKey = COUNTY_TO_BASIN[code];
  return basinKey ? BASIN_BENCHMARKS[basinKey] : TEXAS_DEFAULT;
}
