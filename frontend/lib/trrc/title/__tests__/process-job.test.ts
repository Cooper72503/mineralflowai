import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("../ingest", () => ({ ingestPendingDocuments: vi.fn() }));
vi.mock("../supersede-index", () => ({ supersedeIndexedCopies: vi.fn() }));
vi.mock("../lease-associations", () => ({ propagateLeaseAssociations: vi.fn() }));
vi.mock("../link-claims", () => ({ linkUnmatchedClaims: vi.fn() }));
vi.mock("../analysis", () => ({ runTitleChainAnalysis: vi.fn() }));
import { processTitleJob } from "../process-job";
import { ingestPendingDocuments } from "../ingest";
import { runTitleChainAnalysis } from "../analysis";
function db(fail = false) {
  const patches: Record<string, unknown>[] = [];
  const q = { update: (p: Record<string, unknown>) => { patches.push(p); return q; }, eq: () => q, neq: () => q,
    select: async () => ({ data: [{ id: "j" }], error: fail ? { message: "write refused" } : null }) };
  return { client: { from: () => q } as never, patches };
}
beforeEach(() => { vi.clearAllMocks(); });
describe("automatic title processing", () => {
  it("does not publish when a bounded ingestion pass leaves documents unread", async () => {
    vi.mocked(ingestPendingDocuments).mockResolvedValue({ processed: 0, instrumentsCreated: 0, errors: [], remaining: 6 } as never);
    const d = db(); const r = await processTitleJob(d.client, "j", "u");
    expect(r.error).toContain("6 retrieved documents");
    expect(runTitleChainAnalysis).not.toHaveBeenCalled();
    expect(d.patches.at(-1)?.status).toBe("failed");
  });
  it("stops before OCR or publication when the stage cannot be persisted", async () => {
    await expect(processTitleJob(db(true).client, "j", "u")).rejects.toThrow("write refused");
    expect(ingestPendingDocuments).not.toHaveBeenCalled(); expect(runTitleChainAnalysis).not.toHaveBeenCalled();
  });
  it("keeps processing active until the entire retrieved set is read", async () => {
    vi.mocked(ingestPendingDocuments).mockResolvedValueOnce({ processed: 3, instrumentsCreated: 3, errors: [], remaining: 3 } as never).mockResolvedValueOnce({ processed: 3, instrumentsCreated: 3, errors: [], remaining: 0 } as never);
    vi.mocked(runTitleChainAnalysis).mockResolvedValue({ ok: true, analysis: { analysisId: "a", status: "POTENTIAL_GAPS_DETECTED" } } as never);
    const d = db(); const r = await processTitleJob(d.client, "j", "u");
    expect(r.documentsRead).toBe(6); expect(r.analysisId).toBe("a");
    expect(d.patches.filter(p => p.status).map(p => p.status)).toEqual(["ingesting", "analyzing"]);
  });
});
