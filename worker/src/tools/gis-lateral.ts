/**
 * The sections a horizontal well's lateral runs through, from TRRC's public
 * GIS: the well's horizontal surface location (layer 9, by API), the
 * horizontal/directional line that starts there (layer 10, which carries no
 * API, so it is matched by its starting point), and the survey polygons
 * (layer 24) that line crosses, each with the share of the line inside it.
 *
 * A pooled unit's laterals lie within the unit, so a section holding a real
 * share of the lateral is part of the unit's title; a section the line only
 * touches along a boundary is not reported as crossed. TRRC draws the line
 * from surface location to terminus, so shares are an approximation of the
 * drilled path, and the result says so.
 */
import { fetchWithRetry } from "./ewa.js";

export const GIS_BASE = "https://gis.rrc.texas.gov/server/rest/services/rrc_public/RRC_Public_Viewer_Srvs/MapServer";
/** A section must hold at least this share of the lateral to count as crossed. */
export const MIN_LATERAL_SHARE = 0.05;
/** A line's end must sit this close to the surface location (degrees, about 2 m) to be this well's lateral. */
const START_TOLERANCE_DEG = 2e-5;
const SAMPLES_PER_SEGMENT = 400;

type Pt = [number, number];
export interface LateralSurvey { abstract_number: string; survey_name: string; block_number: string; section_name: string; share: number }
export interface LateralResult {
  found: boolean;
  surface: { latitude: number; longitude: number } | null;
  terminus: { latitude: number; longitude: number } | null;
  surveys: LateralSurvey[];
  query_url: string;
  message: string;
  error?: string;
}

/** Ray-casting point-in-polygon over every ring (holes toggle the result). */
export function pointInRings([x, y]: Pt, rings: Pt[][]): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** Evenly spaced points along a path, weighted by segment length, for measuring shares. */
export function samplePath(path: Pt[], perSegment = SAMPLES_PER_SEGMENT): { pts: Pt[]; weights: number[] } {
  const pts: Pt[] = [], weights: number[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const [x1, y1] = path[i], [x2, y2] = path[i + 1];
    const len = Math.hypot(x2 - x1, y2 - y1);
    for (let k = 0; k < perSegment; k++) {
      const t = (k + 0.5) / perSegment;
      pts.push([x1 + t * (x2 - x1), y1 + t * (y2 - y1)]);
      weights.push(len / perSegment);
    }
  }
  return { pts, weights };
}

/** Share of the path inside each polygon; polygons the path only grazes come out near zero. */
export function pathShares(path: Pt[], polygons: Pt[][][]): number[] {
  const { pts, weights } = samplePath(path);
  const total = weights.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return polygons.map(() => 0);
  return polygons.map(rings => pts.reduce((s, p, i) => s + (pointInRings(p, rings) ? weights[i] : 0), 0) / total);
}

/** The one line with an end at the surface location, oriented to start there; null when none or several. */
export function lateralFromSurface(surface: Pt, paths: Pt[][]): Pt[] | null {
  const d = (p: Pt) => Math.hypot(p[0] - surface[0], p[1] - surface[1]);
  const matches = paths.flatMap(p => p.length < 2 ? [] : d(p[0]) <= START_TOLERANCE_DEG ? [p] : d(p[p.length - 1]) <= START_TOLERANCE_DEG ? [[...p].reverse()] : []);
  return matches.length === 1 ? matches[0] : null;
}

async function query(layer: number, params: Record<string, string>): Promise<{ features: Array<{ attributes?: Record<string, unknown>; geometry?: { x?: number; y?: number; paths?: Pt[][]; rings?: Pt[][] } }> }> {
  const body = new URLSearchParams({ f: "json", ...params });
  const res = await fetchWithRetry(`${GIS_BASE}/${layer}/query`, { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(30_000) }, { label: `GIS layer ${layer}` });
  if (!res.ok) throw new Error(`GIS layer ${layer} HTTP ${res.status}`);
  const json = await res.json() as { error?: { message?: string }; features?: [] };
  if (json.error || !Array.isArray(json.features)) throw new Error(json.error?.message ?? `GIS layer ${layer}: features missing`);
  return json as never;
}

export async function getLateralSurveys(api10: string): Promise<LateralResult> {
  const api8 = api10.replace(/\D/g, "").slice(2, 10);
  const query_url = `${GIS_BASE}/9/query?f=json&where=API%3D%27${api8}%27&outFields=API&returnGeometry=true`;
  const none = (message: string, error?: string): LateralResult => ({ found: false, surface: null, terminus: null, surveys: [], query_url, message, ...(error ? { error } : {}) });
  try {
    const surface = (await query(9, { where: `API='${api8}'`, outFields: "API", returnGeometry: "true", outSR: "4326" })).features
      .filter(f => String(f.attributes?.API ?? "") === api8);
    if (!surface.length) return none("TRRC GIS carries no horizontal or directional surface location for this API.");
    if (surface.length > 1) return none("TRRC GIS carries more than one horizontal surface location for this API; no lateral selected.");
    const x = surface[0].geometry?.x, y = surface[0].geometry?.y;
    if (typeof x !== "number" || typeof y !== "number") return none("TRRC GIS surface location has no coordinates.");
    const e = 0.0005;
    const lines = await query(10, { geometry: `${x - e},${y - e},${x + e},${y + e}`, geometryType: "esriGeometryEnvelope", inSR: "4326", spatialRel: "esriSpatialRelIntersects", outFields: "OBJECTID", returnGeometry: "true", outSR: "4326" });
    const path = lateralFromSurface([x, y], lines.features.flatMap(f => f.geometry?.paths ?? []));
    if (!path) return { ...none("No single TRRC GIS lateral line starts at this well's surface location."), surface: { latitude: y, longitude: x } };
    const surveys = await query(24, {
      geometry: JSON.stringify({ paths: [path], spatialReference: { wkid: 4326 } }), geometryType: "esriGeometryPolyline", inSR: "4326", spatialRel: "esriSpatialRelIntersects",
      outFields: "ABSTRACT_NUMBER,LEVEL1_SURVEY_NAME,LEVEL2_BLOCK_NUMBER,LEVEL3_SURVEY_NUMBER", returnGeometry: "true", outSR: "4326",
    });
    const shares = pathShares(path, surveys.features.map(f => f.geometry?.rings ?? []));
    const crossed: LateralSurvey[] = surveys.features.map((f, i) => ({
      abstract_number: String(f.attributes?.ABSTRACT_NUMBER ?? "").trim(), survey_name: String(f.attributes?.LEVEL1_SURVEY_NAME ?? "").trim(),
      block_number: String(f.attributes?.LEVEL2_BLOCK_NUMBER ?? "").trim(), section_name: String(f.attributes?.LEVEL3_SURVEY_NUMBER ?? "").trim(), share: shares[i],
    })).filter(s => s.share >= MIN_LATERAL_SHARE).sort((a, b) => b.share - a.share);
    const end = path[path.length - 1];
    return {
      found: crossed.length > 0, surface: { latitude: y, longitude: x }, terminus: { latitude: end[1], longitude: end[0] }, surveys: crossed, query_url,
      message: crossed.length
        ? `Lateral crosses ${crossed.map(s => `Section ${s.section_name} Block ${s.block_number} (${Math.round(s.share * 100)}%)`).join(", ")}; TRRC draws it from surface location to terminus.`
        : "The lateral line crosses no survey for a material share of its length.",
    };
  } catch (err) {
    return none(`GIS lateral error: ${String(err)}`, String(err));
  }
}
