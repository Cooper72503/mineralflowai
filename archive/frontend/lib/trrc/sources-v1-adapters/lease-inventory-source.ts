/**
 * TRRC Source Adapter — Lease Well Inventory
 *
 * id: "lease_inventory"
 * Queries TRRC EWA wellboreQueryAction.do by district + lease number to enumerate
 * ALL wells on the lease. Used to establish well count for production attribution.
 *
 * CRITICAL: Production is lease-level. This source establishes how many wells
 * share that lease production. canClaimSingleWellProduction is always false.
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
  fetchLeaseWellInventory,
  type LeaseWellRecord,
} from "../../underwriting/trrc-lease-inventory";

const EWA_BASE = "https://webapps2.rrc.texas.gov/EWA";

export const LeaseInventorySource: TrrcSourceAdapter = {
  id: "lease_inventory",
  name: "TRRC Lease Well Inventory",
  description:
    "Queries TRRC EWA wellboreQueryAction.do by district + lease number to enumerate ALL wells " +
    "on the lease. Establishes well count for production attribution. " +
    "CRITICAL: canClaimSingleWellProduction is always false from this source.",
  base_url: EWA_BASE,
  supported_inputs: ["rrc_lease_number"],
  retrieval_strategy: "html_scrape",
  rate_limit_ms: 1500,
  max_retries: 3,
  parser_version: "1.0.0",
  is_enabled: process.env["TRRC_SOURCE_LEASE_INVENTORY_ENABLED"] !== "false",
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
      const inventory = await fetchLeaseWellInventory(ctx.district, ctx.lease_number);

      if (inventory.query_failed && inventory.wells.length === 0) {
        return {
          source_id: this.id,
          status: "failed_transient",
          records: [],
          result_count: 0,
          data: {
            can_claim_single_well_production: false,
            note: "Lease well inventory query failed. Well count unknown. Do not assert single-well production.",
          },
          error: "TRRC EWA session establishment failed or timed out",
          manual_action_url: null,
        };
      }

      const records: SourceRecordRef[] = inventory.wells.map(
        (w: LeaseWellRecord): SourceRecordRef => ({
          source_id: this.id,
          document_id: `inv_${w.api10}_lease_${w.lease_number}`,
          title: `Well ${w.api10} on Lease ${w.lease_number}${w.well_type ? ` [${w.well_type}]` : ""}${w.operator_name ? ` — ${w.operator_name}` : ""}`,
          category: "identity",
          form_type: "lease_well_inventory",
          url: `${EWA_BASE}/wellboreQueryAction.do`,
          filing_date: null,
          is_downloadable: false,
        }),
      );

      return {
        source_id: this.id,
        status: records.length > 0 ? "success" : "no_results",
        records,
        result_count: records.length,
        data: {
          district_code: inventory.district_code,
          lease_number: inventory.lease_number,
          well_count: inventory.well_count,
          query_failed: inventory.query_failed,
          can_claim_single_well_production: false,
          lease_level_warning: inventory.lease_level_warning,
          query_timestamp: inventory.query_timestamp,
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
        error: err instanceof Error ? err.message : "Network error fetching lease inventory",
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
