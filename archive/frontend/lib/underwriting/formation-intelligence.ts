/**
 * Formation Intelligence — county + state → basin / formation / EUR benchmarks
 *
 * Each entry encodes regionally-calibrated EUR expectations derived from
 * public decline curve studies, state regulatory data, and published basin
 * benchmarks (Wood Mackenzie, EIA basin production statistics, SPE papers).
 *
 * All EUR figures represent GROSS per-well P50 BBL (horizontal well unless noted).
 * Mark-up: ESTIMATED — these are directional, not engineering-certified.
 */

import type { FormationProfile } from "./types-acreage";

// ─── Basin definitions ────────────────────────────────────────────────────────

type BasinEntry = {
  basin:                     string;
  primary_formation:         string;
  secondary_formations:      string[];
  play_type:                 FormationProfile["play_type"];
  avg_lateral_length_ft:     number | null;
  benchmark_p10_eur_bbl:     number | null;
  benchmark_p50_eur_bbl:     number | null;
  benchmark_p90_eur_bbl:     number | null;
  benchmark_peak_month_bbl:  number | null;
  benchmark_spacing_acres:   number | null;
  commentary:                string;
};

const BASIN_PROFILES: Record<string, BasinEntry> = {

  // ── Permian Basin – Delaware (Wolfcamp / Bone Spring) ─────────────────────
  permian_delaware: {
    basin: "Permian Basin — Delaware",
    primary_formation: "Wolfcamp A",
    secondary_formations: ["Wolfcamp B", "Bone Spring 1st", "Bone Spring 2nd", "Bone Spring 3rd", "Delaware"],
    play_type: "unconventional_oil",
    avg_lateral_length_ft: 10000,
    benchmark_p10_eur_bbl: 1_200_000,
    benchmark_p50_eur_bbl:   700_000,
    benchmark_p90_eur_bbl:   350_000,
    benchmark_peak_month_bbl: 22_000,
    benchmark_spacing_acres: 80,
    commentary: "Top-tier Permian Delaware Basin play. Wolfcamp and Bone Spring stack offer multi-bench development potential. Strong operator competition and high capital intensity.",
  },

  // ── Permian Basin – Midland (Wolfcamp / Spraberry) ────────────────────────
  permian_midland: {
    basin: "Permian Basin — Midland",
    primary_formation: "Wolfcamp A",
    secondary_formations: ["Wolfcamp B", "Wolfcamp D", "Spraberry", "Dean", "Clearfork"],
    play_type: "unconventional_oil",
    avg_lateral_length_ft: 10000,
    benchmark_p10_eur_bbl: 1_000_000,
    benchmark_p50_eur_bbl:   600_000,
    benchmark_p90_eur_bbl:   280_000,
    benchmark_peak_month_bbl: 18_000,
    benchmark_spacing_acres: 80,
    commentary: "Prolific Midland Basin with stacked pay in Wolfcamp and Spraberry. Multi-well pad development common. Major operators include Pioneer, Diamondback, Occidental.",
  },

  // ── Eagle Ford (South Texas) ──────────────────────────────────────────────
  eagle_ford_oil: {
    basin: "Eagle Ford — Oil Window",
    primary_formation: "Eagle Ford",
    secondary_formations: ["Austin Chalk", "Buda Lime"],
    play_type: "unconventional_oil",
    avg_lateral_length_ft: 6500,
    benchmark_p10_eur_bbl: 600_000,
    benchmark_p50_eur_bbl: 280_000,
    benchmark_p90_eur_bbl: 120_000,
    benchmark_peak_month_bbl: 8_000,
    benchmark_spacing_acres: 100,
    commentary: "Eagle Ford oil window spans DeWitt, Karnes, and surrounding counties. Condensate-rich in places. Austin Chalk re-development active.",
  },

  eagle_ford_gas: {
    basin: "Eagle Ford — Gas/Condensate Window",
    primary_formation: "Eagle Ford",
    secondary_formations: ["Austin Chalk"],
    play_type: "unconventional_gas",
    avg_lateral_length_ft: 6500,
    benchmark_p10_eur_bbl: 200_000,
    benchmark_p50_eur_bbl:  80_000,
    benchmark_p90_eur_bbl:  30_000,
    benchmark_peak_month_bbl: 3_000,
    benchmark_spacing_acres: 100,
    commentary: "Dry gas and condensate window of Eagle Ford in Webb, La Salle, Dimmit counties. Primarily gas-weighted; condensate credits improve economics.",
  },

  // ── Haynesville / Cotton Valley (East Texas / NW Louisiana) ──────────────
  haynesville: {
    basin: "Haynesville Shale",
    primary_formation: "Haynesville",
    secondary_formations: ["Bossier", "Cotton Valley", "Mid-Bossier"],
    play_type: "unconventional_gas",
    avg_lateral_length_ft: 10000,
    benchmark_p10_eur_bbl: 30_000,
    benchmark_p50_eur_bbl: 10_000,
    benchmark_p90_eur_bbl:  4_000,
    benchmark_peak_month_bbl: 800,
    benchmark_spacing_acres: 150,
    commentary: "Gas-dominant play. EUR in gas-equivalent BBL modest; primary value driver is high BTU gas to LNG markets. Deep, high-cost wells.",
  },

  // ── Barnett Shale (Fort Worth Basin) ─────────────────────────────────────
  barnett: {
    basin: "Fort Worth Basin — Barnett Shale",
    primary_formation: "Barnett Shale",
    secondary_formations: ["Marble Falls"],
    play_type: "unconventional_gas",
    avg_lateral_length_ft: 4000,
    benchmark_p10_eur_bbl: 12_000,
    benchmark_p50_eur_bbl:  5_000,
    benchmark_p90_eur_bbl:  1_500,
    benchmark_peak_month_bbl: 300,
    benchmark_spacing_acres: 80,
    commentary: "Mature gas shale — most development occurred 2005–2015. New activity limited. Value driven by residual PDP cash flow; undeveloped potential modest at current gas prices.",
  },

  // ── Anadarko / Granite Wash (Texas Panhandle / Oklahoma) ─────────────────
  anadarko: {
    basin: "Anadarko Basin — Granite Wash / Marmaton",
    primary_formation: "Granite Wash",
    secondary_formations: ["Marmaton", "Red Fork", "Cleveland"],
    play_type: "mixed",
    avg_lateral_length_ft: 5000,
    benchmark_p10_eur_bbl: 300_000,
    benchmark_p50_eur_bbl: 150_000,
    benchmark_p90_eur_bbl:  60_000,
    benchmark_peak_month_bbl: 5_000,
    benchmark_spacing_acres: 100,
    commentary: "Multi-bench liquids-rich play with gas. Granite Wash primary in Texas Panhandle. Activity has slowed since 2015 price downturn.",
  },

  // ── SCOOP / STACK (Oklahoma) ──────────────────────────────────────────────
  scoop_stack: {
    basin: "SCOOP / STACK — Anadarko Oklahoma",
    primary_formation: "Woodford",
    secondary_formations: ["Meramec", "Sycamore", "Springer", "Osage"],
    play_type: "unconventional_oil",
    avg_lateral_length_ft: 9000,
    benchmark_p10_eur_bbl: 700_000,
    benchmark_p50_eur_bbl: 350_000,
    benchmark_p90_eur_bbl: 150_000,
    benchmark_peak_month_bbl: 9_000,
    benchmark_spacing_acres: 100,
    commentary: "Oklahoma's premier unconventional play. SCOOP (Woodford) and STACK (Meramec/Sycamore) offer stacked pay in central Oklahoma. Devon, Continental, and Ovintiv active.",
  },

  // ── Bakken / Three Forks (North Dakota / Montana) ────────────────────────
  bakken: {
    basin: "Williston Basin — Bakken",
    primary_formation: "Bakken",
    secondary_formations: ["Three Forks", "Sanish", "Madison"],
    play_type: "unconventional_oil",
    avg_lateral_length_ft: 9500,
    benchmark_p10_eur_bbl: 900_000,
    benchmark_p50_eur_bbl: 500_000,
    benchmark_p90_eur_bbl: 200_000,
    benchmark_peak_month_bbl: 12_000,
    benchmark_spacing_acres: 120,
    commentary: "Established unconventional play. Three Forks adds secondary bench potential. High oil quality (light sweet crude). Infrastructure well developed.",
  },

  // ── DJ Basin / Niobrara (Colorado / Wyoming) ─────────────────────────────
  dj_niobrara: {
    basin: "DJ Basin — Niobrara / Codell",
    primary_formation: "Niobrara",
    secondary_formations: ["Codell", "Mowry", "Frontier"],
    play_type: "unconventional_oil",
    avg_lateral_length_ft: 9000,
    benchmark_p10_eur_bbl: 700_000,
    benchmark_p50_eur_bbl: 380_000,
    benchmark_p90_eur_bbl: 150_000,
    benchmark_peak_month_bbl: 10_000,
    benchmark_spacing_acres: 80,
    commentary: "Active development in Wattenberg Field and surrounding DJ Basin. Niobrara A/B/C benches. Weld County is the premier ZIP code. Permitting more restrictive due to residential proximity.",
  },

  // ── Gulf Coast (conventional, TX coast) ──────────────────────────────────
  gulf_coast: {
    basin: "Gulf Coast — Conventional",
    primary_formation: "Wilcox",
    secondary_formations: ["Frio", "Yegua", "Vicksburg", "Queen City"],
    play_type: "conventional_oil",
    avg_lateral_length_ft: null,
    benchmark_p10_eur_bbl: 200_000,
    benchmark_p50_eur_bbl:  60_000,
    benchmark_p90_eur_bbl:  15_000,
    benchmark_peak_month_bbl: 2_000,
    benchmark_spacing_acres: 40,
    commentary: "Mature conventional play. Multiple stacked sands with vertical well development. Decline rates higher than unconventional shale; offset EUR varies widely by field.",
  },

  // ── Permian Basin – conventional stripper (falling through) ───────────────
  permian_conventional: {
    basin: "Permian Basin — Conventional",
    primary_formation: "San Andres",
    secondary_formations: ["Yates", "Grayburg", "Queen", "Seven Rivers", "Delaware Sand"],
    play_type: "conventional_oil",
    avg_lateral_length_ft: null,
    benchmark_p10_eur_bbl: 150_000,
    benchmark_p50_eur_bbl:  40_000,
    benchmark_p90_eur_bbl:  10_000,
    benchmark_peak_month_bbl: 1_500,
    benchmark_spacing_acres: 40,
    commentary: "Mature carbonate production in the Permian. San Andres and Yates are prolific but high-water conventional intervals. Stripper-well economics common. Older legacy leases.",
  },

  // ── Permian Basin – Central Basin Platform (CBP) ─────────────────────────
  cbp: {
    basin: "Central Basin Platform — Permian",
    primary_formation: "Clearfork",
    secondary_formations: ["Spraberry", "San Andres", "Yates"],
    play_type: "conventional_oil",
    avg_lateral_length_ft: null,
    benchmark_p10_eur_bbl: 120_000,
    benchmark_p50_eur_bbl:  40_000,
    benchmark_p90_eur_bbl:  10_000,
    benchmark_peak_month_bbl: 1_200,
    benchmark_spacing_acres: 40,
    commentary: "Conventional carbonate development on the Central Basin Platform. Secondary recovery (waterflood) common. Slower decline than shale wells.",
  },

  // ── Fallback: unknown / general ───────────────────────────────────────────
  unknown: {
    basin: "Unknown / Unclassified",
    primary_formation: "Unknown",
    secondary_formations: [],
    play_type: "mixed",
    avg_lateral_length_ft: null,
    benchmark_p10_eur_bbl: null,
    benchmark_p50_eur_bbl: null,
    benchmark_p90_eur_bbl: null,
    benchmark_peak_month_bbl: null,
    benchmark_spacing_acres: null,
    commentary: "Insufficient location data to classify the formation or basin. Offset well production will be used for all EUR estimates.",
  },
};

