/**
 * Geometry validation, centroid computation, and geodesic distance — all
 * pure math, no HTTP (non-negotiable principle #10). WGS84 (EPSG:4326) is
 * assumed on input, since every provider in providers/ requests output in
 * that CRS explicitly (see texas-land-grid.ts's outSR=4326 — the OTLS
 * service's native CRS is a projected, meters-based wkid 102039, and
 * treating those raw coordinates as lat/lng, which a prior implementation
 * did, silently produces wrong geometry; confirmed and fixed in Phase 3).
 *
 * Centroid is a proper area-weighted (shoelace-based) polygon centroid,
 * not a naive average of vertices — a prior implementation
 * (archive/frontend/lib/wells/trrc-abstract-lookup.ts's polygonCentroid)
 * did the latter, which is measurably wrong for any non-regular polygon
 * (the vertex average is pulled toward whichever edge has the most
 * vertices, not toward where the polygon's mass actually is).
 */

import type { GeoJsonGeometry, WarningEntry } from "./types";

export interface GeometryValidationResult {
  valid: boolean;
  errors: string[];
  warnings: WarningEntry[];
  centroid: { lat: number; lng: number } | null;
  areaSqMeters: number | null; // planar equirectangular-projected approximation — fine for a nonzero-area check and rough acreage, not survey-grade
}

// ─── Coordinate / structural validation ─────────────────────────────────────

function isValidLngLat(pair: unknown): pair is [number, number] {
  return (
    Array.isArray(pair) &&
    pair.length >= 2 &&
    typeof pair[0] === "number" && typeof pair[1] === "number" &&
    pair[0] >= -180 && pair[0] <= 180 &&
    pair[1] >= -90 && pair[1] <= 90 &&
    Number.isFinite(pair[0]) && Number.isFinite(pair[1])
  );
}

function ringIsClosed(ring: number[][]): boolean {
  if (ring.length < 4) return false; // a closed polygon ring needs at least 3 distinct points + the repeated closing point
  const [firstLng, firstLat] = ring[0];
  const [lastLng, lastLat] = ring[ring.length - 1];
  return firstLng === lastLng && firstLat === lastLat;
}

// ─── Area (planar, equirectangular-projected — shoelace formula) ───────────

const EARTH_RADIUS_M = 6371000;

/** Projects lng/lat to a local planar approximation (meters) centered on the ring, for shoelace area/centroid math. Adequate for tract-sized polygons; not for anything continental. */
function projectRingToMeters(ring: number[][]): { x: number; y: number }[] {
  const avgLat = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  const cosLat = Math.cos((avgLat * Math.PI) / 180);
  return ring.map(([lng, lat]) => ({
    x: (lng * Math.PI / 180) * EARTH_RADIUS_M * cosLat,
    y: (lat * Math.PI / 180) * EARTH_RADIUS_M,
  }));
}

/** Shoelace formula — signed area (meters²); sign indicates ring winding direction. */
function shoelaceArea(points: { x: number; y: number }[]): number {
  let sum = 0;
  for (let i = 0; i < points.length - 1; i++) {
    sum += points[i].x * points[i + 1].y - points[i + 1].x * points[i].y;
  }
  return sum / 2;
}

/** Area-weighted centroid of a single ring (shoelace centroid formula), in projected meters, then converted back to lng/lat. */
function ringCentroid(ring: number[][]): { lat: number; lng: number; areaSqM: number } | null {
  if (ring.length < 4) return null;
  const avgLat = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  const avgLng = ring.reduce((s, p) => s + p[0], 0) / ring.length;
  const cosLat = Math.cos((avgLat * Math.PI) / 180);
  const projected = projectRingToMeters(ring);

  const signedArea = shoelaceArea(projected);
  if (Math.abs(signedArea) < 1e-6) return null; // degenerate/zero-area ring

  let cx = 0, cy = 0;
  for (let i = 0; i < projected.length - 1; i++) {
    const cross = projected[i].x * projected[i + 1].y - projected[i + 1].x * projected[i].y;
    cx += (projected[i].x + projected[i + 1].x) * cross;
    cy += (projected[i].y + projected[i + 1].y) * cross;
  }
  cx /= 6 * signedArea;
  cy /= 6 * signedArea;

  // Un-project back to lng/lat, relative to the same local approximation used to project.
  const lat = cy / EARTH_RADIUS_M * (180 / Math.PI);
  const lng = cx / (EARTH_RADIUS_M * cosLat) * (180 / Math.PI);
  return { lat, lng, areaSqM: Math.abs(signedArea) };
}

