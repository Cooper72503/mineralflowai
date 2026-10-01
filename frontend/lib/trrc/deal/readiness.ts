import { latestSourceAttempts, type LiteSourceAttempt } from "../coverage";

export interface RegulatoryCoverage {
  source: string;
  status: "verified" | "limited" | "unavailable";
  reason: string;
  attemptedAt: string | null;
  url: string | null;
}

/** A successfully executed query and a clean asset are different statements. */
export function regulatoryCoverage(attempts: LiteSourceAttempt[]): RegulatoryCoverage[] {
  const latest = latestSourceAttempts(attempts);
  return ["fetch_compliance_violations", "fetch_plugging_records", "fetch_orphan_well", "fetch_inactive_well_status", "fetch_injection_records"].map(source => {
    const a = latest.find(x => x.source_name === source);
    const d = a?.result_data_json;
    const base = { source, attemptedAt: a?.attempted_at ?? null, url: typeof d?.query_url === "string" ? d.query_url : typeof d?.trrc_source_url === "string" ? d.trrc_source_url : null };
    if (!a || a.status !== "success" || !d || d.error || d.data_gap || d.endpoint_available === false)
      return { ...base, status: "unavailable", reason: a?.error_message || String(d?.error || d?.message || "This source was not successfully verified.") };
    if (d.coverage_incomplete || (Array.isArray(d.partial_errors) && d.partial_errors.length))
      return { ...base, status: "unavailable", reason: "Only partial source coverage was retrieved; completeness is not established." };
    if (source === "fetch_compliance_violations" && (typeof d.open_count !== "number" || !Number.isFinite(d.open_count)))
      return { ...base, status: "unavailable", reason: "Compliance records were returned, but the open-violation count is unknown or truncated." };
    if (source === "fetch_plugging_records" && d.w3_certificate_checked === false)
      return { ...base, status: "limited", reason: `${String(d.message || "Plugging status from the TRRC GIS symbol only.")} W-3 certificate content was not checked.` };
    // The inactive-well query answers with is_inactive: "Not in inactive well
    // report" follows TRRC's explicit "no results found" for the operator and
    // API, which is a confirmed empty search (all 12 Buttercup wells).
    const established = typeof d.found === "boolean" || (source === "fetch_inactive_well_status" && typeof d.is_inactive === "boolean");
    if (!established && source !== "fetch_orphan_well")
      return { ...base, status: "unavailable", reason: "The source response does not establish a result or a confirmed empty search." };
    return { ...base, status: "verified", reason: String(d.message || "Query completed; findings are reported separately.") };
  });
}

/** Completed calendar months, not the number of null rows returned by TRRC. */
export function unreportedMonths(lastReportedMonth: string | null, asOf: string): number | null {
  if (!lastReportedMonth || !/^\d{4}-(0[1-9]|1[0-2])$/.test(lastReportedMonth) || !Number.isFinite(Date.parse(asOf))) return null;
  const now = new Date(asOf);
  const delta = now.getUTCFullYear() * 12 + now.getUTCMonth() - (Number(lastReportedMonth.slice(0, 4)) * 12 + Number(lastReportedMonth.slice(5, 7)) - 1) - 1;
  return delta < 0 ? null : delta;
}

export const MAX_UNREPORTED_COMPLETED_MONTHS = 3;
