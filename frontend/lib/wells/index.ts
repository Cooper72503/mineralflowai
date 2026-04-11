export { lookupNdicWells } from "./ndic-api";
export type { WellSummary, WellLookupResult } from "./well-types";

import { lookupNdicWells } from "./ndic-api";
import type { WellLookupResult } from "./well-types";

/**
 * Route to the correct state data source based on state.
 * Falls back gracefully when no integration exists yet.
 */
export async function lookupWellsByLocation(args: {
  county: string | null;
  state: string | null;
  township?: string | null;
  range?: string | null;
}): Promise<WellLookupResult> {
  if (!args.county || !args.state) {
    return {
      source: "unavailable",
      wells: [],
      query_description: "Unknown location",
      note: "County and state are required for well lookup.",
    };
  }

  const stateNorm = args.state.trim().toUpperCase();
  const isND = stateNorm === "ND" || stateNorm === "NORTH DAKOTA";

  if (isND) return lookupNdicWells(args.county);

  // Stubs — coming soon
  const comingSoon: Record<string, string> = {
    TX: "Texas RRC",
    TEXAS: "Texas RRC",
    CO: "Colorado COGCC",
    COLORADO: "Colorado COGCC",
    OK: "Oklahoma OCC",
    OKLAHOMA: "Oklahoma OCC",
    WY: "Wyoming WOGCC",
    WYOMING: "Wyoming WOGCC",
    WV: "West Virginia DEP",
    "WEST VIRGINIA": "West Virginia DEP",
    PA: "Pennsylvania DEP",
    PENNSYLVANIA: "Pennsylvania DEP",
    OH: "Ohio DNR",
    OHIO: "Ohio DNR",
  };

  const src = comingSoon[stateNorm];
  return {
    source: "unavailable",
    wells: [],
    query_description: `${args.county} County, ${args.state}`,
    note: src
      ? `${src} integration coming soon. Live well data currently available for North Dakota (NDIC).`
      : `Live well data not yet available for ${args.state}. Currently supports: North Dakota (NDIC).`,
  };
}
