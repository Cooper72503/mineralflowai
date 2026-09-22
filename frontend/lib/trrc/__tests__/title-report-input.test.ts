import { it, expect, vi, beforeEach } from "vitest";
import { loadTitleForReport } from "../title/report-input";
import { loadJobBundle } from "../title/job-store";
import { loadReviewedPosition } from "../gold2/position-link";

vi.mock("../title/job-store", () => ({ loadJobBundle: vi.fn() }));
vi.mock("../gold2/position-link", () => ({ loadReviewedPosition: vi.fn() }));

function db(tables: Record<string, { data: unknown; error: unknown }>) {
  const filters: unknown[] = [];
  return {
    filters,
    from: (name: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const q: any = {
        select: () => q,
        eq: (...v: unknown[]) => { filters.push([name, ...v]); return q; },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        then: (resolve: any) => Promise.resolve(tables[name] ?? { data: [], error: null }).then(resolve),
      };
      return q;
    },
  };
}

const emptyBundle = {
  job: { id: "job", status: "complete", stage_detail: "analysis complete" },
  wells: [], tracts: [], associations: [], documents: [], reviewItems: [], searchLog: [],
  latestAnalysis: null,
};

beforeEach(() => {
  vi.mocked(loadReviewedPosition).mockResolvedValue({ position: null, reason: "no reviewed position" } as never);
});

it("states the create-run linkage warning instead of an unexplained blank", async () => {
  const r = await loadTitleForReport(db({}) as never, "owner", null, "MASK HZ UNIT", "Multiple live scopes");
  expect(r.status).toBe("no_job");
  expect(r.headline).toContain("Multiple live scopes");
  expect(r.ownership).toBeNull();
});

it("never reports ownership without a reviewed position, even with a published analysis", async () => {
  vi.mocked(loadJobBundle).mockResolvedValue({
    ...emptyBundle,
    latestAnalysis: { id: "a", version: 3, status_classification: "POTENTIAL_GAPS_DETECTED", analysis_json: { wells: [{ api14: "42165027330000" }] }, created_at: "" },
  } as never);
  const r = await loadTitleForReport(db({}) as never, "owner", "job", "MASK HZ UNIT");
  expect(r.status).toBe("analyzed");
  expect(r.analysis?.version).toBe(3);
  expect(r.ownership).toBeNull();
  expect(r.ownershipReason).toContain("no reviewed position");
});

it("separates instruments that were read from index-only leads, and scopes every read to the job", async () => {
  vi.mocked(loadJobBundle).mockResolvedValue(emptyBundle as never);
  const d = db({
    title_instruments: { data: [
      { id: "i1", instrument_type: "mineral_deed", instrument_number: "39265019", doc_number: "39265019", recorded_date: "1998-04-02", instrument_content_verified: true },
      { id: "i2", instrument_type: "assignment", instrument_number: null, doc_number: "40113887", recorded_date: "2004-11-18", instrument_content_verified: false },
    ], error: null },
    title_instrument_parties: { data: [
      { instrument_id: "i1", party_name: "SMITH, J R", role: "grantor" },
      { instrument_id: "i1", party_name: "MASK ROYALTY PARTNERS LP", role: "grantee" },
    ], error: null },
    title_instrument_tracts: { data: [
      { instrument_id: "i1", legal_description: "MASK HZ UNIT, SEC 12 BLK A-21" },
      { instrument_id: "i2", legal_description: "SEC 7 BLK A-22 PSL SURVEY" },
    ], error: null },
  });
  const r = await loadTitleForReport(d as never, "owner", "job", "MASK HZ UNIT");
  expect(r.totalIndexRows).toBe(2);
  expect(r.verifiedInstrumentCount).toBe(1);
  // Subject-matched lead leads the list; the non-matching one is carried but not counted as subject.
  expect(r.subjectMatchedCount).toBe(1);
  expect(r.subjectLeads[0].instrumentNumber).toBe("39265019");
  expect(r.subjectLeads[0].grantor).toBe("SMITH, J R");
  // doc_number is the fallback when a county index row has no instrument_number.
  expect(r.subjectLeads[1].instrumentNumber).toBe("40113887");
  for (const table of ["title_instruments", "title_instrument_parties", "title_instrument_tracts"]) {
    expect(d.filters).toContainEqual([table, "job_id", "job"]);
  }
});

it("degrades to a stated status rather than throwing when the title record cannot be read", async () => {
  vi.mocked(loadJobBundle).mockRejectedValue(new Error("offline"));
  const r = await loadTitleForReport(db({}) as never, "owner", "job", "MASK HZ UNIT");
  expect(r.status).toBe("unavailable");
  expect(r.ownershipReason).toContain("not established");
});
