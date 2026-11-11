/**
 * TRRC's public GIS map service, as the well map uses it from the browser:
 * rendered tiles of its own well, lateral and survey layers, and point and
 * API lookups on the well layers. The service allows cross-origin requests
 * (checked live 2026-11-11), so none of this passes through our server.
 */
export const TRRC_GIS = "https://gis.rrc.texas.gov/server/rest/services/rrc_public/RRC_Public_Viewer_Srvs/MapServer";

/** Layers drawn over the base map: well numbers, wells, horizontal surface locations, laterals, survey abstract and survey labels, surveys, counties. */
export const OVERLAY_LAYERS = [0, 1, 9, 10, 22, 23, 24, 29];
/** Below this zoom TRRC's well layers are too dense to read; the map asks for a closer view. */
export const MIN_WELL_ZOOM = 12;

export interface GisWell {
  /** TRRC's 8-digit county + well number, as the GIS layer stores it. */
  api8: string;
  wellNumber: string | null;
  status: string | null;
  lat: number;
  lng: number;
  /** Metres from the clicked point, when found by a click. */
  distanceM?: number;
}

/**
 * Export URL for one image of the current view; bbox is [minX, minY, maxX, maxY]
 * in Web Mercator metres. One image per view, as TRRC's own viewer does: tiled
 * requests would label every county, survey and well once per tile.
 */
export function exportImageUrl(bbox: [number, number, number, number], widthPx: number, heightPx: number): string {
  const q = new URLSearchParams({
    bbox: bbox.join(","), bboxSR: "3857", imageSR: "3857", size: `${Math.round(widthPx)},${Math.round(heightPx)}`, dpi: "96",
    format: "png32", transparent: "true", layers: `show:${OVERLAY_LAYERS.join(",")}`, f: "image",
  });
  return `${TRRC_GIS}/export?${q}`;
}

/** Ground metres covered by one screen pixel at a latitude and zoom. */
export function metresPerPixel(lat: number, zoom: number): number {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);
}

/** "42-165-02084", "4216502084", "16502084", "42165020840000" → "16502084"; null when it is not a Texas API. */
export function api8From(input: string): string | null {
  const d = input.replace(/\D/g, "");
  if (d.length === 8) return d;
  if ((d.length === 10 || d.length === 12 || d.length === 14) && d.startsWith("42")) return d.slice(2, 10);
  return null;
}

export const formatApi = (api8: string) => `42-${api8.slice(0, 3)}-${api8.slice(3)}`;

function haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const r = (x: number) => (x * Math.PI) / 180, R = 6371000;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

type Feature = { attributes: Record<string, unknown> };
function toWells(features: Feature[]): GisWell[] {
  return features.flatMap(({ attributes: a }) => {
    const api8 = String(a["API"] ?? "").replace(/\D/g, "");
    const lat = Number(a["GIS_LAT83"]), lng = Number(a["GIS_LONG83"]);
    if (api8.length !== 8 || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90) return [];
    return [{ api8, wellNumber: (a["GIS_WELL_NUMBER"] as string) || null, status: (a["GIS_SYMBOL_DESCRIPTION"] as string) || null, lat, lng }];
  });
}

async function queryLayer(layer: number, params: Record<string, string>, signal?: AbortSignal): Promise<GisWell[]> {
  const q = new URLSearchParams({ outFields: layer === 1 ? "API,GIS_WELL_NUMBER,GIS_SYMBOL_DESCRIPTION,GIS_LAT83,GIS_LONG83" : "API,GIS_SYMBOL_DESCRIPTION,GIS_LAT83,GIS_LONG83", returnGeometry: "false", f: "json", ...params });
  const res = await fetch(`${TRRC_GIS}/${layer}/query?${q}`, { signal });
  if (!res.ok) throw Error(`TRRC GIS answered ${res.status}.`);
  const body = await res.json();
  if (body.error) throw Error(`TRRC GIS: ${body.error.message ?? "query failed"}.`);
  return toWells(body.features ?? []);
}

/** One entry per API; the well-location layer (with its well number) wins over the horizontal surface-location layer. */
function merge(primary: GisWell[], secondary: GisWell[]): GisWell[] {
  const byApi = new Map<string, GisWell>();
  for (const w of [...secondary, ...primary]) byApi.set(w.api8, { ...byApi.get(w.api8), ...w, wellNumber: w.wellNumber ?? byApi.get(w.api8)?.wellNumber ?? null });
  return [...byApi.values()];
}

/** Wells within `radiusM` of a point, nearest first. */
export async function wellsNear(lat: number, lng: number, radiusM: number, signal?: AbortSignal): Promise<GisWell[]> {
  const at = { geometry: `${lng},${lat}`, geometryType: "esriGeometryPoint", inSR: "4326", distance: String(Math.round(radiusM)), units: "esriSRUnit_Meter", spatialRel: "esriSpatialRelIntersects" };
  const [wells, surface] = await Promise.all([queryLayer(1, at, signal), queryLayer(9, at, signal).catch(() => [])]);
  return merge(wells, surface).map(w => ({ ...w, distanceM: haversineM({ lat, lng }, w) })).sort((a, b) => a.distanceM! - b.distanceM!);
}

/** A well by API; null when TRRC's GIS has no location for it. */
export async function wellByApi(api8: string, signal?: AbortSignal): Promise<GisWell | null> {
  if (!/^\d{8}$/.test(api8)) return null;
  const where = { where: `API='${api8}'` };
  const [wells, surface] = await Promise.all([queryLayer(1, where, signal), queryLayer(9, where, signal).catch(() => [])]);
  return merge(wells, surface)[0] ?? null;
}
