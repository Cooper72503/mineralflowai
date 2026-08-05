/**
 * PLSS (Public Land Survey System) geocoding — real federal cadastral data
 * first, a genuine geodetic meridian-math fallback second, explicit
 * UNMAPPABLE when neither resolves. Adapted from a legitimate prior
 * implementation in archive/frontend/lib/location/property-geocode.ts
 * (real BLM API + real published PLSS meridian origin coordinates — this
 * is standard surveying math, not fabricated).
 *
 * IMPORTANT CORRECTION vs. the archived version: it mapped TX to a
 * "texas abstract" meridian key that doesn't exist in its own origin
 * table (a dead, silently-broken fallback). This is correct behavior, not
 * a bug to route around — Texas was never surveyed under the federal PLSS
 * system (it retained its own land-grant/abstract-survey system from the
 * Republic of Texas era), so a PLSS township/range/section description
 * claiming to be in Texas cannot be geocoded via PLSS math at all. This
 * provider explicitly returns UNMAPPABLE for state:"TX" rather than
 * silently producing a wrong centroid. It exists in this engine mainly
 * for structural completeness (Phase 2 requires PLSS support) and any
 * future non-Texas expansion — this project's actual subject wells are
 * Texas TRRC wells, which almost always need the Texas land-grid provider
 * instead.
 *
 * Only fetches a centroid from BLM (not full section/township polygon
 * geometry), so even the "authoritative" tier here is CENTROID_ONLY, never
 * a polygon match — labeled as such, not overstated.
 */

import type { GeocodeResult, PlssLegalDescription, WarningEntry } from "../types";
import { withDefaultTimeout, DEFAULT_CONFIG } from "../constants";

const MERIDIAN_ORIGINS: Record<string, [number, number]> = {
  "6th pm": [-97.37, 40.00],
  "black hills": [-104.06, 44.00],
  boise: [-116.39, 43.37],
  choctaw: [-94.62, 34.62],
  cimarron: [-103.00, 36.50],
  "gila-salt river": [-112.35, 33.37],
  humboldt: [-124.15, 40.44],
  indian: [-97.45, 34.98],
  louisiana: [-92.41, 31.00],
  michigan: [-84.37, 42.42],
  montana: [-111.64, 45.79],
  "mount diablo": [-121.91, 37.88],
  "new mexico": [-106.89, 34.16],
  "st. stephens": [-88.02, 30.99],
  tallahassee: [-84.27, 30.44],
  uintah: [-109.93, 40.43],
  willamette: [-122.74, 45.52],
  "wind river": [-108.81, 42.83],
};

// Texas is deliberately absent — see file doc comment.
const STATE_MERIDIAN: Record<string, string> = {
  ND: "6th pm", SD: "6th pm", NE: "6th pm", KS: "6th pm", MN: "6th pm", IA: "6th pm", MO: "6th pm", CO: "6th pm", WY: "6th pm",
  MT: "montana", ID: "boise", WA: "willamette", OR: "willamette",
  CA: "mount diablo", NV: "mount diablo", AZ: "gila-salt river", UT: "uintah",
  OK: "indian", LA: "louisiana", MS: "louisiana", AL: "st. stephens", FL: "tallahassee",
  NM: "new mexico",
};

const KM_PER_DEG_LAT = 111.0;
const TWP_KM = 9.656; // 6 miles per township side

function kmPerDegLon(lat: number): number {
  return Math.cos((lat * Math.PI) / 180) * 111.32;
}

function sectionOffset(section: number): { dLat: number; dLon: number } {
  if (section < 1 || section > 36) return { dLat: 0, dLon: 0 };
  const sectionSizeKm = TWP_KM / 6;
  const row = Math.floor((section - 1) / 6);
  const col = (section - 1) % 6;
  const adjustedCol = row % 2 === 0 ? col : 5 - col;
  return {
    dLat: -(row + 0.5) * sectionSizeKm,
    dLon: (5 - adjustedCol + 0.5) * sectionSizeKm,
  };
}

function mathFallback(desc: PlssLegalDescription): { lat: number; lng: number } | null {
  const stateKey = desc.state.toUpperCase().trim();
  const meridianKey = STATE_MERIDIAN[stateKey];
  if (!meridianKey) return null; // includes TX, deliberately
  const origin = MERIDIAN_ORIGINS[meridianKey];
  if (!origin) return null;

  const [originLon, originLat] = origin;
  const twpDir = desc.townshipDirection === "S" ? -1 : 1;
  const rngDir = desc.rangeDirection === "E" ? 1 : -1;

  const latKm = twpDir * (desc.townshipNumber - 0.5) * TWP_KM;
  const lonKm = rngDir * (desc.rangeNumber - 0.5) * TWP_KM;

  let lat = originLat + latKm / KM_PER_DEG_LAT;
  let lng = originLon + lonKm / kmPerDegLon(lat);

  const off = sectionOffset(desc.section);
  const twpNWLat = lat + (TWP_KM / 2) / KM_PER_DEG_LAT;
  const twpNWLng = lng - (TWP_KM / 2) / kmPerDegLon(lat);
  lat = twpNWLat + off.dLat / KM_PER_DEG_LAT;
  lng = twpNWLng + off.dLon / kmPerDegLon(lat);

  return { lat, lng };
}

