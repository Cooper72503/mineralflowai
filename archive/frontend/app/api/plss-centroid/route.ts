/**
 * PLSS Centroid resolver.
 *
 * Accepts township, range, section (optional), and state (optional).
 * Returns an approximate lat/lng centroid for the township or section.
 *
 * Strategy:
 * 1. Try BLM PLSS ArcGIS REST API (authoritative, returns actual boundary centroid)
 * 2. Fall back to manual meridian math if BLM API is unavailable
 */

import { NextRequest, NextResponse } from "next/server";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ── Principal meridian origins (lon, lat) ────────────────────────────────────
// Used as fallback when BLM API is unavailable.
const MERIDIAN_ORIGINS: Record<string, [number, number]> = {
  "6th pm":          [-97.37, 40.00],  // ND, SD, NE, KS, MN, IA
  "black hills":     [-104.06, 44.00], // SD (western)
  "boise":           [-116.39, 43.37], // ID
  "choctaw":         [-94.62, 34.62],  // OK (eastern)
  "cimarron":        [-103.00, 36.50], // OK (panhandle)
  "copper river":    [-145.33, 61.37], // AK
  "fairbanks":       [-147.64, 64.86], // AK
  "gila-salt river": [-112.35, 33.37], // AZ
  "humboldt":        [-124.15, 40.44], // CA (northern)
  "indian":          [-97.45, 34.98],  // OK
  "louisiana":       [-92.41, 31.00],  // LA, MS
  "michigan":        [-84.37, 42.42],  // MI, OH, IN
  "montana":         [-111.64, 45.79], // MT
  "mount diablo":    [-121.91, 37.88], // CA, NV
  "navajo":          [-108.53, 36.77], // AZ (northeastern)
  "new mexico":      [-106.89, 34.16], // NM, CO (southern)
  "ohio":            [-81.69, 40.99],  // OH
  "seward":          [-149.36, 60.12], // AK
  "st. helena":      [-91.13, 30.99],  // LA (southern)
  "st. stephens":    [-88.02, 30.99],  // AL, MS
  "tallahassee":     [-84.27, 30.44],  // FL
  "uintah":          [-109.93, 40.43], // UT (northeastern)
  "ute":             [-108.53, 39.37], // CO (western)
  "washington":      [-90.90, 30.30],  // MS (southern)
  "willamette":      [-122.74, 45.52], // WA, OR
  "wind river":      [-108.81, 42.83], // WY
};

// State → most likely meridian
const STATE_MERIDIAN: Record<string, string> = {
  ND: "6th pm", SD: "6th pm", NE: "6th pm", KS: "6th pm",
  MN: "6th pm", IA: "6th pm", MO: "6th pm",
  MT: "montana",
  ID: "boise",
  WA: "willamette", OR: "willamette",
  CA: "mount diablo", NV: "mount diablo",
  AZ: "gila-salt river",
  UT: "uintah",
  CO: "6th pm",     // most CO PLSS uses 6th PM
  WY: "6th pm",
  OK: "indian",
  TX: "texas abstract", // Texas uses Abstract system, not PLSS — approximate only
  LA: "louisiana",
  MS: "louisiana",
  AL: "st. stephens",
  FL: "tallahassee",
  OH: "michigan", IN: "michigan", MI: "michigan",
};

// km per degree (approximate)
const KM_PER_DEG_LAT = 111.0;

function kmPerDegLon(lat: number): number {
  return Math.cos((lat * Math.PI) / 180) * 111.32;
}

// Township is ~9.7 km N-S (6 miles), Range is ~9.7 km E-W
const TWP_KM = 9.656; // 6 miles

/** Parse "140N" → { n: 140, dir: "N" } etc. */
function parseTownshipOrRange(raw: string): { n: number; dir: string } | null {
  const m = raw.trim().match(/^T?(\d+)\s*([NSEW])$/i) ??
            raw.trim().match(/^(\d+)\s*([NSEW])$/i);
  if (!m) {
    // Try bare number — default N for township, W for range
    const bare = raw.trim().match(/^T?(\d+)$/);
    if (bare) return { n: parseInt(bare[1]), dir: "?" };
    return null;
  }
  return { n: parseInt(m[1]), dir: m[2].toUpperCase() };
}

