import { describe, it, expect } from "vitest";
import { linkUnmatchedClaims } from "../link-claims";
const tract = (id: string, section = "37") => ({ id, county: "MIDLAND", abstract_number: "A-236", survey_name: "T&P RR", section_name: section, block_number: "39 T4S", match_status: "confirmed" });
function db(canon: unknown[], instruments: unknown[], failure?: string) {
  const writes: string[] = [];
  return { writes, client: { from(table: string) {
    let mutation = false;
    const q = { select: () => q, eq: () => q, neq: () => q, is: () => q, order: () => q, range: () => q, in: () => q,
      update: () => { mutation = true; writes.push(table); return q; },
      then: (resolve: (v: unknown) => void) => Promise.resolve(resolve({ data: mutation ? [] : table === "title_canonical_tracts" ? canon : instruments, error: failure === table ? { message: "database unavailable" } : null })) };
    return q;
  } } as never };
}
describe("claim linking fail-closed", () => {
  it("throws on incomplete database reads rather than publishing an empty chain", async () => {
    const d = db([], [], "title_canonical_tracts");
    await expect(linkUnmatchedClaims(d.client, "j")).rejects.toThrow("read failed");
    expect(d.writes).toEqual([]);
  });
  it("does not choose one of multiple canonical tracts sharing an abstract", async () => {
    const d = db([tract("a"), tract("b", "25")], [{ id: "i", county: "MIDLAND", abstract_number: "A-236" }]);
    expect(await linkUnmatchedClaims(d.client, "j")).toBe(0); expect(d.writes).toEqual([]);
  });
  it("does not override an explicit township conflict with an abstract match", async () => {
    const d = db([tract("a")], [{ id: "i", county: "MIDLAND", abstract_number: "A-236", block_number: "39 T3S", section_name: "37" }]);
    expect(await linkUnmatchedClaims(d.client, "j")).toBe(0);
  });
  it("does not mark a tract linked when claim persistence failed", async () => {
    const d = db([tract("a")], [{ ...tract("i"), match_status: undefined }], "title_claims");
    await expect(linkUnmatchedClaims(d.client, "j")).rejects.toThrow("claim linking failed");
    expect(d.writes).toEqual(["title_claims"]);
  });
  it("links a uniquely matched tract and its claims", async () => {
    const d = db([tract("a")], [tract("i")]);
    expect(await linkUnmatchedClaims(d.client, "j")).toBe(1);
    expect(d.writes).toEqual(["title_claims", "title_instrument_tracts"]);
  });
});
