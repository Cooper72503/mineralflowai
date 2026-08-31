/**
 * Basin -> county groupings, shared between the Permit Tracker UI's
 * quick-pick list and the basin_operators backfill script (scripts/
 * sync-basin-operators.ts) so the two never drift out of sync — "which
 * counties count as this basin" must mean the same thing in both places.
 *
 * Permian Basin (TX side) covers both the Midland Basin and Delaware
 * Basin sub-basins. Eagle Ford is the South Texas shale play. This is a
 * curated list, not exhaustive of every county with any oil & gas activity
 * — any of the other 254 TX counties is still reachable via the tracker's
 * free-text county search.
 */
export const COUNTY_GROUPS: { label: string; counties: string[] }[] = [
  {
    label: "Permian Basin",
    counties: [
      "ANDREWS", "BORDEN", "COCHRAN", "COKE", "CONCHO", "CRANE", "CROCKETT",
      "CROSBY", "CULBERSON", "DAWSON", "DICKENS", "ECTOR", "GAINES", "GARZA",
      "GLASSCOCK", "HOCKLEY", "HOWARD", "IRION", "LOVING", "LYNN", "MARTIN",
      "MIDLAND", "MITCHELL", "NOLAN", "PECOS", "REAGAN", "REEVES", "SCHLEICHER",
      "SCURRY", "STERLING", "SUTTON", "TERRELL", "TERRY", "UPTON", "VAL VERDE",
      "WARD", "WINKLER", "YOAKUM",
    ],
  },
  {
    label: "Eagle Ford",
    counties: [
      "ATASCOSA", "BEE", "DE WITT", "DIMMIT", "FAYETTE", "FRIO", "GOLIAD",
      "GONZALES", "KARNES", "LA SALLE", "LAVACA", "LIVE OAK", "MAVERICK",
      "MCMULLEN", "WEBB", "WILSON", "ZAVALA",
    ],
  },
];

export const ALL_BASIN_COUNTIES: string[] = COUNTY_GROUPS.flatMap((g) => g.counties);

/** Every basin label a county belongs to (a county can appear in more than one group). */
export function basinsForCounty(countyName: string): string[] {
  const upper = countyName.trim().toUpperCase();
  return COUNTY_GROUPS.filter((g) => g.counties.includes(upper)).map((g) => g.label);
}
