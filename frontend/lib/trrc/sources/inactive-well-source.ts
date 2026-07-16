/**
 * TRRC Source Adapter — Inactive Well Query
 *
 * id: "inactive_well_query"
 * Queries TRRC EWA inactiveWellQueryAction.do for each API number.
 * A well NOT appearing in results is actively producing or exempt — absence is a positive signal.
 * A well in results has plugging cost exposure and a compliance due date.
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
  fetchTrrcInactiveWellByApi,
  type TrrcInactiveWellRecord,
} from "../../underwriting/trrc-inactive-wells";

const EWA_BASE = "https://webapps2.rrc.texas.gov/EWA";

export const InactiveWellSource: TrrcSourceAdapter = {
  id: "inactive_well_query",
  name: "EWA Inactive Well Query",
  description:
    "TRRC EWA inactiveWellQueryAction.do. Identifies wells on the TRRC inactive/non-producing " +
    "list with estimated plugging costs, shut-in dates, inactivity duration, and extension status. " +
    "A well NOT appearing in results is actively producing — absence is a positive signal.",
  base_url: EWA_BASE,
  supported_inputs: ["api_number", "rrc_lease_number", "operator_name"],
  retrieval_strategy: "html_scrape",
  rate_limit_ms: 1500,
  max_retries: 3,
  parser_version: "1.0.0",
  is_enabled: process.env["TRRC_SOURCE_INACTIVE_WELL_QUERY_ENABLED"] !== "false",
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
      // Query each API in parallel, then aggregate results
      const results = await Promise.allSettled(
        ctx.api_numbers.map(a => fetchTrrcInactiveWellByApi(a.api10)),
      );

      const allRecords: TrrcInactiveWellRecord[] = [];
      const allActiveNotFlagged: string[] = [];

      for (let i = 0; i < results.length; i++) {
        const settled = results[i];
        if (settled.status === "fulfilled") {
          if (settled.value.is_active_not_flagged) {
            allActiveNotFlagged.push(ctx.api_numbers[i].api10);
          } else {
            allRecords.push(...settled.value.records);
          }
        }
      }

      const sourceRecords: SourceRecordRef[] = allRecords.map(
        (r: TrrcInactiveWellRecord): SourceRecordRef => ({
          source_id: this.id,
          document_id: `inactive_${r.api8}_${r.lease_no}`,
          title: `Inactive Well — API ${r.api8}${r.shut_in_date ? ` (shut-in ${r.shut_in_date})` : ""}${r.plugging_cost_usd != null ? ` — Est. P&A cost $${r.plugging_cost_usd.toLocaleString()}` : ""}`,
          category: "plugging_inactive",
          form_type: "inactive_well_record",
          url: `${EWA_BASE}/inactiveWellQueryAction.do`,
          filing_date: null,
          is_downloadable: false,
        }),
      );

      if (sourceRecords.length === 0) {
        return {
          source_id: this.id,
          status: "no_results",
          records: [],
          result_count: 0,
          data: {
            apis_checked: ctx.api_numbers.map(a => a.api10),
            all_active_not_flagged: true,
            note: "No inactive well records found. All queried wells appear to be active or exempt from the inactive list — positive signal.",
          },
          error: null,
          manual_action_url: null,
        };
      }

      const totalPluggingExposure = allRecords.reduce(
        (sum, r) => sum + (r.plugging_cost_usd ?? 50_000),
        0,
      );

      return {
        source_id: this.id,
        status: "success",
        records: sourceRecords,
        result_count: sourceRecords.length,
        data: {
          inactive_wells_found: allRecords.length,
          active_not_flagged: allActiveNotFlagged,
          estimated_total_plugging_exposure_usd: totalPluggingExposure,
          wells_with_extension: allRecords.filter(r => r.extension_status === "Approved").length,
          wells_plugged: allRecords.filter(r => r.well_plugged).length,
          note: `${allRecords.length} well(s) flagged as inactive on TRRC list with estimated P&A exposure of $${totalPluggingExposure.toLocaleString()}.`,
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
        error: err instanceof Error ? err.message : "Network error fetching inactive well data",
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
      const res = await fetch(`${EWA_BASE}/inactiveWellQueryAction.do`, {
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
