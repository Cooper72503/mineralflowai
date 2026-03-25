/**
 * MVP county-level Permian Basin geology hints. Not tract-level analysis.
 */

export type PermianCountyEntry = {
  primaryFormation: string;
  formations: string[];
  depthMin: number;
  depthMax: number;
};

/** Keys are normalized with {@link normalizeCountyKey} (lowercase, no "County" suffix). */
export const PERMIAN_COUNTY_MAP: Record<string, PermianCountyEntry> = {
  midland: {
    primaryFormation: "Wolfcamp",
    formations: ["Wolfcamp", "Spraberry"],
    depthMin: 8000,
    depthMax: 11000,
  },
  martin: {
    primaryFormation: "Spraberry",
    formations: ["Spraberry", "Wolfcamp"],
    depthMin: 7000,
    depthMax: 9500,
  },
  reeves: {
    primaryFormation: "Bone Spring",
    formations: ["Bone Spring", "Wolfcamp"],
    depthMin: 7000,
    depthMax: 11000,
  },
  loving: {
    primaryFormation: "Bone Spring",
    formations: ["Bone Spring", "Wolfcamp"],
    depthMin: 7500,
    depthMax: 11500,
  },
  howard: {
    primaryFormation: "Spraberry",
    formations: ["Spraberry", "Wolfcamp"],
    depthMin: 7000,
    depthMax: 9500,
  },
};

/**
 * Normalizes county strings for lookup: trim, lowercase, collapse spaces, strip trailing "County".
 * Handles "Midland", "Midland County", "midland county", "MIDLAND".
 */
export function normalizeCountyKey(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const t = raw.trim();
  if (!t) return null;
  const noCounty = t
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\s+county$/i, "")
    .trim();
  return noCounty || null;
}

export function lookupPermianCounty(countyKey: string | null): PermianCountyEntry | null {
  if (!countyKey) return null;
  return PERMIAN_COUNTY_MAP[countyKey] ?? null;
}

/** Title-case for display, e.g. "midland" -> "Midland", "red river" -> "Red River". */
export function titleCaseCountyLabel(countyKey: string): string {
  return countyKey
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}
