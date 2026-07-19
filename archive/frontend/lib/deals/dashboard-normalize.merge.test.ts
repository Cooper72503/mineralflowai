import { describe, expect, it } from "vitest";
import { mergeStructuredFields } from "./dashboard-normalize";

describe("mergeStructuredFields", () => {
  it("does not let null from structured_data wipe good values from structured_json", () => {
    const merged = mergeStructuredFields(
      { acreage: null, county: null, deal_score: { score: null } },
      { acreage: 24, county: "Stark", deal_score: { score: 80, reasons: ["ok"] } }
    );
    expect(merged.acreage).toBe(24);
    expect(merged.county).toBe("Stark");
    const ds = merged.deal_score as Record<string, unknown>;
    expect(ds.score).toBe(80);
    expect(Array.isArray(ds.reasons)).toBe(true);
  });

  it("still prefers structured_data when it has real values", () => {
    const merged = mergeStructuredFields(
      { acreage: 40, county: "Ward" },
      { acreage: 10, county: "Reeves" }
    );
    expect(merged.acreage).toBe(40);
    expect(merged.county).toBe("Ward");
  });
});
