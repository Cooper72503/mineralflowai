import { describe, it, expect } from "vitest";
import { regulatoryCoverage, unreportedMonths } from "../readiness";
const attempt = (source_name: string, result_data_json: Record<string, unknown>, status = "success", attempted_at = "2026-09-28T12:00:00Z") => ({ source_name, source_id: "test-source", result_count: 0, result_data_json, status, attempted_at, error_message: null });
describe("evidence readiness", () => {
  it("does not interpret missing or failed queries as clearance", () => {
    expect(regulatoryCoverage([]).every(c => c.status === "unavailable")).toBe(true);
    const c = regulatoryCoverage([attempt("fetch_compliance_violations", { found: false, open_count: 0 }, "failed_transient")]);
    expect(c[0].status).toBe("unavailable");
  });
  it("distinguishes a verified empty compliance search from an unknown or truncated count", () => {
    for (const data of [{ found: true, open_count: null }, { found: false, open_count: 0, coverage_incomplete: true }, { found: false, open_count: 0, endpoint_available: false }])
      expect(regulatoryCoverage([attempt("fetch_compliance_violations", data)])[0].status).toBe("unavailable");
    expect(regulatoryCoverage([attempt("fetch_compliance_violations", { found: false, open_count: 0 })])[0].status).toBe("verified");
  });
  it("uses the latest attempt and labels GIS-only plugging coverage", () => {
    const c = regulatoryCoverage([attempt("fetch_compliance_violations", { found: false, open_count: 0 }, "success", "2026-09-27T12:00:00Z"), attempt("fetch_compliance_violations", {}, "failed_transient"), attempt("fetch_plugging_records", { found: false, w3_certificate_checked: false })]);
    expect(c[0].status).toBe("unavailable"); expect(c[1].status).toBe("limited");
  });
  it("accepts TRRC's confirmed-empty inactive-well answer, and still refuses a failed one (live Buttercup)", () => {
    const ok = regulatoryCoverage([attempt("fetch_inactive_well_status", { message: "Not in inactive well report", records: [], is_inactive: false, plugging_deadline: null })]);
    expect(ok.find(c => c.source === "fetch_inactive_well_status")!.status).toBe("verified");
    const bad = regulatoryCoverage([attempt("fetch_inactive_well_status", { message: "Inactive well query rejected the search criteria", error: "rejected", is_inactive: false })]);
    expect(bad.find(c => c.source === "fetch_inactive_well_status")!.status).toBe("unavailable");
    expect(regulatoryCoverage([attempt("fetch_inactive_well_status", { message: "?" })]).find(c => c.source === "fetch_inactive_well_status")!.status).toBe("unavailable");
  });
  it("detects missing calendar months even when the server omitted rows entirely", () => {
    expect(unreportedMonths("2026-01", "2026-09-28")).toBe(7);
    expect(unreportedMonths("2024-01", "2026-09-28")).toBe(31);
    expect(unreportedMonths("2026-08", "2026-09-28")).toBe(0);
    expect(unreportedMonths("2026-13", "2026-09-28")).toBeNull();
    expect(unreportedMonths("2027-01", "2026-09-28")).toBeNull();
  });
});

describe("source failures read as one plain line (live 2026-10-04)", () => {
  it("strips browser call logs and states the cause", async () => {
    const { plainSourceError } = await import("../../coverage");
    expect(plainSourceError('TimeoutError: page.goto: Timeout 45000ms exceeded.\nCall log:\n  - navigating to "https://webapps2.rrc.texas.gov/PDA/ice/pdaIceHome.xhtml", waiting until "networkidle"\n=========================== logs ===========================\n  "domcontentloaded" event fired')).toBe("TRRC did not respond within 45 s");
    expect(plainSourceError("TimeoutError: The operation was aborted due to timeout")).toBe("TRRC did not respond in time");
    expect(plainSourceError("TypeError: fetch failed")).toBe("Connection to TRRC failed");
    expect(plainSourceError("Operator number required for inactive well lookup — not resolved yet")).toBe("Operator number required for inactive well lookup — not resolved yet");
    expect(plainSourceError(null)).toBe("Query failed");
  });
  it("keeps raw logs out of the readiness reason", () => {
    const c = regulatoryCoverage([attempt("fetch_compliance_violations", {}, "failed_transient")].map(a => ({ ...a, error_message: "TimeoutError: page.goto: Timeout 45000ms exceeded.\nCall log:\n  - navigating to x" })));
    expect(c[0].reason).toBe("TRRC did not respond within 45 s");
  });
});
