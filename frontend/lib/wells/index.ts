export { lookupNdicWells } from "./ndic-api";
export { lookupTrrcWells } from "./trrc-api";
export { lookupOccWells } from "./occ-api";
export { lookupWvdepWells } from "./wvdep-api";
export type { WellSummary, WellLookupResult } from "./well-types";

import { lookupNdicWells } from "./ndic-api";
import { lookupTrrcWells } from "./trrc-api";
import { lookupOccWells } from "./occ-api";
import { lookupWvdepWells } from "./wvdep-api";
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

  if (stateNorm === "ND" || stateNorm === "NORTH DAKOTA") {
    return lookupNdicWells(args.county);
  }

  if (stateNorm === "TX" || stateNorm === "TEXAS") {
    return lookupTrrcWells(args.county);
  }

  if (stateNorm === "OK" || stateNorm === "OKLAHOMA") {
    return lookupOccWells(args.county);
  }

  if (stateNorm === "WV" || stateNorm === "WEST VIRGINIA") {
    return lookupWvdepWells(args.county);
  }

  // Stubs — coming soon
  const comingSoon: Record<string, string> = {
    CO: "Colorado COGCC",
    COLORADO: "Colorado COGCC",
    WY: "Wyoming WOGCC",
    WYOMING: "Wyoming WOGCC",
    PA: "Pennsylvania DEP",
    PENNSYLVANIA: "Pennsylvania DEP",
    OH: "Ohio DNR",
    OHIO: "Ohio DNR",
    MT: "Montana BOGC",
    MONTANA: "Montana BOGC",
    NM: "New Mexico EMNRD",
    "NEW MEXICO": "New Mexico EMNRD",
    UT: "Utah DNR",
    UTAH: "Utah DNR",
    KS: "Kansas Corporation Commission",
    KANSAS: "Kansas Corporation Commission",
  };

  const src = comingSoon[stateNorm];
  return {
    source: "unavailable",
    wells: [],
    query_description: `${args.county} County, ${args.state}`,
    note: src
      ? `${src} integration coming soon. Live well data currently available for Texas (TRRC), North Dakota (NDIC), Oklahoma (OCC), and West Virginia (DEP).`
      : `Live well data not yet available for ${args.state}. Currently supports: Texas (TRRC), North Dakota (NDIC), Oklahoma (OCC), and West Virginia (DEP).`,
  };
}