/** Section centroid offset within township.
 * Sections are numbered 1–36 boustrophedon:
 * Row 1 (N):  1  2  3  4  5  6   (west to east goes right→left = E←W)
 *             Actually: row 1 top-right: 1=NE, 6=NW; row 2: 7=NW...
 * Standard PLSS: section 1 = NE corner, numbers go west across top row,
 * then snake south: row 1: 1–6 E→W, row 2: 7–12 W→E, row 3: 13–18 E→W, etc.
 */
function sectionOffset(section: number): { dLat: number; dLon: number } {
  if (section < 1 || section > 36) return { dLat: 0, dLon: 0 };
  const sectionSizeKm = TWP_KM / 6; // ~1.6 km per section side
  const row = Math.floor((section - 1) / 6); // 0 = top (north)
  const col = (section - 1) % 6;             // 0–5
  // Row 0 goes E→W (col 0 = E = right), odd rows W→E
  const adjustedCol = row % 2 === 0 ? col : 5 - col;
  // Section centroid: center of the cell
  // lat offset from NW corner of township: row goes south (negative lat)
  const latOffsetKm = -(row + 0.5) * sectionSizeKm;
  // lon offset from NW corner (west is more negative): adjustedCol 0=East=less negative offset
  const lonOffsetKm = (5 - adjustedCol + 0.5) * sectionSizeKm; // positive = east
  return { dLat: latOffsetKm, dLon: lonOffsetKm };
}

function mathFallback(
  twp: string,
  rng: string,
  section: string | null,
  state: string | null
): { lat: number; lng: number } | null {
  const t = parseTownshipOrRange(twp);
  const r = parseTownshipOrRange(rng);
  if (!t || !r) return null;

  const stateKey = state?.toUpperCase().trim() ?? "";
  const meridianKey = STATE_MERIDIAN[stateKey] ?? "6th pm";
  const origin = MERIDIAN_ORIGINS[meridianKey];
  if (!origin) return null;

  const [originLon, originLat] = origin;

  // Township north (+) or south (-) of baseline
  const twpDir = t.dir === "S" ? -1 : 1;
  // Range west (-) or east (+) of meridian
  const rngDir = r.dir === "E" ? 1 : -1;

  const latKm = twpDir * (t.n - 0.5) * TWP_KM;
  const lonKm = rngDir * (r.n - 0.5) * TWP_KM;

  let lat = originLat + latKm / KM_PER_DEG_LAT;
  let lng = originLon + lonKm / kmPerDegLon(lat);

  // Apply section offset
  if (section) {
    const sec = parseInt(section);
    if (!isNaN(sec)) {
      const off = sectionOffset(sec);
      // Township NW corner = township centroid + half township north + half township west
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
  state: string | null
): Promise<{ lat: number; lng: number; label: string } | null> {
  // Normalise: "140N" → "T140N", "94W" → "R94W"
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

  const url = `https://gis.blm.gov/arcgis/rest/services/Cadastral/BLM_Natl_PLSS_CadNSDI/MapServer/1/query?${params}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);

  const res = await fetch(url, { signal: controller.signal });
  clearTimeout(timer);

  if (!res.ok) return null;
  const json = await res.json() as {
    features?: Array<{ centroid?: { x: number; y: number } }>;
  };

  const feature = json.features?.[0];
  const centroid = feature?.centroid;
  if (!centroid) return null;

  let lat = centroid.y;
  let lng = centroid.x;

  // Apply section offset on top of township centroid
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

  const label = [twpLabel, rngLabel, section ? `Sec ${section}` : null, state]
    .filter(Boolean).join(", ");
  return { lat, lng, label };
}

export async function GET(request: NextRequest) {
  const supabase = await createSupabaseFromRouteRequest(request);
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const township = searchParams.get("township");
  const range    = searchParams.get("range");
  const section  = searchParams.get("section");
  const state    = searchParams.get("state");

  if (!township || !range) {
    return NextResponse.json({ error: "township and range are required." }, { status: 400 });
  }

  try {
    // Try BLM API first
    const blm = await tryBlmApi(township, range, section, state).catch(() => null);
    if (blm) {
      return NextResponse.json({ ...blm, source: "blm" });
    }
  } catch {
    // fall through to math fallback
  }

  // Math fallback
  const math = mathFallback(township, range, section, state);
  if (!math) {
    return NextResponse.json({ error: "Could not resolve PLSS coordinates." }, { status: 422 });
  }

  const label = [township, range, section ? `Sec ${section}` : null, state]
    .filter(Boolean).join(", ");

  return NextResponse.json({ ...math, label, source: "estimated" });
}
