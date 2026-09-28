import { it, expect, vi, beforeEach, describe } from "vitest";
import { NextRequest } from "next/server";
import { POST, GET as LIST } from "../route";
import { GET as REPORT, POST as RECORD } from "../[packageId]/report/route";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";
import { loadDeal, summarizeDeal } from "@/lib/trrc/deal/build";
import { renderDealPdf } from "@/lib/trrc/deal/pdf";
import { renderDecisionRecordPdf } from "@/lib/trrc/deal/decision-record-pdf";
import { applyAssumptionEdits, assembleDecision } from "@/lib/trrc/deal/decision-layer";

vi.mock("@/lib/supabase/from-route-request", () => ({ createSupabaseFromRouteRequest: vi.fn() }));
vi.mock("@/lib/trrc/source-registry", () => ({ isTrrcDdEnabled: () => true }));
vi.mock("@/lib/trrc/deal/build", () => ({ loadDeal: vi.fn(), summarizeDeal: vi.fn() }));
vi.mock("@/lib/trrc/deal/pdf", () => ({ renderDealPdf: vi.fn() }));
vi.mock("@/lib/trrc/deal/decision-record-pdf", () => ({ renderDecisionRecordPdf: vi.fn() }));
vi.mock("@/lib/trrc/deal/decision-layer", () => ({ applyAssumptionEdits: vi.fn(), assembleDecision: vi.fn() }));

const pkg = "00000000-0000-4000-8000-000000000001";
const key = "00000000-0000-4000-8000-000000000002";
const params = { params: Promise.resolve({ packageId: pkg }) };
beforeEach(() => vi.resetAllMocks());

function db(auth = true) {
  const rpc = vi.fn(async () => ({ data: pkg, error: null }));
  const filters: unknown[] = [];
  const q: Record<string, unknown> = {
    select: () => q, order: () => q, limit: async () => ({ data: [{ id: pkg, status: "evidence_ready", created_at: "2026-09-26T20:00:00Z", updated_at: "x", members_json: [{ input: "42-317-43016" }, { input: "42-317-44443" }] }], error: null }),
    eq: (...a: unknown[]) => { filters.push(a); return q; },
  };
  vi.mocked(createSupabaseFromRouteRequest).mockResolvedValue({ auth: { getUser: async () => ({ data: { user: auth ? { id: "owner" } : null }, error: null }) }, rpc, from: () => q } as never);
  return { rpc, filters };
}
const get = (url: string) => new NextRequest(`http://localhost${url}`);

describe("engine intake", () => {
  it("accepts API numbers with no other inputs and queues one package", async () => {
    const { rpc } = db();
    const r = await POST(new NextRequest("http://localhost/api/trrc/due-diligence/packages", { method: "POST", body: JSON.stringify({ requestKey: key, inputs: ["42-317-43016", "42-317-44443"], options: {} }) }));
    expect(r.status).toBe(202);
    expect(rpc).toHaveBeenCalledWith("enqueue_api_package", expect.objectContaining({ p_key: key, p_options: {} }));
    const entries = (rpc.mock.calls[0] as unknown as [string, { p_entries: { api10: string }[] }])[1].p_entries;
    expect(entries.map(e => e.api10)).toEqual(["4231743016", "4231744443"]);
  });
  it("lists only the signed-in user's recent deals", async () => {
    const { filters } = db();
    const r = await LIST(get("/api/trrc/due-diligence/packages"));
    const body = await r.json();
    expect(body.data[0]).toMatchObject({ id: pkg, status: "evidence_ready", apiCount: 2, firstInputs: ["42-317-43016", "42-317-44443"] });
    expect(filters).toContainEqual(["user_id", "owner"]);
  });
  it("requires sign-in for the list", async () => {
    db(false);
    expect((await LIST(get("/api/trrc/due-diligence/packages"))).status).toBe(401);
  });
});

