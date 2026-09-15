import { afterEach, describe, expect, it, vi } from "vitest";
import { getProduction } from "../tools/ewa.js";

afterEach(() => vi.unstubAllGlobals());
function responses(posts: { text: string; status?: number }[]) {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method !== "POST") return new Response("<form></form>");
    const next = posts.shift();
    if (!next) throw new Error("Unexpected extra POST");
    return new Response(next.text, { status: next.status ?? 200 });
  }));
}
describe("production source outcome classification", () => {
  it("keeps a rejected type distinct from an accepted empty query", async () => {
    // Minimal messages captured from RRC specificLeaseQueryAction.do on 2026-09-09.
    responses([
      { text: '<font color=red>(Ewa_117) No results found.</font>' },
      { text: '<font color=red>(Ewa_1011) Invalid lease number.</font>' },
    ]);
    const result = await getProduction("00432", "02");
    expect(result.error).toContain("Confirm lease type");
    expect(result.lease_type_attempts?.map(a => a.status)).toEqual(["not_found", "query_rejected"]);
  });
  it("does not turn HTTP failure into confirmed absence", async () => {
    // A 5xx is retried (bounded, see fetchWithRetry) — the mock must answer
    // every attempt with the same 503 so the persistent failure still
    // surfaces as an error rather than a confirmed absence.
    responses([{ text: "No results found", status: 503 }, { text: "No results found", status: 503 }, { text: "No results found", status: 503 }]);
    expect((await getProduction("00432", "02", "O")).error).toContain("503");
  });
  it("rejects malformed volumes instead of accepting numeric prefixes", async () => {
    responses([{ text: '<table class="DataGrid"><tr><td>Jan 2026</td><td>120bad</td><td>0</td><td>0</td><td>0</td></tr></table>' }]);
    expect((await getProduction("00432", "02", "O")).error).toContain("Invalid production volume");
  });
});

import { getGisLocation } from "../tools/ewa.js";
it("rejects a GIS feature for a different API", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ features: [{ attributes: { API: "43934308" }, geometry: { x: -97, y: 32 } }] })));
  expect((await getGisLocation("4216502733")).error).toContain("requested API");
});
it("preserves a verified location while disclosing failed subsidiary GIS queries", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("/1/query")
    ? Response.json({ features: [{ attributes: { API: "16502733" }, geometry: { x: -102, y: 32 } }] })
    : Response.json({ error: { message: "Service unavailable" } })));
  const result = await getGisLocation("4216502733");
  expect(result.found).toBe(true);
  expect(result.partial_errors).toHaveLength(2);
  expect(result.survey).toBeNull();
  expect(result.message).toContain("Partial GIS result");
});
