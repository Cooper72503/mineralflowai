/**
 * Static well-location map, rendered directly from TRRC's own public
 * ArcGIS MapServer /export operation — no third-party map provider, no
 * API key, no cost. Uses the same coordinates getGisLocation (S16)
 * already retrieves.
 *
 * The export endpoint is a plain image render, not a data query, so a
 * failure here (timeout, outage) should never break report generation —
 * callers get null back and fall back to the existing text-only GIS
 * fields, the same way every other optional enrichment in this pipeline
 * degrades.
 */

const GIS_MAPSERVER_BASE = "https://gis.rrc.texas.gov/server/rest/services/rrc_public/RRC_Public_Viewer_Srvs/MapServer";

export function buildStaticMapUrl(
  latitude: number,
  longitude: number,
  opts?: { deltaDeg?: number; width?: number; height?: number },
): string {
  const delta = opts?.deltaDeg ?? 0.015; // ~1.7km half-width at this latitude — tight enough to read individual well labels
  const width = opts?.width ?? 600;
  const height = opts?.height ?? 450;
  const xmin = longitude - delta;
  const xmax = longitude + delta;
  const ymin = latitude - delta;
  const ymax = latitude + delta;

  return `${GIS_MAPSERVER_BASE}/export?bbox=${xmin},${ymin},${xmax},${ymax}&bboxSR=4326&size=${width},${height}&format=png&layers=show:1&f=image`;
}

export async function fetchStaticMapImage(
  latitude: number,
  longitude: number,
  opts?: { deltaDeg?: number; width?: number; height?: number },
): Promise<Buffer | null> {
  try {
    const res = await fetch(buildStaticMapUrl(latitude, longitude, opts), {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/")) return null; // ArcGIS returns a JSON error body on failure, not a broken image
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}