/** Ray-casting point-in-polygon test (standard, exact for the outer ring — does not account for holes, which this engine's sources never produce). */
export function pointInRing(point: { lat: number; lng: number }, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects = (yi > point.lat) !== (yj > point.lat) &&
      point.lng < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

// ─── Self-intersection detection ────────────────────────────────────────────
//
// Detection only — this engine deliberately does NOT attempt automatic
// self-intersection repair. "Repair only when safe" (the spec's own
// phrasing) is a genuinely hard problem to get right (which loop gets cut,
// which vertex gets kept) and a wrong repair silently produces a
// plausible-looking but INCORRECT polygon — worse than surfacing the
// problem honestly. A self-intersecting source polygon is flagged as a
// warning; centroid/area are still computed from the raw ring (the
// shoelace formula doesn't require simplicity to run), but the caller
// should treat that result as approximate.

function orientation(a: number[], b: number[], c: number[]): number {
  const val = (b[1] - a[1]) * (c[0] - b[0]) - (b[0] - a[0]) * (c[1] - b[1]);
  if (Math.abs(val) < 1e-12) return 0;
  return val > 0 ? 1 : 2;
}

function onSegment(a: number[], b: number[], c: number[]): boolean {
  return Math.min(a[0], c[0]) <= b[0] && b[0] <= Math.max(a[0], c[0]) &&
    Math.min(a[1], c[1]) <= b[1] && b[1] <= Math.max(a[1], c[1]);
}

/** Standard segment-intersection test (orientation + on-segment special cases). */
function segmentsIntersect(p1: number[], q1: number[], p2: number[], q2: number[]): boolean {
  const o1 = orientation(p1, q1, p2);
  const o2 = orientation(p1, q1, q2);
  const o3 = orientation(p2, q2, p1);
  const o4 = orientation(p2, q2, q1);

  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(p1, p2, q1)) return true;
  if (o2 === 0 && onSegment(p1, q2, q1)) return true;
  if (o3 === 0 && onSegment(p2, p1, q2)) return true;
  if (o4 === 0 && onSegment(p2, q1, q2)) return true;
  return false;
}

