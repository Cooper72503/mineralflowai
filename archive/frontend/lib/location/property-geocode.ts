/**
 * Property geocoding — resolves a PLSS legal description to a lat/lng centroid.
 *
 * Priority:
 *  1. BLM PLSS ArcGIS API (authoritative federal cadastral data)
 *  2. Mathematical meridian fallback (principal meridian + township/range offset)
 *  3. null — when neither township nor range is available
 *
 * Extracted from app/api/plss-centroid/route.ts so it can be called
 * server-side without an HTTP round-trip.
 */

// ── Principal meridian origins (lon, lat) ─────────────────────────────────────
const MERIDIAN_ORIGINS: Record<string, [number, number]> = {
  "6th pm":          [-97.37, 40.00],
  "black hills":     [-104.06, 44.00],
  "boise":           [-116.39, 43.37],
  "choctaw":         [-94.62, 34.62],
  "cimarron":        [-103.00, 36.50],
  "copper river":    [-145.33, 61.37],
  "fairbanks":       [-147.64, 64.86],
  "gila-salt river": [-112.35, 33.37],
  "humboldt":        [-124.15, 40.44],
  "indian":          [-97.45, 34.98],
  "louisiana":       [-92.41, 31.00],
  "michigan":        [-84.37, 42.42],
  "montana":         [-111.64, 45.79],
  "mount diablo":    [-121.91, 37.88],
  "navajo":          [-108.53, 36.77],
  "new mexico":      [-106.89, 34.16],
  "ohio":            [-81.69, 40.99],
  "seward":          [-149.36, 60.12],
  "st. helena":      [-91.13, 30.99],
  "st. stephens":    [-88.02, 30.99],
  "tallahassee":     [-84.27, 30.44],
  "uintah":          [-109.93, 40.43],
  "ute":             [-108.53, 39.37],
  "washington":      [-90.90, 30.30],
  "willamette":      [-122.74, 45.52],
  "wind river":      [-108.81, 42.83],
};

const STATE_MERIDIAN: Record<string, string> = {
  ND: "6th pm", SD: "6th pm", NE: "6th pm", KS: "6th pm",
  MN: "6th pm", IA: "6th pm", MO: "6th pm",
  MT: "montana",
  ID: "boise",
  WA: "willamette", OR: "willamette",
  CA: "mount diablo", NV: "mount diablo",
  AZ: "gila-salt river",
  UT: "uintah",
  CO: "6th pm",
  WY: "6th pm",
  OK: "indian",
  TX: "texas abstract",
  LA: "louisiana",
  MS: "louisiana",
  AL: "st. stephens",
  FL: "tallahassee",
  OH: "michigan", IN: "michigan", MI: "michigan",
};

const KM_PER_DEG_LAT = 111.0;
const TWP_KM = 9.656; // 6 miles per township side

function kmPerDegLon(lat: number): number {
  return Math.cos((lat * Math.PI) / 180) * 111.32;
}

function parseTR(raw: string): { n: number; dir: string } | null {
  const m = raw.trim().match(/^[TR]?(\d+)\s*([NSEW])$/i) ??
            raw.trim().match(/^(\d+)\s*([NSEW])$/i);
  if (!m) {
    const bare = raw.trim().match(/^[TR]?(\d+)$/);
    if (bare) return { n: parseInt(bare[1]), dir: "?" };
    return null;
  }
  return { n: parseInt(m[1]), dir: m[2].toUpperCase() };
}

function sectionOffset(section: number): { dLat: number; dLon: number } {
  if (section < 1 || section > 36) return { dLat: 0, dLon: 0 };
  const sectionSizeKm = TWP_KM / 6;
  const row = Math.floor((section - 1) / 6);
  const col = (section - 1) % 6;
  const adjustedCol = row % 2 === 0 ? col : 5 - col;
  const latOffsetKm = -(row + 0.5) * sectionSizeKm;
  const lonOffsetKm = (5 - adjustedCol + 0.5) * sectionSizeKm;
  return { dLat: latOffsetKm, dLon: lonOffsetKm };
}