// ─── County → basin key mapping ───────────────────────────────────────────────
// County names are lowercase, no "county" suffix.

const TX_COUNTY_BASIN: Record<string, string> = {
  // Delaware Basin
  loving: "permian_delaware", ward: "permian_delaware", winkler: "permian_delaware",
  reeves: "permian_delaware", culberson: "permian_delaware", pecos: "permian_delaware",
  jeff_davis: "permian_delaware",

  // Midland Basin
  midland: "permian_midland", martin: "permian_midland", andrews: "permian_midland",
  howard: "permian_midland", dawson: "permian_midland", borden: "permian_midland",
  glasscock: "permian_midland", reagan: "permian_midland", upton: "permian_midland",
  ector: "permian_midland", crane: "permian_midland", irion: "permian_midland",
  crockett: "permian_midland",

  // Eagle Ford – oil window
  karnes: "eagle_ford_oil", dewitt: "eagle_ford_oil", gonzales: "eagle_ford_oil",
  atascosa: "eagle_ford_oil", live_oak: "eagle_ford_oil", bee: "eagle_ford_oil",
  wilson: "eagle_ford_oil", lavaca: "eagle_ford_oil", frio: "eagle_ford_oil",
  mcmullen: "eagle_ford_oil",

  // Eagle Ford – gas/condensate
  webb: "eagle_ford_gas", la_salle: "eagle_ford_gas", dimmit: "eagle_ford_gas",
  zavala: "eagle_ford_gas", maverick: "eagle_ford_gas",

  // East Texas / Haynesville
  panola: "haynesville", rusk: "haynesville", shelby: "haynesville",
  harrison: "haynesville", gregg: "haynesville", upshur: "haynesville",
  nacogdoches: "haynesville", smith: "haynesville",

  // Barnett Shale
  tarrant: "barnett", denton: "barnett", johnson: "barnett", parker: "barnett",
  hood: "barnett", wise: "barnett", montague: "barnett", jack: "barnett",
  palo_pinto: "barnett", erath: "barnett", somervell: "barnett", bosque: "barnett",
  comanche: "barnett",

  // Anadarko / Granite Wash (TX Panhandle)
  wheeler: "anadarko", gray: "anadarko", hemphill: "anadarko",
  roberts: "anadarko", hutchinson: "anadarko", ochiltree: "anadarko",
  lipscomb: "anadarko", collingsworth: "anadarko", carson: "anadarko",
  potter: "anadarko", randall: "anadarko", oldham: "anadarko",

  // Gulf Coast
  harris: "gulf_coast", galveston: "gulf_coast", brazoria: "gulf_coast",
  matagorda: "gulf_coast", jackson: "gulf_coast", victoria: "gulf_coast",
  wharton: "gulf_coast", fort_bend: "gulf_coast", montgomery: "gulf_coast",
  chambers: "gulf_coast", jefferson: "gulf_coast",

  // Permian conventional / stripper (fallback for unlisted Permian counties)
  gaines: "permian_conventional", yoakum: "permian_conventional",
  lynn: "permian_conventional", garza: "permian_conventional",
  scurry: "permian_conventional", mitchell: "permian_conventional",
  nolan: "permian_conventional", fisher: "permian_conventional",
  stonewall: "permian_conventional", king: "permian_conventional",
  knox: "permian_conventional",
};

