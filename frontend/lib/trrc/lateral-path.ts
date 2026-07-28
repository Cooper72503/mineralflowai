/**
 * Horizontal wellbore lateral path — surface location to drainhole
 * (bottom-hole) location, both queried from TRRC's public ArcGIS server
 * by exact API match, so both endpoints are solidly attributed to the
 * subject well rather than guessed from proximity.
 *
 * TRRC's "Horizontal/Directional Lines" layer (10, polyline geometry) has
 * no API field at all — only a quad-sheet reference — so there is no way
 * to reliably determine which line segment belongs to which well from
 * that layer. A spatial "nearest line" guess would risk mislabeling a
 * neighboring well's path as this one's, so this deliberately does not
 * use that layer. The "Horiz/Dir Surface Locations" layer (9) does carry
 * API, and for a horizontal well it holds the drainhole point — paired
 * with the surface location from the Well Locations layer (1), that's
 * enough to draw a real, correctly-attributed straight-line lateral, even
 * though it isn't the full curved directional survey.
 *
 * A vertical well simply has no row in layer 9 — confirmed live against
 * TRRC's real data — so `found: false` here is a legitimate "not
 * horizontal" result, not a retrieval failure.
 */

const EARTH_RADIUS_FEET = 20_902_231; // 3958.8 mi * 5280 ft/mi

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function haversineFeet(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_FEET * 2 * Math.asin(Math.sqrt(a));
}

const COMPASS_POINTS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

function bearingCompass(lat1: number, lng1: number, lat2: number, lng2: number): string {
  const y = Math.sin(toRad(lng2 - lng1)) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lng2 - lng1));
  const deg = (Math.atan2(y, x) * 180) / Math.PI;
  return COMPASS_POINTS[Math.round(((deg + 360) % 360) / 22.5) % 16];
}

const GIS_MAPSERVER_BASE = "https://gis.rrc.texas.gov/server/rest/services/rrc_public/RRC_Public_Viewer_Srvs/MapServer";

export type LateralPath = {
  surface_latitude: number;
  surface_longitude: number;
  drainhole_latitude: number;
  drainhole_longitude: number;
  straight_line_length_ft: number;
  bearing: string;
};

export async function fetchLateralPath(
  apiNumber: string,
  surfaceLat: number,
  surfaceLng: number,
): Promise<LateralPath | null> {
  try {
    const api8 = apiNumber.replace(/\D/g, "").slice(-8);
    const qs = new URLSearchParams({
      f: "json",
      where: `API='${api8}'`,
      outFields: "API",
      returnGeometry: "true",
      outSR: "4326",
    });
    const res = await fetch(`${GIS_MAPSERVER_BASE}/9/query?${qs}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const json = await res.json() as { features?: Array<{ geometry?: { x?: number; y?: number } }> };
    const geom = json.features?.[0]?.geometry;
    if (!geom || geom.x == null || geom.y == null) return null; // no row in this layer = not a horizontal well, not a failure

    const drainholeLat = geom.y;
    const drainholeLng = geom.x;

    return {
      surface_latitude: surfaceLat,
      surface_longitude: surfaceLng,
      drainhole_latitude: drainholeLat,
      drainhole_longitude: drainholeLng,
      straight_line_length_ft: haversineFeet(surfaceLat, surfaceLng, drainholeLat, drainholeLng),
      bearing: bearingCompass(surfaceLat, surfaceLng, drainholeLat, drainholeLng),
    };
  } catch {
    return null;
  }
}
