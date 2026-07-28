/**
 * Offset (nearby) well lookup — real structured data, not just dots on the
 * map image. Queries TRRC's public ArcGIS "Well Locations" layer (same
 * service maps-builder.ts uses) within a radius of the subject well,
 * confirmed live to work with a distance+units radius search returning
 * real API numbers, well status, and coordinates.
 *
 * This layer does not carry operator name — cross-referencing every
 * offset well against the wellbore/operator source would mean dozens of
 * extra TRRC queries per report, which isn't practical. Presented fields
 * are limited to what this one query actually returns: API, well number,
 * status/type, and computed distance/bearing from the subject well.
 */

const GIS_MAPSERVER_BASE = "https://gis.rrc.texas.gov/server/rest/services/rrc_public/RRC_Public_Viewer_Srvs/MapServer";

export type OffsetWell = {
  api: string;
  well_number: string;
  status: string;
  distance_miles: number;
  bearing: string;
  latitude: number;
  longitude: number;
};

const EARTH_RADIUS_MILES = 3958.8;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function haversineMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_MILES * 2 * Math.asin(Math.sqrt(a));
}

const COMPASS_POINTS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

function bearingCompass(lat1: number, lng1: number, lat2: number, lng2: number): string {
  const y = Math.sin(toRad(lng2 - lng1)) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lng2 - lng1));
  const deg = (Math.atan2(y, x) * 180) / Math.PI;
  const normalized = (deg + 360) % 360;
  return COMPASS_POINTS[Math.round(normalized / 22.5) % 16];
}

export async function fetchOffsetWells(
  subjectLat: number,
  subjectLng: number,
  subjectApi: string | null,
  radiusMiles = 1,
  maxResults = 20,
): Promise<OffsetWell[]> {
  try {
    const qs = new URLSearchParams({
      f: "json",
      geometry: `${subjectLng},${subjectLat}`,
      geometryType: "esriGeometryPoint",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      distance: String(radiusMiles),
      units: "esriSRUnit_StatuteMile",
      outFields: "API,GIS_WELL_NUMBER,GIS_SYMBOL_DESCRIPTION",
      returnGeometry: "true",
      outSR: "4326",
    });
    const res = await fetch(`${GIS_MAPSERVER_BASE}/1/query?${qs}`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return [];
    const json = await res.json() as {
      features?: Array<{ attributes?: Record<string, unknown>; geometry?: { x?: number; y?: number } }>;
    };
    if (!json.features) return [];

    const subjectApi8 = subjectApi ? subjectApi.replace(/\D/g, "").slice(-8) : null;

    const wells: OffsetWell[] = json.features
      .filter(f => f.geometry?.x != null && f.geometry?.y != null)
      .map(f => {
        const attrs = f.attributes ?? {};
        const lat = f.geometry!.y as number;
        const lng = f.geometry!.x as number;
        return {
          api: String(attrs["API"] ?? ""),
          well_number: String(attrs["GIS_WELL_NUMBER"] ?? ""),
          status: String(attrs["GIS_SYMBOL_DESCRIPTION"] ?? ""),
          distance_miles: haversineMiles(subjectLat, subjectLng, lat, lng),
          bearing: bearingCompass(subjectLat, subjectLng, lat, lng),
          latitude: lat,
          longitude: lng,
        };
      })
      .filter(w => !subjectApi8 || w.api !== subjectApi8)
      .sort((a, b) => a.distance_miles - b.distance_miles)
      .slice(0, maxResults);

    return wells;
  } catch {
    return [];
  }
}
