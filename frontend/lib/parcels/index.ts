export type { ParcelLookupResult } from "./ohio-parcel-api";
export { lookupOhioParcel } from "./ohio-parcel-api";

import { lookupOhioParcel } from "./ohio-parcel-api";
import type { ParcelLookupResult } from "./ohio-parcel-api";

/**
 * Look up parcel data by parcel ID and state.
 * Routes to the correct state data source.
 */
export async function lookupParcel(args: {
  parcel_id: string | null;
  state: string | null;
  county?: string | null;
}): Promise<ParcelLookupResult | null> {
  if (!args.parcel_id?.trim()) return null;

  const stateNorm = (args.state ?? "").trim().toUpperCase();

  if (stateNorm === "OH" || stateNorm === "OHIO") {
    return lookupOhioParcel(args.parcel_id);
  }

  // Not yet supported
  return null;
}
