/**
 * TRRC Source Adapter — Injection / UIC Query
 *
 * id: "injection_uic_query"
 * Queries TRRC EWA wellboreQueryAction.do with wellTypeCodeArg=D (disposal/injection).
 * Returns injection permit status, authorized zones, and MIT status.
 * Critical for SWD assets and wells converted to injection.
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
import {
  fetchTrrcInjectionByApi,
  type TrrcInjectionRecord,
} from "../../underwriting/trrc-injection";

const EWA_BASE = "https://webapps2.rrc.texas.gov/EWA";

export const InjectionSource: TrrcSourceAdapter = {
  id: "injection_uic_query",
  name: "EWA Injection/Disposal (UIC) Query",
  description:
    "TRRC EWA injection and disposal well query under Underground Injection Control (UIC) authority. " +
    "Returns injection permit status, authorized zones, maximum surface injection pressure (MSIP), " +
    "authorized injection volumes, and MIT history.",
  base_url: EWA_BASE,
  supported_inputs: ["api_number", "rrc_lease_number"],
  retrieval_strategy: "html_scrape",
  rate_limit_ms: 1500,
  max_retries: 3,
  parser_version: "1.0.0",
  is_enabled: process.env["TRRC_SOURCE_INJECTION_UIC_QUERY_ENABLED"] !== "false",
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
      const primaryApi = ctx.api_numbers[0];
      const injectionRecords = await fetchTrrcInjectionByApi(primaryApi.api10);

      if (injectionRecords.length === 0) {
        return {
          source_id: this.id,
          status: "no_results",
          records: [],
          result_count: 0,
          data: {
            note: "No injection/disposal well records found for this API. Conventional producing wells will return no results — expected behavior.",
          },
          error: null,
          manual_action_url: null,
        };
      }

      const records: SourceRecordRef[] = injectionRecords.map(
        (r: TrrcInjectionRecord): SourceRecordRef => ({
          source_id: this.id,
          document_id: `injection_${r.api10}_${r.lease_no ?? "nolease"}`,
          title: `${r.well_type} Well — API ${r.api10}${r.lease_name ? ` / ${r.lease_name}` : ""}`,
          category: "injection_uic",
          form_type: "uic_injection_permit",
          url: `${EWA_BASE}/wellboreQueryAction.do`,
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
          injection_wells_found: injectionRecords.length,
          well_types: Array.from(new Set(injectionRecords.map(r => r.well_type))),
          note: `${injectionRecords.length} injection/disposal well(s) found. Verify MIT test currency and permit conditions.`,
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
        error: err instanceof Error ? err.message : "Network error fetching injection data",
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