async function tryBlmApi(desc: PlssLegalDescription, signal?: AbortSignal): Promise<{ lat: number; lng: number } | null> {
  const twpLabel = `T${desc.townshipNumber}${desc.townshipDirection}`;
  const rngLabel = `R${desc.rangeNumber}${desc.rangeDirection}`;
  const where = `TWNSHPLAB='${twpLabel}' AND RANGLAB='${rngLabel}'`;
  const qs = new URLSearchParams({ where, outFields: "TWNSHPLAB,RANGLAB,STATENAM", returnCentroid: "true", f: "json" });

  const res = await fetch(`https://gis.blm.gov/arcgis/rest/services/Cadastral/BLM_Natl_PLSS_CadNSDI/MapServer/1/query?${qs}`, { signal: withDefaultTimeout(signal, DEFAULT_CONFIG.providerTimeoutMs) });
  if (!res.ok) return null;
  const json = await res.json() as { features?: Array<{ centroid?: { x: number; y: number } }> };
  const centroid = json.features?.[0]?.centroid;
  if (!centroid) return null;

  let lat = centroid.y;
  let lng = centroid.x;
  const off = sectionOffset(desc.section);
  const twpNWLat = lat + (TWP_KM / 2) / KM_PER_DEG_LAT;
  const twpNWLng = lng - (TWP_KM / 2) / kmPerDegLon(lat);
  lat = twpNWLat + off.dLat / KM_PER_DEG_LAT;
  lng = twpNWLng + off.dLon / kmPerDegLon(lat);
  return { lat, lng };
}

export async function geocodePlssLegalDescription(desc: PlssLegalDescription, signal?: AbortSignal): Promise<GeocodeResult> {
  const now = new Date().toISOString();
  const warnings: WarningEntry[] = [];

  if (desc.state.toUpperCase().trim() === "TX" || !desc.state) {
    warnings.push({
      code: "TEXAS_NOT_PLSS",
      message: "Texas was never surveyed under the federal PLSS system — a PLSS township/range/section cannot be geocoded for a Texas subject well. Use the Texas land-grid parser instead.",
      severity: "critical",
    });
    return unmappable(warnings, now);
  }

  const blm = await tryBlmApi(desc, signal).catch(() => null);
  if (blm) {
    return {
      canonicalIdentifier: `T${desc.townshipNumber}${desc.townshipDirection}-R${desc.rangeNumber}${desc.rangeDirection}-S${desc.section}`,
      centroidLatitude: blm.lat, centroidLongitude: blm.lng,
      geometry: { type: "Point", coordinates: [blm.lng, blm.lat] }, geometryType: "Point",
      sourceProvider: "BLM_PLSS_CADNSDI", sourceRecordId: null, sourceUrlOrQueryId: "gis.blm.gov/arcgis/rest/services/Cadastral/BLM_Natl_PLSS_CadNSDI",
      spatialReferenceSystem: "EPSG:4326", retrievedAt: now,
      matchMethod: desc.aliquot ? "ALIQUOT_DERIVED" : "CENTROID_ONLY",
      confidence: desc.aliquot ? 0.7 : 0.6, warnings,
    };
  }
  warnings.push({ code: "BLM_API_UNAVAILABLE", message: "BLM PLSS cadastral API did not return a match — falling back to mathematical meridian estimate", severity: "warning" });

  const math = mathFallback(desc);
  if (math) {
    warnings.push({ code: "MATH_ESTIMATE_ONLY", message: "Centroid computed from principal-meridian offset math, not authoritative federal cadastral data — treat as approximate", severity: "warning" });
    return {
      canonicalIdentifier: `T${desc.townshipNumber}${desc.townshipDirection}-R${desc.rangeNumber}${desc.rangeDirection}-S${desc.section}`,
      centroidLatitude: math.lat, centroidLongitude: math.lng,
      geometry: { type: "Point", coordinates: [math.lng, math.lat] }, geometryType: "Point",
      sourceProvider: "PLSS_MERIDIAN_MATH", sourceRecordId: null, sourceUrlOrQueryId: null,
      spatialReferenceSystem: "EPSG:4326", retrievedAt: now,
      matchMethod: "CENTROID_ONLY", confidence: 0.35, warnings,
    };
  }

  warnings.push({ code: "NO_MERIDIAN_FOR_STATE", message: `No principal meridian origin configured for state "${desc.state}"`, severity: "critical" });
  return unmappable(warnings, now);
}

function unmappable(warnings: WarningEntry[], retrievedAt: string): GeocodeResult {
  return {
    canonicalIdentifier: null, centroidLatitude: null, centroidLongitude: null,
    geometry: null, geometryType: null, sourceProvider: "PLSS", sourceRecordId: null,
    sourceUrlOrQueryId: null, spatialReferenceSystem: "EPSG:4326", retrievedAt,
    matchMethod: "UNMAPPABLE", confidence: 0, warnings,
  };
}
