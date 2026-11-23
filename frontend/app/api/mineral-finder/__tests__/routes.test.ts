import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const { getUser, rpc, from } = vi.hoisted(() => ({
  getUser: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
}));
vi.mock("@/lib/supabase/from-route-request", () => ({
  createSupabaseFromRouteRequest: async () => ({
    auth: { getUser },
    rpc,
    from,
  }),
}));
import { POST } from "../route";
import { GET } from "../[runId]/route";
const body = {
  requestKey: "00000000-0000-4000-8000-000000000001",
  query: "Find plugged wells in Gaines County before 1995",
};
const req = (b: unknown = body) =>
  new NextRequest("https://example.test/api/mineral-finder", {
    method: "POST",
    body: JSON.stringify(b),
  });
beforeEach(() => {
  vi.clearAllMocks();
  process.env.MINERAL_FINDER_ENABLED = "true";
  getUser.mockResolvedValue({ data: { user: { id: "owner" } }, error: null });
  rpc.mockResolvedValue({ data: "job", error: null });
});
describe("Mineral Finder ownership boundaries", () => {
  it("rejects unauthenticated submission", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: null });
    expect((await POST(req())).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("requires explicit feature enablement", async () => {
    delete process.env.MINERAL_FINDER_ENABLED;
    expect((await POST(req())).status).toBe(503);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("validates filters and queues atomically under authenticated ownership", async () => {
    const r = await POST(req());
    expect(r.status).toBe(202);
    expect(rpc).toHaveBeenCalledWith("enqueue_mineral_finder", {
      p_key: body.requestKey,
      p_request: {
        query: body.query,
        criteria: expect.objectContaining({
          county: "GAINES",
          beforeYear: 1995,
        }),
      },
    });
    expect(from).not.toHaveBeenCalled();
  });
  it.each([
    { ...body, criteria: { radiusMiles: 10000 } },
    { ...body, query: "Brown County" },
    { ...body, user_id: "other" },
  ])(
    "rejects unsupported requests instead of changing scope: %j",
    async (input) => {
      expect((await POST(req(input))).status).toBe(400);
      expect(rpc).not.toHaveBeenCalled();
    },
  );
  it("reports failed intake and never falls back to a service-role insert", async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { message: "RPC unavailable" },
    });
    expect((await POST(req())).status).toBe(503);
    expect(from).not.toHaveBeenCalled();
  });
  it("binds reads to the signed-in owner and hides another account's run", async () => {
    const q: any = {
      select: vi.fn(() => q),
      eq: vi.fn(() => q),
      maybeSingle: vi.fn(async () => ({ data: null, error: null })),
    };
    from.mockReturnValue(q);
    const r = await GET(
      new NextRequest("https://example.test/api/mineral-finder/id"),
      { params: { runId: body.requestKey } },
    );
    expect(q.eq).toHaveBeenCalledWith("user_id", "owner");
    expect(r.status).toBe(404);
  });
});
