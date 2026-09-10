/**
 * SOURCE FRESHNESS WIRING.
 *
 * Freshness only means something if each source is graded against its own
 * retrieval time. An earlier version of the live path stamped every entry with
 * the job row's updated_at, which made all three sources the same age and
 * permanently current — the grading ran, but against a timestamp that had
 * nothing to do with when the source was fetched.
 *
 * These tests pin the two properties that failure violated:
 *   1. a source that was never retrieved is missing, not current;
 *   2. sources retrieved at different times do not share an age.
 */
import { describe, it, expect } from "vitest";
import { latestTimestamp, freshnessOf } from "../analysis";
import { gradeFreshness } from "../decision-record";

const AS_OF = "2026-10-01";

describe("latestTimestamp", () => {
  it("returns the most recent timestamp, ignoring nulls", () => {
    expect(latestTimestamp(["2026-08-04", null, "2026-09-29", undefined])).toBe("2026-09-29");
  });
  it("returns null when nothing was retrieved", () => {
    expect(latestTimestamp([])).toBeNull();
    expect(latestTimestamp([null, undefined])).toBeNull();
  });
});

describe("source freshness is graded per source", () => {
  it("reports a never-retrieved source as missing, never as current", () => {
    const [entry] = gradeFreshness([freshnessOf("Vendor analytics", "vendor", AS_OF, null, "Not retrieved", 45, "")], AS_OF);
    expect(entry.status).toBe("missing");
    expect(entry.retrievedAt).toBeNull();
    expect(entry.ageDays).toBeNull();
  });

  it("gives sources retrieved at different times different ages", () => {
    const graded = gradeFreshness([
      freshnessOf("County clerk instruments", "county", AS_OF, "2026-09-29", "9 document(s)", 30, ""),
      freshnessOf("State regulator", "regulator", AS_OF, "2026-08-04", "6 query(s)", 30, ""),
    ], AS_OF);
    const [county, regulator] = graded;

    expect(county.ageDays).toBe(2);
    expect(regulator.ageDays).toBe(58);
    expect(county.ageDays).not.toBe(regulator.ageDays);

    // And the older one crosses its own window while the newer one does not.
    expect(county.status).toBe("current");
    expect(regulator.status).toBe("stale");
  });

  it("does not let one source's retrieval time speak for another", () => {
    const sameStamp = gradeFreshness([
      freshnessOf("County clerk instruments", "county", AS_OF, "2026-09-30", "1 document(s)", 30, ""),
      freshnessOf("State regulator", "regulator", AS_OF, "2026-09-30", "0 query(s)", 30, ""),
    ], AS_OF);
    // Identical ages are only legitimate when the timestamps really are equal.
    expect(new Set(sameStamp.map(f => f.retrievedAt)).size).toBe(1);
    expect(new Set(sameStamp.map(f => f.ageDays)).size).toBe(1);
  });
});
