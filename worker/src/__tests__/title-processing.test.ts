import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("../title-sequencer.js", () => ({ searchCountyRecordsForJob: vi.fn(), defaultDeps: {} }));
import { searchCountyRecordsForJob } from "../title-sequencer.js";
import { processRetrievedTitleJob } from "../title-processing.js";
function database(status = "ingesting", pending = true) {
  const wells = Array.from({ length: 12 }, (_, i) => ({ id: `w${i}`, county_name: "MIDLAND", lease_name: "CMC BUTTERCUP 25-37 UNIT" }));
  const client = { from(table: string) {
    const result = { data: table === "title_research_jobs" ? { status, user_id: "u" } : table === "title_job_wells" ? wells : pending ? [{ id: "document" }] : [], error: null };
    const q = { select: () => q, eq: () => q, limit: () => q, maybeSingle: async () => result, then: (resolve: (r: unknown) => void) => Promise.resolve(resolve(result)) };
    return q;
  } } as never;
  return { client, wells };
}
beforeEach(() => vi.clearAllMocks());
describe("worker to shared title engine handoff", () => {
  it("wires job-wide county rediscovery with the current twelve wells", async () => {
    const d = database();
    const engine = vi.fn(async (_db, _id, _user, options) => {
      expect(await options.discoverAfterIngestion()).toBe(true);
      return { documentsRead: 1, instrumentsCreated: 1, extractionErrors: 0, analysisId: "a", classification: "POTENTIAL_GAPS_DETECTED", error: null };
    });
    const budget = { remaining: 12 };
    await processRetrievedTitleJob(d.client, "j", engine, budget);
    expect(searchCountyRecordsForJob).toHaveBeenCalledTimes(1);
    // Discovery reads within the same run's image budget as the first retrieval.
    expect(searchCountyRecordsForJob).toHaveBeenCalledWith(d.client, {}, "j", "u", d.wells, budget);
  });
  it.each(["cancelled", "failed", "complete"])("does not process a %s job", async status => {
    const engine = vi.fn();
    expect(await processRetrievedTitleJob(database(status).client, "j", engine)).toBeNull();
    expect(engine).not.toHaveBeenCalled();
  });
});