const OK_COUNTY_BASIN: Record<string, string> = {
  // SCOOP
  garvin: "scoop_stack", grady: "scoop_stack", carter: "scoop_stack",
  stephens: "scoop_stack", murray: "scoop_stack",
  // STACK
  blaine: "scoop_stack", canadian: "scoop_stack", kingfisher: "scoop_stack",
  alfalfa: "scoop_stack", dewey: "scoop_stack", major: "scoop_stack",
  // Other Oklahoma
  pittsburg: "scoop_stack", coal: "scoop_stack", hughes: "scoop_stack",
  pontotoc: "scoop_stack",
};

const ND_COUNTY_BASIN: Record<string, string> = {
  mountrail: "bakken", mckenzie: "bakken", williams: "bakken",
  burke: "bakken", divide: "bakken", bottineau: "bakken",
  dunn: "bakken", stark: "bakken", billings: "bakken",
  golden_valley: "bakken",
};

const CO_COUNTY_BASIN: Record<string, string> = {
  weld: "dj_niobrara", adams: "dj_niobrara", arapahoe: "dj_niobrara",
  boulder: "dj_niobrara", larimer: "dj_niobrara", morgan: "dj_niobrara",
  broomfield: "dj_niobrara",
};

// ─── Public API ───────────────────────────────────────────────────────────────