describe("engine report", () => {
  it("answers 409 with the stage while work is running", async () => {
    db();
    vi.mocked(loadDeal).mockResolvedValue({ ready: false, reason: "Retrieving public records: 3 of 12 wells complete.", progress: { complete: 3, total: 12 } });
    const r = await REPORT(get(`/api/x?format=summary`), params);
    expect(r.status).toBe(409);
    expect((await r.json()).error).toContain("3 of 12");
  });
  it("returns the on-screen decision when ready", async () => {
    db();
    vi.mocked(loadDeal).mockResolvedValue({ ready: true, deal: { packageId: pkg } as never });
    vi.mocked(summarizeDeal).mockReturnValue({ verdict: "BUY" } as never);
    const r = await REPORT(get(`/api/x?format=summary`), params);
    expect(r.status).toBe(200);
    expect((await r.json()).summary.verdict).toBe("BUY");
    expect(renderDealPdf).not.toHaveBeenCalled();
  });
  const deal = { packageId: pkg, generatedAt: "2026-09-26T20:00:00Z", leases: [{ key: "TX:8:O:1", leaseName: "WASHINGTON 5" }] };
  const starting = { "TX:8:O:1": { assumptions: { oilPriceUsdBbl: 80 }, basis: { oilPriceUsdBbl: "EIA" }, edited: [] } };
  it("downloads the Decision Record under the starting assumptions", async () => {
    db();
    vi.mocked(loadDeal).mockResolvedValue({ ready: true, deal: deal as never });
    vi.mocked(applyAssumptionEdits).mockReturnValue({ errors: [], byLease: starting as never });
    vi.mocked(renderDecisionRecordPdf).mockResolvedValue(Buffer.from("%PDF-test"));
    const r = await REPORT(get(`/api/x`), params);
    expect(r.headers.get("Content-Type")).toBe("application/pdf");
    expect(r.headers.get("Content-Disposition")).toContain("MineralFlow-WASHINGTON-5-Decision-Record-2026-09-26.pdf");
    expect(applyAssumptionEdits).toHaveBeenCalledWith(deal, {});
    expect(renderDealPdf).not.toHaveBeenCalled();
  });
  it("still serves the acquisition report on request", async () => {
    db();
    vi.mocked(loadDeal).mockResolvedValue({ ready: true, deal: deal as never });
    vi.mocked(renderDealPdf).mockResolvedValue(Buffer.from("%PDF-test"));
    const r = await REPORT(get(`/api/x?format=acquisition`), params);
    expect(r.headers.get("Content-Disposition")).toContain("Acquisition-Report");
  });
  it("returns the deal with each lease's starting assumptions and basis", async () => {
    db();
    vi.mocked(loadDeal).mockResolvedValue({ ready: true, deal: deal as never });
    vi.mocked(applyAssumptionEdits).mockReturnValue({ errors: [], byLease: starting as never });
    const body = await (await REPORT(get(`/api/x?format=engine`), params)).json();
    expect(body.starting["TX:8:O:1"]).toEqual({ assumptions: { oilPriceUsdBbl: 80 }, basis: { oilPriceUsdBbl: "EIA" } });
  });
  it("generates the Decision Record under the user's assumptions, and refuses invalid ones", async () => {
    db();
    vi.mocked(loadDeal).mockResolvedValue({ ready: true, deal: deal as never });
    vi.mocked(renderDecisionRecordPdf).mockResolvedValue(Buffer.from("%PDF-test"));
    const edits = { "TX:8:O:1": { oilPriceUsdBbl: 65 } };
    vi.mocked(applyAssumptionEdits).mockReturnValue({ errors: [], byLease: { "TX:8:O:1": { assumptions: { oilPriceUsdBbl: 65 }, basis: {}, edited: ["oilPriceUsdBbl"] } } as never });
    const post = (b: unknown) => new NextRequest("http://localhost/api/x", { method: "POST", body: JSON.stringify(b) });
    const ok = await RECORD(post({ assumptions: edits }), params);
    expect(ok.status).toBe(200);
    expect(applyAssumptionEdits).toHaveBeenCalledWith(deal, edits);
    expect(assembleDecision).toHaveBeenCalledWith(deal, { "TX:8:O:1": { oilPriceUsdBbl: 65 } });
    expect(vi.mocked(renderDecisionRecordPdf).mock.calls[0][0].editedByLease).toEqual({ "TX:8:O:1": ["oilPriceUsdBbl"] });
    vi.mocked(applyAssumptionEdits).mockReturnValue({ errors: ["WASHINGTON 5: Oil price must be greater than zero."], byLease: {} });
    const bad = await RECORD(post({ assumptions: { "TX:8:O:1": { oilPriceUsdBbl: 0 } } }), params);
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toContain("Oil price must be greater than zero");
    expect((await RECORD(post({ assumptions: "x" }), params)).status).toBe(400);
  });
  it("rejects bad overrides and unknown packages", async () => {
    db();
    vi.mocked(applyAssumptionEdits).mockReturnValue({ errors: [], byLease: {} });
    expect((await REPORT(get(`/api/x?oil=-5`), params)).status).toBe(400);
    vi.mocked(loadDeal).mockRejectedValue(Error("Package not found."));
    expect((await REPORT(get(`/api/x`), params)).status).toBe(404);
  });
  it("requires sign-in", async () => {
    db(false);
    expect((await REPORT(get(`/api/x`), params)).status).toBe(401);
    expect(loadDeal).not.toHaveBeenCalled();
  });
});
