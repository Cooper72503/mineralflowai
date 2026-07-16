/**
 * TRRC Source Adapter — Inspections & Violations (ICE)
 *
 * id: "inspections_violations"
 * Queries ICE portal for field inspection records (Tab 0) and violations (Tab 1).
 *
 * If district + lease available: queries violations by lease number.
 * If API numbers available:       queries inspections by API number.
 * Both paths run concurrently when both inputs are available.
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
  fetchTrrcViolationsByLease,
  type TrrcViolation,
} from "../../underwriting/trrc-compliance";
import {
  fetchTrrcInspectionsByApi,
  type TrrcInspectionRecord,
} from "../../wells/trrc-inspection";

const ICE_BASE = "https://webapps2.rrc.texas.gov/PDA/ice/pdaIceHome.xhtml";

export const ComplianceSource: TrrcSourceAdapter = {
  id: "inspections_violations",
  name: "EWA ICE Violations & Inspections Query",
  description:
    "TRRC PDA ICE portal — field inspection records and violations. " +
    "Violations data only available from August 1, 2015 onward via this search engine. " +
    "Queries violations by lease and inspections by API number.",
  base_url: ICE_BASE,
  supported_inputs: ["api_number", "rrc_lease_number"],
  retrieval_strategy: "html_scrape",
  rate_limit_ms: 2000,
  max_retries: 3,
  parser_version: "1.0.0",
  is_enabled: process.env["TRRC_SOURCE_INSPECTIONS_VIOLATIONS_ENABLED"] !== "false",
  requires_browser: false,

  async search(
    ctx: ResolvedSearchContext,
    _opts: RetrievalOptions,
  ): Promise<SourceSearchResult> {
    const hasLease = !!ctx.district && !!ctx.lease_number;
    const hasApi   = ctx.api_numbers.length > 0;

    if (!hasLease && !hasApi) {
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
      const [violations, inspections] = await Promise.all([
        hasLease
          ? fetchTrrcViolationsByLease(ctx.lease_number!)
          : Promise.resolve([] as TrrcViolation[]),
        hasApi
          ? fetchTrrcInspectionsByApi(ctx.api_numbers[0].api10)
          : Promise.resolve([] as TrrcInspectionRecord[]),
      ]);

      const records: SourceRecordRef[] = [];

      for (const v of violations) {
        const docId = v.violation_id
          ? `viol_${v.violation_id}`
          : `viol_${ctx.lease_number}_${v.date ?? "unknown"}`;
        records.push({
          source_id: this.id,
          document_id: docId,
          title: `Violation — ${v.type}${v.date ? ` (${v.date})` : ""}`,
          category: "compliance",
          form_type: "ice_violation_record",
          url: ICE_BASE,
          filing_date: v.date ?? null,
          is_downloadable: false,
        });
      }

      for (const insp of inspections) {
        records.push({
          source_id: this.id,
          document_id: `insp_${insp.api}_${insp.inspection_date ?? "unknown"}`,
          title: `Inspection — ${insp.inspection_type ?? "Oil & Gas"}${insp.inspection_date ? ` (${insp.inspection_date})` : ""} [${insp.result}]`,
          category: "compliance",
          form_type: "ice_inspection_record",
          url: ICE_BASE,
          filing_date: insp.inspection_date ?? null,
          is_downloadable: false,
        });
      }

      if (records.length === 0) {
        return {
          source_id: this.id,
          status: "no_results",
          records: [],
          result_count: 0,
          data: {
            note: "No violations or inspections found. Violations data covers 2015-08-01 onward only.",
          },
          error: null,
          manual_action_url: null,
        };
      }

      return {
        source_id: this.id,
        status: "success",
        records,
        result_count: records.length,
        data: {
          violations_count: violations.length,
          inspections_count: inspections.length,
          open_violations: violations.filter(v => v.status === "open").length,
          note: "Violations data covers 2015-08-01 onward. Full historical dataset available via downloadable dataset.",
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
        error: err instanceof Error ? err.message : "Network error fetching compliance data",
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
      const res = await fetch(ICE_BASE, {
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
