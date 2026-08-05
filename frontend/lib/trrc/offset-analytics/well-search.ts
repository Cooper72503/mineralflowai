/**
 * True-radius offset well search. Reuses TRRC's own public ArcGIS "Well
 * Locations" layer (the same one offset-wells.ts and worker/src/tools/
 * ewa.ts's getGisLocation already use) and its `esriSpatialRelIntersects`
 * + `distance` + `units` query parameters — this is ArcGIS's own
 * server-side GEODESIC buffer query against its spatial index, not a
 * client-constructed bounding box. That's already the right building
 * block (Phase 0 found it, confirmed live to work in offset-wells.ts) —
 * this module adds what that simpler lookup doesn't need: a
 * TRACT_BOUNDARY_TO_WELL mode using the real polygon (geometry.ts's exact
 * distanceToPolygonBoundaryMiles), and a WellSearchProvider interface so a
 * future PostGIS-backed provider can swap in without touching callers
 * (see index.ts's architecture notes on why PostGIS isn't available today).
 *
 * The ArcGIS server-side query is centered on the tract CENTROID with an
 * enlarged radius (requested radius + the tract's own centroid-to-corner
 * extent) so a well near the FAR edge of a large tract isn't missed by a
 * circular query centered on the middle — then the exact per-well distance
 * (haversine to centroid, or true boundary distance) is recomputed
 * client-side and used as the actual, precise cutoff. The enlarged
 * server-side radius is the "indexed pre-filter"; the recomputed exact
 * distance is the real filter, matching the spec's own distinction.
 */

import type { GeoJsonGeometry, WarningEntry } from "./types";
import { haversineDistanceMiles, distanceToPolygonBoundaryMiles } from "./geometry";

const GIS_MAPSERVER_BASE = "https://gis.rrc.texas.gov/server/rest/services/rrc_public/RRC_Public_Viewer_Srvs/MapServer";

export type DistanceMode = "CENTROID_TO_WELL" | "TRACT_BOUNDARY_TO_WELL";

export const ALLOWED_RADII_MILES = [2, 5, 10] as const;
export const MAX_RADIUS_MILES = 25;

export interface OffsetWellCandidate {
  api: string;
  wellNumber: string;
  gisStatusSymbol: string;
  latitude: number;
  longitude: number;
  distanceMiles: number;
  distanceMode: DistanceMode;
}

export interface WellSearchResult {
  candidates: OffsetWellCandidate[];
  distanceMode: DistanceMode;
  radiusMiles: number;
  warnings: WarningEntry[];
  sourceUrlOrQueryId: string;
}

export interface WellSearchProvider {
  search(center: { lat: number; lng: number }, tractGeometry: GeoJsonGeometry | null, radiusMiles: number, requestedMode: DistanceMode): Promise<WellSearchResult>;
}

/** Rough centroid-to-corner extent of a polygon's bounding box, in miles — used only to size the server-side pre-filter radius, never as the actual distance cutoff. */
function boundingExtentMiles(center: { lat: number; lng: number }, geometry: GeoJsonGeometry): number {
  const rings: number[][] = geometry.type === "Polygon"
    ? (geometry.coordinates as number[][][])[0]
    : geometry.type === "MultiPolygon"
      ? (geometry.coordinates as number[][][][]).flatMap(p => p[0])
      : [];
  if (rings.length === 0) return 0;
  let maxMiles = 0;
  for (const [lng, lat] of rings) {
    maxMiles = Math.max(maxMiles, haversineDistanceMiles(center.lat, center.lng, lat, lng));
  }
  return maxMiles;
}

export class ArcGisWellSearchProvider implements WellSearchProvider {
  async search(center: { lat: number; lng: number }, tractGeometry: GeoJsonGeometry | null, radiusMiles: number, requestedMode: DistanceMode): Promise<WellSearchResult> {
    const warnings: WarningEntry[] = [];
    const clampedRadius = Math.min(radiusMiles, MAX_RADIUS_MILES);
    if (radiusMiles > MAX_RADIUS_MILES) {
      warnings.push({ code: "RADIUS_CLAMPED", message: `Requested radius ${radiusMiles}mi exceeds the configured maximum (${MAX_RADIUS_MILES}mi) — clamped`, severity: "warning" });
    }

    let effectiveMode = requestedMode;
    if (requestedMode === "TRACT_BOUNDARY_TO_WELL" && (!tractGeometry || tractGeometry.type === "Point")) {
      effectiveMode = "CENTROID_TO_WELL";
      warnings.push({ code: "NO_POLYGON_FOR_BOUNDARY_MODE", message: "TRACT_BOUNDARY_TO_WELL was requested but no real tract polygon is available (centroid-only geocode) — falling back to CENTROID_TO_WELL. Distances are approximate.", severity: "warning" });
    }

    const preFilterExtra = tractGeometry ? boundingExtentMiles(center, tractGeometry) : 0;
    const serverQueryRadius = clampedRadius + preFilterExtra;

    const qs = new URLSearchParams({
      f: "json",
      geometry: `${center.lng},${center.lat}`,
      geometryType: "esriGeometryPoint",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      distance: String(serverQueryRadius),
      units: "esriSRUnit_StatuteMile",
      outFields: "API,GIS_WELL_NUMBER,GIS_SYMBOL_DESCRIPTION",
      returnGeometry: "true",
      outSR: "4326",
      resultRecordCount: "500",
    });
    const url = `${GIS_MAPSERVER_BASE}/1/query?${qs}`;

    let features: Array<{ attributes?: Record<string, unknown>; geometry?: { x?: number; y?: number } }> = [];
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (res.ok) {
        const json = await res.json() as { features?: typeof features };
        features = json.features ?? [];
      } else {
        warnings.push({ code: "WELL_SEARCH_HTTP_ERROR", message: `TRRC GIS well layer returned HTTP ${res.status}`, severity: "critical" });
      }
    } catch (e) {
      warnings.push({ code: "WELL_SEARCH_FETCH_FAILED", message: `TRRC GIS well layer request failed: ${String(e).slice(0, 150)}`, severity: "critical" });
    }

    const candidates: OffsetWellCandidate[] = [];
    for (const f of features) {
      if (f.geometry?.x == null || f.geometry?.y == null) continue;
      const lat = f.geometry.y, lng = f.geometry.x;
      const exactDistance = effectiveMode === "TRACT_BOUNDARY_TO_WELL" && tractGeometry
        ? distanceToPolygonBoundaryMiles({ lat, lng }, tractGeometry)
        : haversineDistanceMiles(center.lat, center.lng, lat, lng);
      if (exactDistance === null || exactDistance > clampedRadius) continue; // the real, exact cutoff — the server-side query above was only a pre-filter

      const attrs = f.attributes ?? {};
      candidates.push({
        api: String(attrs["API"] ?? ""),
        wellNumber: String(attrs["GIS_WELL_NUMBER"] ?? ""),
        gisStatusSymbol: String(attrs["GIS_SYMBOL_DESCRIPTION"] ?? ""),
        latitude: lat, longitude: lng,
        distanceMiles: exactDistance,
        distanceMode: effectiveMode,
      });
    }
    candidates.sort((a, b) => a.distanceMiles - b.distanceMiles);

    return { candidates, distanceMode: effectiveMode, radiusMiles: clampedRadius, warnings, sourceUrlOrQueryId: url };
  }
}
