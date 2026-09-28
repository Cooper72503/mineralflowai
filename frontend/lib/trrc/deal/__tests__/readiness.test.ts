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
  it("detects missing calendar months even when the server omitted rows entirely", () => {
    expect(unreportedMonths("2026-01", "2026-09-28")).toBe(7);
    expect(unreportedMonths("2024-01", "2026-09-28")).toBe(31);
    expect(unreportedMonths("2026-08", "2026-09-28")).toBe(0);
    expect(unreportedMonths("2026-13", "2026-09-28")).toBeNull();
    expect(unreportedMonths("2027-01", "2026-09-28")).toBeNull();
  });
});
