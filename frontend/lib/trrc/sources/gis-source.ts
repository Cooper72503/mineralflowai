// @ts-nocheck
/**
 * TRRC Source Adapter — GIS Well Locations
 *
 * id: "gis_wellbore"
 * Uses two public ArcGIS REST APIs — no authentication, no CAPTCHA:
 *
 * 1. Statewide Surface Wells (Aug 2019)
 *    https://services.arcgis.com/KTcxiTD9dsQw4r7Z/arcgis/rest/services/Statewide_Surface_Wells_Aug2019/FeatureServer/0
 *    Used for: coordinate lookup by API number; offset well search by bbox.
 *
 * 2. Original Texas Land Survey (OTLS) + Statewide Wells (via trrc-abstract-lookup)
 *    Used for: legal description → GIS polygon → API numbers.
 *
 * Three search branches:
 *   Branch 1 — API numbers available: look up well coordinates by API.
 *   Branch 2 — Legal description: parse → OTLS polygon → bbox → API numbers.
 *   Branch 3 — Offset wells: search a bbox around the primary well (if include_offset_wells).
 */

import type {
  TrrcSourceAdapter,
  ResolvedSearchContext,
  RetrievalOptions,
  SourceSearchResult,
  SourceRecordRef,
  SourceHealthResult,
  SourceRecordReference,
  RetrievedFile,
} from "../types";
import { parseLegalDescription } from "../../location/legal-description-parser";
import { lookupWellsByLegalDescription } from "../../wells/trrc-abstract-lookup";

// ─── Constants ────────────────────────────────────────────────────────────────

const STATEWIDE_WELLS_URL =
  "https://services.arcgis.com/KTcxiTD9dsQw4r7Z/arcgis/rest/services/Statewide_Surface_Wells_Aug2019/FeatureServer/0";

const STATEWIDE_WELLS_QUERY = `${STATEWIDE_WELLS_URL}/query`;

const TRRC_GIS_VIEWER =
  "https://gis.rrc.texas.gov/GISViewer/";

// ─── ArcGIS response types ────────────────────────────────────────────────────

type WellFeature = {
  attributes: {
    API: string | null;
    LAT83: number | null;
    LONG83: number | null;
    WELL_NAME: string | null;
    OPERATOR: string | null;
    STATUS: string | null;
  };
};

type ArcGisQueryResponse = {
  features?: WellFeature[];
  error?: { message: string; code?: number };
};

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Normalize 8-digit or 10-digit raw API to full 10-digit TRRC API. */
function toApi10(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 8) return `42${digits}`;
  if (digits.length === 10 && digits.startsWith("42")) return digits;
  return null;
}

/** Convert 10-digit API to the 8-digit form used in the Statewide Wells layer (county+well). */
function toApi8(api10: string): string {
  // api10 = "42" + county(3) + well(5); strip leading "42" → 8 digits
  return api10.slice(2);
}

/**
 * Fetch well features from the Statewide Surface Wells ArcGIS service.
 * `where` clause is passed directly — caller is responsible for escaping.
 */
async function fetchWellFeatures(
  where: string,
  signal: AbortSignal,
): Promise<WellFeature[]> {
  const params = new URLSearchParams({
    where,
    outFields: "API,LAT83,LONG83,WELL_NAME,OPERATOR,STATUS",
    returnGeometry: "false",
    outSR: "4326",
    resultRecordCount: "200",
    f: "json",
  });

  const res = await fetch(`${STATEWIDE_WELLS_QUERY}?${params}`, { signal });
  if (!res.ok) throw new Error(`ArcGIS HTTP ${res.status}`);
  const json = (await res.json()) as ArcGisQueryResponse;
  if (json.error) throw new Error(`ArcGIS error: ${json.error.message}`);
  return json.features ?? [];
}

