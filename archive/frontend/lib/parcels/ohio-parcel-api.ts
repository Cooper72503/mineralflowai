/**
 * Ohio parcel lookup via the Ohio DNR statewide parcel ArcGIS REST service.
 * Covers all Ohio counties using the OGRIP statewide parcel layer.
 *
 * Data source: https://gis.ohiodnr.gov/arcgis/rest/services/OIT_Services/ODNR_LandBase_CNTY_TWP_OLS_PARC/MapServer/4
 * No API key required — public service.
 */

export type ParcelLookupResult = {
  source: "ohio_dnr" | "unavailable";
  parcel_id: string | null;
  acreage: number | null;
  owner: string | null;
  county: string | null;
  state: "Ohio";
  property_class: string | null;
  note?: string;
};

const OHIO_PARCEL_URL =
  "https://gis.ohiodnr.gov/arcgis/rest/services/OIT_Services/ODNR_LandBase_CNTY_TWP_OLS_PARC/MapServer/4/query";

type OhioParcelFeature = {
  attributes: Record<string, unknown>;
};

function safeStr(v: unknown): string | null {
  if (v == null || v === "" || v === " " || v === "N/A") return null;
  return String(v).trim() || null;
}

function safeNum(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return isNaN(n) || n <= 0 ? null : n;
}

function featureToResult(f: OhioParcelFeature, parcelId: string): ParcelLookupResult {
  const a = f.attributes;

  // Acreage: prefer assessor acres, fall back to calculated
  const acreage =
    safeNum(a.ASSR_ACRES ?? a.CALC_ACRES ?? a.GIS_ACRES ?? a.ACRES ?? a.STATEDAREA);

  // Owner: combine OWNER1 + OWNER2 if both present
  const owner1 = safeStr(a.OWNER1 ?? a.OWN_NAME1 ?? a.OWNERNAME ?? a.OWNER);
  const owner2 = safeStr(a.OWNER2 ?? a.OWN_NAME2);
  const owner = owner1
    ? owner2 ? `${owner1} / ${owner2}` : owner1
    : null;

  // County: may be a code or name depending on layer
  const county = safeStr(a.COUNTY ?? a.COUNTY_NAME ?? a.CO_NAME);

  // Property class
  const propertyClass = safeStr(a.PCLASS ?? a.PROP_CLASS ?? a.CLASS ?? a.PROPERTY_CLASS);

  return {
    source: "ohio_dnr",
    parcel_id: safeStr(a.PIN ?? a.PARCEL_ID ?? a.PARCELNO) ?? parcelId,
    acreage,
    owner,
    county,
    state: "Ohio",
    property_class: propertyClass,
  };
}

/**
 * Look up an Ohio parcel by parcel ID (PIN).
 * Returns acreage, owner, county. Falls back gracefully on error.
 */
export async function lookupOhioParcel(parcelId: string): Promise<ParcelLookupResult> {
  const unavailable = (note: string): ParcelLookupResult => ({
    source: "unavailable",
    parcel_id: parcelId,
    acreage: null,
    owner: null,
    county: null,
    state: "Ohio",
    property_class: null,
    note,
  });

  if (!parcelId?.trim()) return unavailable("No parcel ID provided.");

  // Try the exact PIN first, then a LIKE match for flexibility
  const queries = [
    `PIN = '${parcelId.trim()}'`,
    `PARCEL_ID = '${parcelId.trim()}'`,
    `PARCELNO LIKE '%${parcelId.trim().replace(/^0+/, "")}%'`,
  ];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);

  try {
    for (const where of queries) {
      const params = new URLSearchParams({
        where,
        outFields: "PIN,PARCEL_ID,PARCELNO,ASSR_ACRES,CALC_ACRES,GIS_ACRES,ACRES,OWNER1,OWNER2,OWN_NAME1,OWN_NAME2,COUNTY,COUNTY_NAME,PCLASS,PROP_CLASS",
        returnGeometry: "false",
        resultRecordCount: "1",
        f: "json",
      });

      const res = await fetch(`${OHIO_PARCEL_URL}?${params.toString()}`, {
        signal: controller.signal,
      });

      if (!res.ok) continue;

      const json = await res.json() as {
        features?: OhioParcelFeature[];
        error?: { message: string };
      };

      if (json.error) continue;

      const features = json.features ?? [];
      if (features.length > 0) {
        clearTimeout(timer);
        return featureToResult(features[0], parcelId);
      }
    }

    clearTimeout(timer);
    return unavailable(`No parcel found for ID: ${parcelId}`);
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.warn("[ohio-parcel-api] lookup failed:", msg);
    return unavailable(`Ohio parcel data temporarily unavailable: ${msg}`);
  }
}
