/**
 * County centroid geocoding — fallback when PLSS coordinates are unavailable.
 *
 * Used for Texas abstract/survey descriptions and other non-PLSS systems.
 * Accuracy: ±20–30 miles (county level). Suitable for "in county" well searches
 * but NOT for radius-filtered nearby well lookups.
 *
 * Lat/lng values are approximate county centroids.
 */

export type CountyGeocodeResult = {
  lat: number;
  lng: number;
  source: "county_centroid";
  accuracy: "county";
};

// Texas county centroids (lat, lng) for major oil/gas producing counties
const TX_CENTROIDS: Record<string, [number, number]> = {
  // Permian Basin
  midland:    [31.87,  -102.03],
  ector:      [31.87,  -102.55],
  andrews:    [32.31,  -102.54],
  martin:     [32.31,  -101.97],
  howard:     [32.30,  -101.44],
  glasscock:  [31.87,  -101.52],
  reagan:     [31.37,  -101.52],
  upton:      [31.37,  -102.03],
  ward:       [31.51,  -103.10],
  winkler:    [31.83,  -103.06],
  loving:     [31.83,  -103.60],
  reeves:     [31.37,  -104.00],
  pecos:      [30.73,  -102.90],
  crane:      [31.42,  -102.35],
  irion:      [31.29,  -100.99],
  sterling:   [31.82,  -100.99],
  coke:       [32.18,  -100.53],
  mitchell:   [32.30,  -100.92],
  nolan:      [32.30,  -100.41],
  // Eagle Ford
  karnes:     [28.89,  -97.86],
  dewitt:     [29.13,  -97.34],
  gonzales:   [29.44,  -97.50],
  frio:       [28.81,  -99.11],
  lasalle:    [28.34,  -99.10],
  dimmit:     [28.38,  -99.75],
  zavala:     [28.87,  -99.76],
  webb:       [27.74,  -99.40],
  atascosa:   [28.89,  -98.52],
  mcmullen:   [28.35,  -98.57],
  live_oak:   [28.33,  -98.09],
  "live oak": [28.33,  -98.09],
  bee:        [28.35,  -97.71],
  // Barnett Shale / Fort Worth
  tarrant:    [32.77,  -97.29],
  johnson:    [32.37,  -97.36],
  parker:     [32.78,  -97.81],
  hood:       [32.44,  -97.81],
  somervell:  [32.21,  -97.78],
  wise:       [33.22,  -97.66],
  denton:     [33.21,  -97.13],
  // East Texas
  rusk:       [31.89,  -94.76],
  panola:     [32.16,  -94.30],
  gregg:      [32.48,  -94.82],
  harrison:   [32.54,  -94.38],
  shelby:     [31.79,  -94.14],
  // North Texas / Granite Wash
  wheeler:    [35.40,  -100.29],
  hemphill:   [35.84,  -100.10],
  gray:       [35.40,  -100.80],
  // South Texas / Gulf Coast
  harris:     [29.85,  -95.40],
  brazoria:   [29.17,  -95.44],
  jefferson:  [30.04,  -94.10],
};

// North Dakota county centroids
const ND_CENTROIDS: Record<string, [number, number]> = {
  mckenzie:   [47.82,  -103.60],
  williams:   [48.42,  -103.50],
  mountrail:  [48.26,  -102.36],
  dunn:       [47.36,  -102.63],
  stark:      [46.86,  -102.62],
  billings:   [46.89,  -103.62],
  divide:     [48.79,  -103.32],
  bowman:     [46.14,  -103.50],
};

// Oklahoma county centroids
const OK_CENTROIDS: Record<string, [number, number]> = {
  canadian:   [35.52,  -98.01],
  grady:      [34.99,  -97.90],
  stephens:   [34.49,  -97.84],
  garfield:   [36.38,  -97.79],
  kay:        [36.83,  -97.10],
  blaine:     [35.88,  -98.44],
  kingfisher: [35.93,  -98.00],
  woods:      [36.77,  -98.77],
  alfalfa:    [36.77,  -98.32],
  major:      [36.31,  -98.60],
  woodward:   [36.43,  -99.27],
  beaver:     [36.75,  -100.49],
  texas:      [36.75,  -101.49],
  cimarron:   [36.75,  -102.48],
};

type StateCentroids = Record<string, [number, number]>;

const STATE_CENTROIDS: Record<string, StateCentroids> = {
  TX: TX_CENTROIDS,
  TEXAS: TX_CENTROIDS,
  ND: ND_CENTROIDS,
  "NORTH DAKOTA": ND_CENTROIDS,
  OK: OK_CENTROIDS,
  OKLAHOMA: OK_CENTROIDS,
};

function normalizeKey(s: string): string {
  return s.toLowerCase().replace(/\s+county\s*$/i, "").trim();
}

/**
 * Returns an approximate county centroid for states where PLSS geocoding
 * is unavailable (e.g. Texas abstract/survey system).
 *
 * Returns null when the state or county is not in the lookup table.
 */
export function geocodeFromCountyCentroid(
  county: string | null,
  state: string | null,
): CountyGeocodeResult | null {
  if (!county || !state) return null;

  const stateKey = state.trim().toUpperCase();
  const countyKey = normalizeKey(county);

  const centroids = STATE_CENTROIDS[stateKey];
  if (!centroids) return null;

  const coords = centroids[countyKey];
  if (!coords) return null;

  return { lat: coords[0], lng: coords[1], source: "county_centroid", accuracy: "county" };
}
