/**
 * Timeline — a chronological list of dated regulatory events for a well,
 * assembled from data already retrieved by other sources (no new TRRC
 * query). Every event is anchored to a date this pipeline actually parsed
 * out of a real TRRC response; nothing here is inferred or estimated. An
 * event whose date couldn't be confidently parsed is dropped rather than
 * guessed at.
 */

import type { LiteSourceAttempt } from "./coverage";
import type { TrrcDDProductionRow } from "./types";

export type TimelineEvent = {
  date: string; // ISO YYYY-MM-DD
  label: string;
  category: "permit" | "completion" | "production" | "plugging" | "compliance" | "status";
};

/**
 * TRRC dates in this pipeline's captured fixtures are consistently
 * MM/DD/YYYY, sometimes embedded in a longer string (e.g. drilling
 * permits' status_date: "Submitted: 01/22/2024 Approved: 01/25/2024").
 * Pulls the LAST matching date in the string on the assumption that a
 * later-stage date (Approved, not Submitted) is more decision-relevant
 * when both appear — verified against the real permit fixture, where the
 * approved date is what should anchor the event.
 */
function parseTrrcDate(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const matches = Array.from(raw.matchAll(/(\d{1,2})\/(\d{1,2})\/(\d{4})/g));
  if (matches.length === 0) return null;
  const [, mm, dd, yyyy] = matches[matches.length - 1];
  const month = mm.padStart(2, "0");
  const day = dd.padStart(2, "0");
  return `${yyyy}-${month}-${day}`;
}

function getLatestAttempt(attempts: LiteSourceAttempt[], sourceName: string): LiteSourceAttempt | null {
  return attempts.find(a => a.source_name === sourceName) ?? null;
}

export function buildTimeline(
  attempts: LiteSourceAttempt[],
  production: TrrcDDProductionRow[],
): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  const permits = getLatestAttempt(attempts, "fetch_drilling_permits");
  const permitRows = Array.isArray(permits?.result_data_json?.["permits"])
    ? (permits!.result_data_json!["permits"] as Record<string, unknown>[])
    : [];
  for (const p of permitRows) {
    const date = parseTrrcDate(p["status_date"]);
    if (!date) continue;
    const purpose = typeof p["filing_purpose"] === "string" ? p["filing_purpose"] : "Permit";
    const amended = p["amend"] === "Y" ? " (Amendment)" : "";
    events.push({ date, label: `Drilling Permit (W-1) — ${purpose}${amended}`, category: "permit" });
  }

  const comp = getLatestAttempt(attempts, "fetch_completion_records");
  const compDate = parseTrrcDate(comp?.result_data_json?.["completion_date"]);
  if (compDate) events.push({ date: compDate, label: "Well Completion (W-2)", category: "completion" });

  const plugging = getLatestAttempt(attempts, "fetch_plugging_records");
  const plugRows = Array.isArray(plugging?.result_data_json?.["records"])
    ? (plugging!.result_data_json!["records"] as Record<string, unknown>[])
    : [];
  for (const r of plugRows) {
    const date = parseTrrcDate(r["plug_date"] ?? r["date"]);
    if (date) events.push({ date, label: "Well Plugged (W-3C)", category: "plugging" });
  }

  const violations = getLatestAttempt(attempts, "fetch_compliance_violations");
  const violationRows = Array.isArray(violations?.result_data_json?.["violations"])
    ? (violations!.result_data_json!["violations"] as Record<string, unknown>[])
    : [];
  for (const v of violationRows) {
    const date = parseTrrcDate(v["violation_discovery_date"]);
    if (!date) continue;
    const rule = typeof v["violated_rule_description"] === "string" ? v["violated_rule_description"]
      : typeof v["violated_rule"] === "string" ? v["violated_rule"] : "Violation";
    const open = v["compliant_on_reinspection"] === "N" ? " — OPEN" : "";
    events.push({ date, label: `Compliance Violation — ${rule}${open}`, category: "compliance" });
  }

  const withOil = production.filter(p => p.oil_bbl !== null || p.gas_mcf !== null);
  if (withOil.length > 0) {
    const sorted = [...withOil].sort((a, b) => a.production_month.localeCompare(b.production_month));
    events.push({ date: `${sorted[0].production_month}-01`, label: "First Reported Production", category: "production" });
    if (sorted.length > 1) {
      events.push({ date: `${sorted[sorted.length - 1].production_month}-01`, label: "Most Recent Reported Production", category: "production" });
    }
  }

  return events.sort((a, b) => a.date.localeCompare(b.date));
}
