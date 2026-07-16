/**
 * TRRC Source Adapter — Oil & Gas Proration Query
 *
 * id: "oil_proration"
 * Queries TRRC EWA oilProQueryAction.do and gasProQueryAction.do (via fetchTrrcProration).
 * Returns oil and gas proration allowables, field rules, and special conditions.
 * Useful for understanding regulatory production caps.
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
  fetchTrrcProration,
  type TrrcProrationRecord,
} from "../../underwriting/trrc-proration";

const EWA_BASE = "https://webapps2.rrc.texas.gov/EWA";

export const ProrationSource: TrrcSourceAdapter = {
  id: "oil_proration",
  name: "EWA Oil Proration Query",
  description:
    "TRRC EWA oil and gas proration allowable queries (oilProQueryAction.do + gasProQueryAction.do). " +
    "Returns current and historical proration allowables for oil and gas leases, including " +
    "allowable volume, field rules, and any special conditions. " +
    "No data returned for fields exempt from proration — expected behavior.",
  base_url: EWA_BASE,
  supported_inputs: ["rrc_lease_number", "api_number"],
  retrieval_strategy: "html_scrape",
  rate_limit_ms: 2000,
  max_retries: 2,
  parser_version: "1.0.0",
  is_enabled: process.env["TRRC_SOURCE_OIL_PRORATION_ENABLED"] !== "false",
  requires_browser: false,

  async search(
    ctx: ResolvedSearchContext,
    _opts: RetrievalOptions,
  ): Promise<SourceSearchResult> {
    if (ctx.api_numbers.length === 0 || !ctx.district) {
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
      const prorationRecords = await fetchTrrcProration(primaryApi.api10, ctx.district);

      if (prorationRecords.length === 0) {
        return {
          source_id: this.id,
          status: "no_results",
          records: [],
          result_count: 0,
          data: {
            note: "No proration records found. Field may be exempt from proration — common for unconventional wells. Absence does not indicate a problem.",
          },
          error: null,
          manual_action_url: null,
        };
      }

      const records: SourceRecordRef[] = prorationRecords.map(
        (r: TrrcProrationRecord): SourceRecordRef => ({
          source_id: this.id,
          document_id: `proration_${r.api8}_${r.commodity}_${r.lease_no}`,
          title: `${r.commodity === "oil" ? "Oil" : "Gas"} Proration — API ${r.api8}${r.field_name ? ` / ${r.field_name}` : ""}${r.daily_allowable ? ` — Allowable: ${r.daily_allowable}` : ""}`,
          category: "production",
          form_type: `${r.commodity}_proration_record`,
          url: r.commodity === "oil"
            ? `${EWA_BASE}/oilProQueryAction.do`
            : `${EWA_BASE}/gasProQueryAction.do`,
          filing_date: null,
          is_downloadable: false,
        }),
      );

      const oilRecords = prorationRecords.filter(r => r.commodity === "oil");
      const gasRecords = prorationRecords.filter(r => r.commodity === "gas");

      return {
        source_id: this.id,
        status: "success",
        records,
        result_count: records.length,
        data: {
          oil_proration_records: oilRecords.length,
          gas_proration_records: gasRecords.length,
          field_types: Array.from(new Set(prorationRecords.map(r => r.field_type).filter((t): t is string => t !== null))),
          daily_allowables: prorationRecords.map(r => ({
            api8: r.api8,
            commodity: r.commodity,
            allowable: r.daily_allowable,
            potential: r.potential,
            well_type: r.well_type,
          })),
          note: "Proration allowables constrain maximum daily production. Compare allowable vs. actual production to identify over/under-production.",
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
        error: err instanceof Error ? err.message : "Network error fetching proration data",
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
      const res = await fetch(`${EWA_BASE}/oilProQueryAction.do`, {
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
