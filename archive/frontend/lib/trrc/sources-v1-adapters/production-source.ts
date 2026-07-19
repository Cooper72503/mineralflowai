/**
 * TRRC Source Adapters — Production (by lease and by API)
 *
 * production_by_lease: uses fetchTrrcProductionByLease (district + lease known)
 * production_by_api:   uses fetchTrrcProductionHistory (API number only, resolves lease internally)
 *
 * IMPORTANT: Production is always lease-level. canClaimSingleWellProduction is always false.
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
  fetchTrrcProductionByLease,
  fetchTrrcProductionHistory,
  type TrrcMonthlyRow,
} from "../../wells/trrc-production";

// ─── ProductionByLeaseSource ──────────────────────────────────────────────────

export const ProductionByLeaseSource: TrrcSourceAdapter = {
  id: "production_by_lease",
  name: "EWA Lease Production Query",
  description:
    "TRRC EWA specificLeaseQueryAction.do — monthly oil, casinghead gas, gas, condensate, " +
    "and water production by lease/district combination. CRITICAL: lease-level only; " +
    "canClaimSingleWellProduction is always false.",
  base_url: "https://webapps2.rrc.texas.gov/EWA",
  supported_inputs: ["rrc_lease_number"],
  retrieval_strategy: "html_scrape",
  rate_limit_ms: 1500,
  max_retries: 3,
  parser_version: "1.0.0",
  is_enabled: process.env["TRRC_SOURCE_PRODUCTION_BY_LEASE_ENABLED"] !== "false",
  requires_browser: false,

  async search(
    ctx: ResolvedSearchContext,
    _opts: RetrievalOptions,
  ): Promise<SourceSearchResult> {
    if (!ctx.district || !ctx.lease_number) {
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
      const result = await fetchTrrcProductionByLease(
        ctx.district,
        ctx.lease_number,
        ctx.production_months,
      );

      if (!result || result.rows.length === 0) {
        return {
          source_id: this.id,
          status: "no_results",
          records: [],
          result_count: 0,
          data: null,
          error: null,
          manual_action_url: null,
        };
      }

      const records: SourceRecordRef[] = result.rows.map(
        (row: TrrcMonthlyRow): SourceRecordRef => {
          const monthStr = `${row.year}-${String(row.month).padStart(2, "0")}`;
          return {
            source_id: this.id,
            document_id: `prod_lease_${ctx.district}_${ctx.lease_number}_${monthStr}`,
            title: `Lease ${ctx.lease_number} Production — ${monthStr}`,
            category: "production",
            form_type: "monthly_oil_gas_report",
            url: `https://webapps2.rrc.texas.gov/EWA/specificLeaseQueryAction.do`,
            filing_date: `${monthStr}-01`,
            is_downloadable: false,
          };
        },
      );

      return {
        source_id: this.id,
        status: "success",
        records,
        result_count: records.length,
        data: {
          district_code: result.distCode,
          lease_number: result.leaseNo,
          months_returned: result.rows.length,
          can_claim_single_well_production: false,
          note: "Lease-level production only. Single-well attribution requires per-well allocation evidence.",
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
        error: err instanceof Error ? err.message : "Network error fetching lease production",
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
      const res = await fetch("https://webapps2.rrc.texas.gov/EWA/specificLeaseQueryAction.do", {
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

// ─── ProductionByApiSource ────────────────────────────────────────────────────

export const ProductionByApiSource: TrrcSourceAdapter = {
  id: "production_by_api",
  name: "EWA API-Level Production",
  description:
    "TRRC EWA production query by API number. Resolves lease from API internally, " +
    "then fetches monthly production history. Data may be absent for oil wells " +
    "that report at lease level only.",
  base_url: "https://webapps2.rrc.texas.gov/EWA",
  supported_inputs: ["api_number"],
  retrieval_strategy: "html_scrape",
  rate_limit_ms: 1500,
  max_retries: 3,
  parser_version: "1.0.0",
  is_enabled: process.env["TRRC_SOURCE_PRODUCTION_BY_API_ENABLED"] !== "false",
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
      const result = await fetchTrrcProductionHistory(
        primaryApi.api10,
        ctx.production_months,
      );

      if (!result || result.rows.length === 0) {
        return {
          source_id: this.id,
          status: "no_results",
          records: [],
          result_count: 0,
          data: {
            note: "No per-API production data. Operator may report at lease level only — absence here does not mean no production.",
          },
          error: null,
          manual_action_url: null,
        };
      }

      const records: SourceRecordRef[] = result.rows.map(
        (row: TrrcMonthlyRow): SourceRecordRef => {
          const monthStr = `${row.year}-${String(row.month).padStart(2, "0")}`;
          return {
            source_id: this.id,
            document_id: `prod_api_${primaryApi.api10}_${monthStr}`,
            title: `API ${primaryApi.formatted} Production — ${monthStr}`,
            category: "production",
            form_type: "monthly_oil_gas_report",
            url: `https://webapps2.rrc.texas.gov/EWA/specificLeaseQueryAction.do`,
            filing_date: `${monthStr}-01`,
            is_downloadable: false,
          };
        },
      );

      return {
        source_id: this.id,
        status: "success",
        records,
        result_count: records.length,
        data: {
          api_number: result.api_number,
          district_code: result.district_code,
          lease_number: result.lease_number,
          months_returned: result.months_count,
          source: result.source,
          can_claim_single_well_production: false,
          note: "Lease-level production only. Single-well attribution requires per-well allocation evidence.",
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
        error: err instanceof Error ? err.message : "Network error fetching API production",
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
      const res = await fetch("https://webapps2.rrc.texas.gov/EWA/wellboreQueryAction.do", {
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
