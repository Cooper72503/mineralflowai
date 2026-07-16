/**
 * TRRC Source Adapter — Wellbore Query (PDQ)
 *
 * id: "wellbore_query"
 * Queries TRRC EWA wellboreQueryAction.do via lookupTrrcLeasesByApis.
 * Returns well identity: API, operator, county, district, lease linkage.
 * Primary source for confirming API → lease → district resolution.
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
import { lookupTrrcLeasesByApis } from "../../wells/trrc-api";

const EWA_BASE = "https://webapps2.rrc.texas.gov/EWA";

export const WellboreSource: TrrcSourceAdapter = {
  id: "wellbore_query",
  name: "EWA Wellbore Query",
  description:
    "TRRC Electronic Well Application (EWA) PDQ wellbore query. Primary source for well identity: " +
    "API number, operator, county, district, lease linkage, wellbore profile, and current well status. " +
    "Supports county scan and direct API-prefix lookup.",
  base_url: EWA_BASE,
  supported_inputs: ["api_number", "rrc_lease_number", "operator_name", "lease_name"],
  retrieval_strategy: "html_scrape",
  rate_limit_ms: 1500,
  max_retries: 3,
  parser_version: "1.0.0",
  is_enabled: process.env["TRRC_SOURCE_WELLBORE_QUERY_ENABLED"] !== "false",
  requires_browser: false,

  async search(
    ctx: ResolvedSearchContext,
    _opts: RetrievalOptions,
  ): Promise<SourceSearchResult> {
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
      const apis = ctx.api_numbers.map(a => a.api10);
      // lookupTrrcLeasesByApis signature: (county: string | null, targetApis: string[])
      const leaseMap = await lookupTrrcLeasesByApis(ctx.county, apis);

      if (leaseMap.size === 0) {
        return {
          source_id: this.id,
          status: "no_results",
          records: [],
          result_count: 0,
          data: {
            apis_queried: apis,
            note: "No wellbore records found. Wells may not be registered or API numbers may be incorrect.",
          },
          error: null,
          manual_action_url: null,
        };
      }

      const records: SourceRecordRef[] = Array.from(leaseMap.entries()).map(
        ([api10, info]): SourceRecordRef => ({
          source_id: this.id,
          document_id: `wellbore_${api10}`,
          title: `Wellbore — API ${api10} | Lease ${info.leaseNo} (District ${info.distCode})${info.operator ? ` | ${info.operator}` : ""}`,
          category: "identity",
          form_type: "wellbore_master",
          url: `${EWA_BASE}/wellboreQueryAction.do`,
          filing_date: null,
          is_downloadable: false,
        }),
      );

      // Note any APIs that weren't found
      const foundApiList = Array.from(leaseMap.keys());
      const foundApisSet = new Set(foundApiList);
      const missingApis = apis.filter(a => !foundApisSet.has(a));

      return {
        source_id: this.id,
        status: "success",
        records,
        result_count: records.length,
        data: {
          wells_found: leaseMap.size,
          wells_not_found: missingApis,
          lease_district_map: Object.fromEntries(
            Array.from(leaseMap.entries()).map(([api, info]) => [
              api,
              { dist_code: info.distCode, lease_no: info.leaseNo, operator: info.operator },
            ]),
          ),
          note: missingApis.length > 0
            ? `${missingApis.length} API(s) not found in PDQ: ${missingApis.join(", ")}`
            : null,
        },
        error: null,
        manual_action_url: null,
      };
    } catch (err) {
      return {
        source_id: this.id,
        status: "failed_transient",
        records: [],
        result_count: 0,
        data: null,
        error: err instanceof Error ? err.message : "Network error fetching wellbore data",
        manual_action_url: null,
      };
    }
  },

  async fetchRecord(
    _ref: SourceRecordReference,
    _opts: RetrievalOptions,
  ): Promise<RetrievedFile | null> {
    return null;
  },

  async healthCheck(): Promise<SourceHealthResult> {
    const start = Date.now();
    try {
      const res = await fetch(`${EWA_BASE}/wellboreQueryAction.do`, {
        method: "HEAD",
        signal: AbortSignal.timeout(5_000),
      });
      return {
        healthy: res.ok,
        latency_ms: Date.now() - start,
        error: res.ok ? null : `HTTP ${res.status}`,
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