function mathFallback(
  twp: string,
  rng: string,
  section: string | null,
  state: string | null,
): { lat: number; lng: number } | null {
  const t = parseTR(twp);
  const r = parseTR(rng);
  if (!t || !r) return null;

  const stateKey = state?.toUpperCase().trim() ?? "";
  const meridianKey = STATE_MERIDIAN[stateKey] ?? "6th pm";
  const origin = MERIDIAN_ORIGINS[meridianKey];
  if (!origin) return null;

  const [originLon, originLat] = origin;
  const twpDir = t.dir === "S" ? -1 : 1;
  const rngDir = r.dir === "E" ? 1 : -1;

  const latKm = twpDir * (t.n - 0.5) * TWP_KM;
  const lonKm = rngDir * (r.n - 0.5) * TWP_KM;

  let lat = originLat + latKm / KM_PER_DEG_LAT;
  let lng = originLon + lonKm / kmPerDegLon(lat);

  if (section) {
    const sec = parseInt(section);
    if (!isNaN(sec)) {
      const off = sectionOffset(sec);
      const twpNWLat = lat + (TWP_KM / 2) / KM_PER_DEG_LAT;
      const twpNWLng = lng - (TWP_KM / 2) / kmPerDegLon(lat);
      lat = twpNWLat + off.dLat / KM_PER_DEG_LAT;
      lng = twpNWLng + off.dLon / kmPerDegLon(lat);
    }
  }

  return { lat, lng };
}

async function tryBlmApi(
  twp: string,
  rng: string,
  section: string | null,
  state: string | null,
): Promise<{ lat: number; lng: number } | null> {
  const normalise = (s: string, prefix: string) => {
    const m = s.match(/^[TR]?(\d+)([NSEW]?)$/i);
    if (!m) return s;
    return `${prefix}${m[1]}${m[2].toUpperCase() || (prefix === "T" ? "N" : "W")}`;
  };
  const twpLabel = normalise(twp.trim(), "T");
  const rngLabel = normalise(rng.trim(), "R");

  const stateFilter = state ? ` AND STATENAM='${state.toUpperCase()}'` : "";
  const where = `TWNSHPLAB='${twpLabel}' AND RANGLAB='${rngLabel}'${stateFilter}`;
  const params = new URLSearchParams({
    where,
    outFields: "TWNSHPLAB,RANGLAB,STATENAM",
    returnCentroid: "true",
    f: "json",
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(
      `https://gis.blm.gov/arcgis/rest/services/Cadastral/BLM_Natl_PLSS_CadNSDI/MapServer/1/query?${params}`,
      { signal: controller.signal },
    );
    clearTimeout(timer);
    if (!res.ok) return null;
    const json = await res.json() as {
      features?: Array<{ centroid?: { x: number; y: number } }>;
    };
    const centroid = json.features?.[0]?.centroid;
    if (!centroid) return null;

    let lat = centroid.y;
    let lng = centroid.x;

    if (section) {
      const sec = parseInt(section);
      if (!isNaN(sec)) {
        const off = sectionOffset(sec);
        const twpNWLat = lat + (TWP_KM / 2) / KM_PER_DEG_LAT;
        const twpNWLng = lng - (TWP_KM / 2) / kmPerDegLon(lat);
        lat = twpNWLat + off.dLat / KM_PER_DEG_LAT;
        lng = twpNWLng + off.dLon / kmPerDegLon(lat);
      }
    }
    return { lat, lng };
  } catch {
    clearTimeout(timer);
    return null;
  }
}

export type PropertyGeocodeResult = {
  lat: number;
  lng: number;
  /** "plss_blm" = authoritative BLM data; "plss_estimated" = mathematical fallback; "county_centroid" = county-level fallback */
  source: "plss_blm" | "plss_estimated" | "county_centroid";
};

/**
 * Resolve a PLSS township/range/section to a lat/lng centroid.
 * Returns null when township or range are missing or unparseable.
 */
export async function geocodeProperty(args: {
  township: string | null | undefined;
  range: string | null | undefined;
  section: string | null | undefined;
  state: string | null | undefined;
}): Promise<PropertyGeocodeResult | null> {
  const { township, range, section, state } = args;
  if (!township || !range) return null;

  // Try BLM authoritative API first
  const blm = await tryBlmApi(township, range, section ?? null, state ?? null).catch(() => null);
  if (blm) return { ...blm, source: "plss_blm" };

  // Math fallback
  const math = mathFallback(township, range, section ?? null, state ?? null);
  if (!math) return null;
  return { ...math, source: "plss_estimated" };
}
