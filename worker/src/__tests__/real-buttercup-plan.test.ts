/** Verification against the REAL Buttercup well rows (job 31f9fe66), not a
 *  hand-written fixture: 12 wells sharing one lease, survey/abstract present
 *  on exactly one of them, operator carrying TRRC's spaced-period spelling. */
import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { searchCountyRecordsForJob, type TitleJobDeps } from "../title-sequencer.js";

vi.mock("../tools/browser.js", () => ({ getCodaDocuments: vi.fn(), getBrowser: vi.fn(), closeBrowser: vi.fn() }));
vi.mock("../tools/ewa.js", () => ({ searchWellbore: vi.fn(), getGisLocation: vi.fn(), getDrillingPermits: vi.fn(), getCompletionRecords: vi.fn(), PDA_BASE: "x" }));

type Row = Record<string, unknown>;
function makeSupabase() {
  const store: Record<string, Row[]> = { title_search_log: [], title_review_items: [], title_instruments: [], title_research_jobs: [{ id: "job-1", limitations_json: [] }] };
  const builder = (table: string) => {
    const filters: Array<[string, unknown]> = [];
    let mode = "select"; let payload: Row | Row[] | null = null;
    const q: Record<string, unknown> = {
      select: () => q, limit: () => q, order: () => q, single: () => q, maybeSingle: () => q,
      eq: (k: string, v: unknown) => { filters.push([k, v]); return q; },
      in: () => q, neq: () => q, range: () => q,
      is: (k: string, v: unknown) => { filters.push([k, v === null ? undefined : v]); return q; },
      delete: () => { mode = "delete"; return q; },
      insert: (v: Row | Row[]) => { mode = "insert"; payload = v; return q; },
      update: (v: Row) => { mode = "update"; payload = v; return q; },
      upsert: (v: Row) => { mode = "upsert"; payload = v; return q; },
      then: (res: (x: unknown) => unknown) => {
        store[table] ??= [];
        if (mode === "insert" || mode === "upsert") {
          const rows = (Array.isArray(payload) ? payload : [payload!]).map((r, i) => ({ id: `${table}-${store[table].length + i}`, ...r }));
          store[table].push(...rows);
          return Promise.resolve(res({ data: rows, error: null }));
        }
        if (mode === "update" || mode === "delete") return Promise.resolve(res({ data: [], error: null }));
        return Promise.resolve(res({ data: store[table].filter(r => filters.every(([k, v]) => r[k] === v)), error: null }));
      },
    };
    return q;
  };
  return { supabase: { from: (t: string) => builder(t), storage: { from: () => ({ upload: async () => ({ error: null }) }) } } as unknown as SupabaseClient, store };
}

// Exactly what the database holds for job 31f9fe66.
const base = { county_name: "Midland", resolution_status: "resolved", operator_name: "CHEVRON U. S. A. INC.", lease_name: "CMC BUTTERCUP 25-37 UNIT", api14: null, survey_name: null as string | null, abstract_number: null as string | null };
const APIS = ["4232946216","4232946217","4232946218","4232946219","4232946220","4232946221","4232946771","4232946772","4232946773","4232946774","4232946775","4232946776"];
const realWells = APIS.map(api => ({ id: api, api10: api,
  ...base,
  ...(api === "4232946772" ? { survey_name: "T&P RR CO", abstract_number: "A-329236" } : {}) }));

describe("real Buttercup search plan", () => {
  it("issues the discovery variants once across 12 shared-lease wells, within budget", async () => {
    const { supabase, store } = makeSupabase();
    const seen: string[] = [];
    const getCountyRecords = vi.fn(async (_c: string, value: string) => { seen.push(value); return { found: false, status: "automated" as const, county: "Midland", provider: "publicsearch_us", records: [], total_count: 0, search_url: "https://x", message: "none" }; });
    const deps = { getCountyRecords, findProvider: () => ({ provider: { id: "publicsearch_us", name: "PublicSearch", counties: {}, search: vi.fn() }, identifier: "midland", displayName: "Midland" }) } as unknown as TitleJobDeps;

    await searchCountyRecordsForJob(supabase, deps, "job-1", "user-1", realWells as never);

    process.stderr.write("QUERIES ISSUED:\n" + seen.map((s, i) => `  ${i + 1}. ${s}`).join("\n") + "\n");
    expect(seen.length).toBe(new Set(seen).size);              // no duplicates across 12 wells
    expect(seen).toContain("CMC BUTTERCUP 25-37 UNIT");        // original
    expect(seen).toContain("CMC BUTTERCUP 25 37 UNIT");        // punctuation-stripped variant
    expect(seen).toContain("BUTTERCUP");                       // distinctive discovery token
    expect(seen).toContain("T&P RR CO A-329236");              // legal description (one well)
    expect(seen).toContain("T&P RR CO");                       // survey-only fallback
    expect(seen).toContain("CHEVRON USA INC");                 // normalized operator discovery
    expect(seen).toContain("CHEVRON U. S. A. INC.");           // operator, verbatim
    expect(seen.length).toBeLessThanOrEqual(12);               // within the query budget
    expect(store.title_search_log.some(r => r.status === "skipped_bounded")).toBe(false);
    // Zero results across every query must be disclosed, not left silent.
    expect(store.title_review_items.some(r => String(r.title).includes("No county instruments retrieved for Midland"))).toBe(true);
  });
});
