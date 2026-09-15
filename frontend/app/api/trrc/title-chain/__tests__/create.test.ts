import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
const { rpc, from, getUser } = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), getUser: vi.fn() }));
vi.mock("@/lib/supabase/from-route-request", () => ({ createSupabaseFromRouteRequest: async () => ({ rpc, from, auth: { getUser } }) }));
import { POST } from "../route";
const request = (body: unknown) => new NextRequest("https://example.test/api/trrc/title-chain", { method: "POST", body: JSON.stringify(body) });
beforeEach(() => { vi.clearAllMocks(); getUser.mockResolvedValue({ data: { user: { id: "owner" } }, error: null }); rpc.mockResolvedValue({ data: { id: "job-1", status: "pending" }, error: null }); });
describe("atomic title job creation", () => {
  it("sends the job and deduplicated wells through one atomic RPC", async () => {
    const res = await POST(request({ apiNumbers: ["42-165-02733", "4216502733"] }));
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledTimes(1);
    const [name, args] = rpc.mock.calls[0];
    expect(name).toBe("create_title_research_job");
    expect(args.p_wells).toHaveLength(1);
    expect(args.p_wells[0].api10).toBe("4216502733");
    expect(args.p_job.user_id).toBeUndefined(); // DB derives authenticated owner.
    expect(from).not.toHaveBeenCalled();
  });
  it("does not fall back to the racy insertion sequence if the migration is absent", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "function missing" } });
    const res = await POST(request({ apiNumbers: "4216502733" }));
    expect(res.status).toBe(503); expect(from).not.toHaveBeenCalled();
    expect((await res.json()).ok).toBe(false);
  });
  it("does not publish without authentication", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: null });
    expect((await POST(request({ apiNumbers: "4216502733" }))).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });
});
