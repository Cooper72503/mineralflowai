import { expect, it, vi } from "vitest";
import { processMineralFinder } from "../mineral-finder-jobs.js";
function database(
  claim: any = {
    id: "job",
    claim_token: "token",
    request_json: { criteria: { county: "GAINES" }, query: "research" },
  },
  saved = true,
) {
  const writes: any[] = [],
    filters: any[] = [];
  const db: any = {
    rpc: vi.fn(async (name: string) => ({
      data: name === "claim_mineral_finder" ? (claim ? [claim] : []) : saved,
      error: null,
    })),
    from: () => {
      const q: any = {
        update: (p: any) => {
          writes.push(p);
          return q;
        },
        eq: (k: any, v: any) => {
          filters.push([k, v]);
          return q;
        },
        select: async () => ({ data: [{ id: "job" }], error: null }),
      };
      return q;
    },
  };
  return { db, writes, filters };
}
it("does no external work when no job was claimed", async () => {
  const { db } = database(null);
  const engine = vi.fn();
  await processMineralFinder(db, engine);
  expect(engine).not.toHaveBeenCalled();
});
it("publishes only with its claim token and reports the research classification", async () => {
  const { db, filters } = database();
  const result = {
    prospects: [],
    wells: 10,
    classification: "research_screening",
  };
  await processMineralFinder(db, async (_, __, ___, adapters) => {
    await adapters.progress("Reading evidence");
    return result;
  });
  expect(filters).toContainEqual(["claim_token", "token"]);
  expect(db.rpc).toHaveBeenCalledWith("finish_mineral_finder", {
    p_id: "job",
    p_token: "token",
    p_result: result,
  });
});
it("does not publish a failed source run as complete", async () => {
  const { db, writes } = database();
  await processMineralFinder(db, async () => {
    throw Error("Truncated official CSV");
  });
  expect(db.rpc).toHaveBeenCalledTimes(1);
  expect(writes.at(-1)).toMatchObject({
    status: "failed",
    error_summary: "Truncated official CSV",
  });
});
it("records a rejected stale publication instead of reporting success", async () => {
  const { db, writes } = database(undefined, false);
  await processMineralFinder(db, async () => ({ prospects: [], wells: 10 }));
  expect(writes.at(-1).status).toBe("failed");
});