function normalizeCountyKey(county: string): string {
  return county
    .toLowerCase()
    .replace(/\s+county\s*$/i, "")
    .trim()
    .replace(/\s+/g, "_");
}

function resolveBasinKey(county: string | null, state: string | null): string {
  if (!county || !state) return "unknown";
  const key = normalizeCountyKey(county);
  const st  = state.toLowerCase().replace(/\s+/g, "");

  if (st === "texas" || st === "tx") return TX_COUNTY_BASIN[key] ?? "permian_conventional";
  if (st === "oklahoma" || st === "ok") return OK_COUNTY_BASIN[key] ?? "scoop_stack";
  if (st === "northdakota" || st === "nd") return ND_COUNTY_BASIN[key] ?? "bakken";
  if (st === "colorado" || st === "co") return CO_COUNTY_BASIN[key] ?? "dj_niobrara";
  return "unknown";
}

export function inferFormationProfile(
  county: string | null,
  state: string | null,
  formation_hint: string | null,
): FormationProfile {
  const basinKey = resolveBasinKey(county, state);
  const entry    = BASIN_PROFILES[basinKey] ?? BASIN_PROFILES["unknown"];

  // Allow a user-supplied formation hint to override primary_formation label
  const primaryFormation = formation_hint
    ? formation_hint.trim()
    : entry.primary_formation;

  return {
    primary_formation:        primaryFormation,
    secondary_formations:     entry.secondary_formations,
    basin:                    entry.basin,
    play_type:                entry.play_type,
    avg_lateral_length_ft:    entry.avg_lateral_length_ft,
    benchmark_p10_eur_bbl:    entry.benchmark_p10_eur_bbl,
    benchmark_p50_eur_bbl:    entry.benchmark_p50_eur_bbl,
    benchmark_p90_eur_bbl:    entry.benchmark_p90_eur_bbl,
    benchmark_peak_month_bbl: entry.benchmark_peak_month_bbl,
    benchmark_spacing_acres:  entry.benchmark_spacing_acres,
    source:                   "ESTIMATED",
    commentary:               entry.commentary,
  };
}