/** Checks every pair of NON-ADJACENT edges in a ring for intersection — adjacent edges always share an endpoint, which isn't a self-intersection. O(n²), fine for tract-sized polygons (tens of vertices, not thousands). */
export function ringHasSelfIntersection(ring: number[][]): boolean {
  const n = ring.length - 1; // last point repeats the first (closed ring) — treat as n edges
  if (n < 4) return false;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const adjacent = j === i + 1 || (i === 0 && j === n - 1);
      if (adjacent) continue;
      if (segmentsIntersect(ring[i], ring[i + 1], ring[j], ring[j + 1])) return true;
    }
  }
  return false;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function validateGeometry(geometry: GeoJsonGeometry | null): GeometryValidationResult {
  const errors: string[] = [];
  const warnings: WarningEntry[] = [];

  if (!geometry) {
    return { valid: false, errors: ["No geometry provided"], warnings, centroid: null, areaSqMeters: null };
  }

  if (geometry.type === "Point") {
    const pt = geometry.coordinates as number[];
    if (!isValidLngLat(pt)) {
      errors.push("Point coordinates out of valid lng/lat range");
      return { valid: false, errors, warnings, centroid: null, areaSqMeters: null };
    }
    warnings.push({ code: "CENTROID_ONLY_GEOMETRY", message: "Geometry is a single point, not a tract polygon — treat any distance calculated against it as approximate", severity: "warning" });
    return { valid: true, errors, warnings, centroid: { lat: pt[1], lng: pt[0] }, areaSqMeters: null };
  }

  if (geometry.type === "Polygon") {
    const rings = geometry.coordinates as number[][][];
    if (!Array.isArray(rings) || rings.length === 0) {
      errors.push("Polygon has no rings");
      return { valid: false, errors, warnings, centroid: null, areaSqMeters: null };
    }
    const outer = rings[0];
    if (!outer.every(isValidLngLat)) {
      errors.push("Polygon contains coordinates out of valid lng/lat range");
      return { valid: false, errors, warnings, centroid: null, areaSqMeters: null };
    }
    if (!ringIsClosed(outer)) {
      errors.push("Polygon's outer ring is not closed (first point does not equal last point)");
      return { valid: false, errors, warnings, centroid: null, areaSqMeters: null };
    }
    if (rings.length > 1) {
      warnings.push({ code: "POLYGON_HAS_HOLES", message: "Polygon has interior rings (holes) — this engine's centroid/point-in-polygon math treats only the outer ring, matching every real source it consumes (none produce donut-shaped tracts)", severity: "info" });
    }
    if (ringHasSelfIntersection(outer)) {
      warnings.push({ code: "SELF_INTERSECTING_POLYGON", message: "The outer ring is self-intersecting — centroid and area below are computed from the raw ring anyway (the math doesn't require a simple polygon to run) but should be treated as approximate; this engine does not attempt automatic repair", severity: "warning" });
    }
    const centroidResult = ringCentroid(outer);
    if (!centroidResult) {
      errors.push("Polygon has zero or near-zero area");
      return { valid: false, errors, warnings, centroid: null, areaSqMeters: null };
    }
    return {
      valid: true, errors, warnings,
      centroid: { lat: centroidResult.lat, lng: centroidResult.lng },
      areaSqMeters: centroidResult.areaSqM,
    };
  }

  if (geometry.type === "MultiPolygon") {
    warnings.push({ code: "MULTIPOLYGON_GEOMETRY", message: "Geometry is a MultiPolygon (multiple disjoint parts) — centroid is area-weighted across all parts, which may fall outside any single part", severity: "warning" });
    const polygons = geometry.coordinates as number[][][][];
    const centroids: { lat: number; lng: number; areaSqM: number }[] = [];
    let anySelfIntersecting = false;
    for (const poly of polygons) {
      const outer = poly[0];
      if (!outer || !outer.every(isValidLngLat) || !ringIsClosed(outer)) continue;
      if (ringHasSelfIntersection(outer)) anySelfIntersecting = true;
      const c = ringCentroid(outer);
      if (c) centroids.push(c);
    }
    if (anySelfIntersecting) {
      warnings.push({ code: "SELF_INTERSECTING_POLYGON", message: "At least one part of this MultiPolygon is self-intersecting — treat centroid/area as approximate; no automatic repair is attempted", severity: "warning" });
    }
    if (centroids.length === 0) {
      errors.push("MultiPolygon has no valid, non-degenerate parts");
      return { valid: false, errors, warnings, centroid: null, areaSqMeters: null };
    }
    const totalArea = centroids.reduce((s, c) => s + c.areaSqM, 0);
    const lat = centroids.reduce((s, c) => s + c.lat * c.areaSqM, 0) / totalArea;
    const lng = centroids.reduce((s, c) => s + c.lng * c.areaSqM, 0) / totalArea;
    return { valid: true, errors, warnings, centroid: { lat, lng }, areaSqMeters: totalArea };
  }

  errors.push(`Unsupported geometry type: ${(geometry as { type: string }).type}`);
  return { valid: false, errors, warnings, centroid: null, areaSqMeters: null };
}

/** True geodesic (great-circle) distance in miles — haversine formula, not planar lat/lng subtraction. */
export function haversineDistanceMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R_MILES = 3958.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R_MILES * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Distance from a point to the nearest edge of a polygon's outer ring, in miles — used for TRACT_BOUNDARY_TO_WELL mode. Returns 0 when the point is inside the polygon. */
export function distanceToPolygonBoundaryMiles(point: { lat: number; lng: number }, geometry: GeoJsonGeometry): number | null {
  if (geometry.type !== "Polygon") return null;
  const outer = (geometry.coordinates as number[][][])[0];
  if (!outer || outer.length < 4) return null;

  if (pointInRing(point, outer)) return 0;

  let minMiles = Infinity;
  for (let i = 0; i < outer.length - 1; i++) {
    const [lng1, lat1] = outer[i];
    const [lng2, lat2] = outer[i + 1];
    minMiles = Math.min(minMiles, distanceToSegmentMiles(point, { lat: lat1, lng: lng1 }, { lat: lat2, lng: lng2 }));
  }
  return minMiles;
}

/** Approximate point-to-segment distance by sampling the segment — adequate for tract-scale (sub-township) polygons where segment curvature over the segment length is negligible. */
function distanceToSegmentMiles(point: { lat: number; lng: number }, a: { lat: number; lng: number }, b: { lat: number; lng: number }, samples = 20): number {
  let min = Infinity;
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const lat = a.lat + (b.lat - a.lat) * t;
    const lng = a.lng + (b.lng - a.lng) * t;
    min = Math.min(min, haversineDistanceMiles(point.lat, point.lng, lat, lng));
  }
  return min;
}