/** Build a SourceRecordRef for a GIS well-location record. */
function makeWellRecord(
  sourceId: string,
  api10: string,
  feature: WellFeature,
  formType: "well_location" | "offset_well_location",
): SourceRecordRef {
  const attr = feature.attributes;
  const wellName = attr.WELL_NAME ?? "Unknown Well";
  const isOffset = formType === "offset_well_location";
  return {
    source_id: sourceId,
    document_id: `gis_${formType}_${api10}`,
    title: isOffset
      ? `Offset Well — API ${api10} | ${wellName}`
      : `GIS Location — API ${api10} | ${wellName}`,
    category: "gis",
    form_type: formType,
    url: `${TRRC_GIS_VIEWER}`,
    filing_date: null,
    is_downloadable: false,
  };
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

export const GisSource: TrrcSourceAdapter = {
  id: "gis_wellbore",
  name: "TRRC GIS Well Locations",
  description:
    "ArcGIS public well location data — coordinates, status, operator. " +
    "No authentication required. Supports API-number coordinate lookup, " +
    "legal-description → OTLS polygon → API resolution, and offset well search.",
  base_url: STATEWIDE_WELLS_URL,
  supported_inputs: [
    "api_number",
    "legal_description",
    "rrc_lease_number",
    "operator_name",
    "lease_name",
  ],
  retrieval_strategy: "api",
  rate_limit_ms: 500,
  max_retries: 2,
  parser_version: "1.0",
  is_enabled: process.env["TRRC_SOURCE_GIS_WELLBORE_ENABLED"] !== "false",
  requires_browser: false,

  async search(
    ctx: ResolvedSearchContext,
    _opts: RetrievalOptions,
  ): Promise<SourceSearchResult> {
    const signal = AbortSignal.timeout(30_000);

    // ── Branch 2: Legal description ───────────────────────────────────────────
    if (ctx.input_type === "legal_description" && ctx.legal_description) {
      try {
        const parsed = parseLegalDescription(ctx.legal_description);

        const gisResult = await lookupWellsByLegalDescription({
          county: ctx.county,
          state: "TX",
          abstract_number: parsed.abstract_number,
          survey_name: parsed.survey_name,
          block: parsed.block,
          section: parsed.section,
        });

        if (!gisResult || gisResult.api_numbers.length === 0) {
          return {
            source_id: this.id,
            status: "no_results",
            records: [],
            result_count: 0,
            data: {
              legal_description: ctx.legal_description,
              parsed_abstract: parsed.abstract_number,
              parsed_survey: parsed.survey_name,
              parsed_block: parsed.block,
              parsed_section: parsed.section,
            },
            error: null,
            manual_action_url: TRRC_GIS_VIEWER,
          };
        }

        // Limit to first 10 APIs to avoid flooding downstream
        const resolvedApis = gisResult.api_numbers.slice(0, 10);

        const records: SourceRecordRef[] = resolvedApis.map(
          (api10): SourceRecordRef => ({
            source_id: this.id,
            document_id: `gis_legal_desc_${api10}`,
            title: `GIS Legal Description Match — API ${api10} | ${gisResult.description}`,
            category: "gis",
            form_type: "well_location",
            url: TRRC_GIS_VIEWER,
            filing_date: null,
            is_downloadable: false,
          }),
        );

        return {
          source_id: this.id,
          status: "success",
          records,
          result_count: records.length,
          data: {
            legal_description: ctx.legal_description,
            resolved_apis: resolvedApis,
            centroid: gisResult.centroid,
            description: gisResult.description,
            polygon_count: gisResult.polygon_count,
            parsed_abstract: parsed.abstract_number,
            parsed_survey: parsed.survey_name,
            parsed_block: parsed.block,
            parsed_section: parsed.section,
          },
          error: null,
          manual_action_url: null,
        };
      } catch {
        return {
          source_id: this.id,
          status: "failed_transient",
          records: [],
          result_count: 0,
          data: null,
          error: "Network error during GIS legal description lookup",
          manual_action_url: TRRC_GIS_VIEWER,
        };
      }
    }

    // ── Branch 1 + 3: API numbers available ──────────────────────────────────
    if (ctx.api_numbers.length === 0) {
      return {
        source_id: this.id,
        status: "not_applicable",
        records: [],
        result_count: 0,
        data: null,
        error: null,
        manual_action_url: null,
      };
    }

    try {
      const primaryRecords: SourceRecordRef[] = [];
      const offsetRecords: SourceRecordRef[] = [];

      // Coordinate map for offset well search: api10 → {lat, lng}
      const coordMap = new Map<string, { lat: number; lng: number }>();

      // Branch 1: look up each API in the statewide wells layer
      for (const normApi of ctx.api_numbers) {
        const api8 = toApi8(normApi.api10);
        // Use LIKE query to match county+well prefix (last 2 digits are sidetrack/event suffix)
        const where = `API LIKE '${api8}%'`;
        const features = await fetchWellFeatures(where, signal);

        for (const feature of features) {
          const rawApi = String(feature.attributes.API ?? "").replace(/\D/g, "");
          const api10 = toApi10(rawApi) ?? normApi.api10;

          primaryRecords.push(makeWellRecord(this.id, api10, feature, "well_location"));

          const lat = feature.attributes.LAT83;
          const lng = feature.attributes.LONG83;
          if (lat != null && lng != null && !coordMap.has(api10)) {
            coordMap.set(api10, { lat, lng });
          }
        }
      }

      // Branch 3: offset wells (bbox search around primary well coordinates)
      if (ctx.include_offset_wells && coordMap.size > 0) {
        // Use the first primary well's coordinates as the center
        const [[, center]] = Array.from(coordMap.entries());
        const delta = 0.1; // ~7 miles

        const where =
          `LAT83 BETWEEN ${center.lat - delta} AND ${center.lat + delta}` +
          ` AND LONG83 BETWEEN ${center.lng - delta} AND ${center.lng + delta}`;

        const offsetFeatures = await fetchWellFeatures(where, signal);

        // Exclude APIs already in the primary set
        const primaryApiSet = new Set(primaryRecords.map((r) => r.document_id));

        for (const feature of offsetFeatures) {
          const rawApi = String(feature.attributes.API ?? "").replace(/\D/g, "");
          const api10 = toApi10(rawApi);
          if (!api10) continue;

          const docId = `gis_well_location_${api10}`;
          if (primaryApiSet.has(docId)) continue;

          offsetRecords.push(makeWellRecord(this.id, api10, feature, "offset_well_location"));
        }
      }

      const allRecords = [...primaryRecords, ...offsetRecords];

      if (allRecords.length === 0) {
        return {
          source_id: this.id,
          status: "no_results",
          records: [],
          result_count: 0,
          data: {
            apis_queried: ctx.api_numbers.map((a) => a.api10),
            note: "No well locations found in the Statewide Surface Wells layer for the given APIs.",
          },
          error: null,
          manual_action_url: TRRC_GIS_VIEWER,
        };
      }

      // Build coordinate data for downstream use
      const coordinateData = Object.fromEntries(
        Array.from(coordMap.entries()).map(([api10, coords]) => [api10, coords]),
      );

      return {
        source_id: this.id,
        status: "success",
        records: allRecords,
        result_count: allRecords.length,
        data: {
          primary_well_count: primaryRecords.length,
          offset_well_count: offsetRecords.length,
          coordinates: coordinateData,
          note: ctx.include_offset_wells
            ? `Found ${primaryRecords.length} primary well(s) and ${offsetRecords.length} offset well(s) within ~7 miles`
            : `Found ${primaryRecords.length} well location(s)`,
        },
        error: null,
        manual_action_url: null,
      };
    } catch {
      return {
        source_id: this.id,
        status: "failed_transient",
        records: [],
        result_count: 0,
        data: null,
        error: "Network error during GIS well location lookup",
        manual_action_url: TRRC_GIS_VIEWER,
      };
    }
  },

  async fetchRecord(
    _ref: SourceRecordReference,
    _opts: RetrievalOptions,
  ): Promise<RetrievedFile | null> {
    // GIS records are coordinate data only — not downloadable as files
    return null;
  },

  async healthCheck(): Promise<SourceHealthResult> {
    const start = Date.now();
    try {
      // Query the service info endpoint to verify it responds
      const res = await fetch(`${STATEWIDE_WELLS_URL}?f=json`, {
        signal: AbortSignal.timeout(10_000),
      });
      const healthy = res.ok;
      let error: string | null = null;

      if (res.ok) {
        const json = (await res.json()) as { name?: string; error?: { message: string } };
        if (json.error) {
          error = `ArcGIS service error: ${json.error.message}`;
        }
      } else {
        error = `HTTP ${res.status}`;
      }

      return {
        healthy: healthy && error === null,
        latency_ms: Date.now() - start,
        error,
        last_checked: new Date().toISOString(),
      };
    } catch (err) {
      return {
        healthy: false,
        latency_ms: Date.now() - start,
        error: err instanceof Error ? err.message : "Unknown error",
        last_checked: new Date().toISOString(),
      };
    }
  },
};
