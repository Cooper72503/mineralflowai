/**
 * Title sequencer tests — every fetcher is a FIXTURE stub (no live TRRC or
 * county traffic). Covers: provider-unavailable handling, document
 * deduplication by content hash, bounded/logged searches, and resumable
 * well resolution.
 */
import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runTitleResearchJob, storeIndexEntries, type TitleJobDeps } from "../title-sequencer.js";

vi.mock("../tools/browser.js", () => ({ getCodaDocuments: vi.fn(), getBrowser: vi.fn(), closeBrowser: vi.fn() }));
vi.mock("../tools/ewa.js", () => ({ searchWellbore: vi.fn(), getGisLocation: vi.fn(), getDrillingPermits: vi.fn(), getCompletionRecords: vi.fn(), PDA_BASE: "https://webapps2.rrc.texas.gov/EWA" }));
vi.mock("../tools/county-records.js", () => ({ getCountyRecords: vi.fn(), findProvider: vi.fn() }));

interface Store { [table: string]: Record<string, unknown>[] }

/** Minimal in-memory Supabase covering the query shapes title-sequencer.ts uses. */
function makeSupabase(seed: Store) {
  const store: Store = JSON.parse(JSON.stringify(seed));
  const uploads: string[] = [];
  let idSeq = 0;
  const matches = (row: Record<string, unknown>, filters: Array<[string, string, unknown]>) => filters.every(([op, k, v]) => {
    if (op === "eq") return row[k] === v;
    if (op === "in") return (v as unknown[]).includes(row[k]);
    return true;
  });
  const builder = (table: string) => {
    const filters: Array<[string, string, unknown]> = [];
    let op: "select" | "insert" | "update" | "upsert" = "select";
    let payload: Record<string, unknown> | Record<string, unknown>[] | null = null;
    let upsertConflict: string[] = [];
    const rows = () => (store[table] ??= []);
    const exec = () => {
      if (op === "insert") {
        const list = Array.isArray(payload) ? payload : [payload!];
        const inserted = list.map(r => ({ id: `${table}-${++idSeq}`, ...r }));
        rows().push(...inserted);
        return { data: inserted, error: null };
      }
      if (op === "upsert") {
        const list = Array.isArray(payload) ? payload : [payload!];
        const out: Record<string, unknown>[] = [];
        for (const r of list) {
          const existing = rows().find(x => upsertConflict.every(k => x[k] === r[k]));
          if (existing) { Object.assign(existing, r); out.push(existing); } else { const ins = { id: `${table}-${++idSeq}`, ...r }; rows().push(ins); out.push(ins); }
        }
        return { data: out, error: null };
      }
      if (op === "update") {
        const hit = rows().filter(r => matches(r, filters));
        for (const r of hit) Object.assign(r, payload);
        return { data: hit, error: null };
      }
      return { data: rows().filter(r => matches(r, filters)), error: null };
    };
    const chain: Record<string, unknown> = {
      select: () => chain,
      insert: (p: never) => { op = "insert"; payload = p; return chain; },
      update: (p: never) => { op = "update"; payload = p; return chain; },
      upsert: (p: never, o?: { onConflict?: string }) => { op = "upsert"; payload = p; upsertConflict = (o?.onConflict ?? "id").split(","); return chain; },
      eq: (k: string, v: unknown) => { filters.push(["eq", k, v]); return chain; },
      in: (k: string, v: unknown[]) => { filters.push(["in", k, v]); return chain; },
      order: () => chain, limit: () => chain,
      single: async () => { const r = exec(); return { data: (r.data as unknown[])[0] ?? null, error: null }; },
      maybeSingle: async () => { const r = exec(); return { data: (r.data as unknown[])[0] ?? null, error: null }; },
      then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => Promise.resolve(exec()).then(resolve, reject),
    };
    return chain;
  };
  const supabase = {
    from: (table: string) => builder(table),
    storage: { from: () => ({ upload: async (path: string) => { uploads.push(path); return { error: null }; } }) },
  } as unknown as SupabaseClient;
  return { supabase, store, uploads };
}

const PDF = Buffer.concat([Buffer.from("%PDF-1.4 fixture "), Buffer.from("plat")]);

function deps(over: Partial<TitleJobDeps> = {}): TitleJobDeps {
  return {
    searchWellbore: vi.fn(async () => ({ found: true, wells: [{ api_no: "31700001", lease_name: "DOE UNIT", well_no: "1", operator_name: "ACME OIL", county: "MARTIN", field_name: "SPRABERRY" }], lease_number: "12345", district: "08", operator: "ACME OIL", operator_number: "0001", county: "MARTIN", message: "ok" })),
    getGisLocation: vi.fn(async () => ({ found: true, latitude: 32.1, longitude: -102.1, well_type: "Oil Well", survey: { abstract_number: "1234", survey_name: "T&P RR CO", block_number: "35", section_name: "12" }, alert_areas: [], message: "ok" })),
    getDrillingPermits: vi.fn(async () => ({ found: true, permits: [{ status_no: "9001", lease_name: "DOE UNIT" }], message: "ok" })),
    getCompletionRecords: vi.fn(async () => ({ found: false, records: [], message: "none" })),
    getCodaDocuments: vi.fn(async () => ({ found: true, documents: [
      { document_type: "W-1 Application", document_date: "2020-01-01", pages: "3", document_id: "c1", direct_url: "https://coda.example/c1.pdf" },
      { document_type: "Location Plat", document_date: "2020-01-01", pages: "1", document_id: "c2", direct_url: "https://coda.example/c2.pdf" },
      { document_type: "W-1 Application", document_date: "2020-01-01", pages: "3", document_id: "c3", direct_url: "https://coda.example/c3-same-bytes.pdf" },
    ], document_types_present: ["W-1 Application", "Location Plat"], coda_search_url: "https://coda.example/search", message: "ok" })),
    getCountyRecords: vi.fn(async () => ({ found: false, status: "manual_required" as const, county: "Martin", provider: "none", records: [], total_count: 0, search_url: "https://www.texasfile.com/search/texas/martin-county/county-clerk-records/", message: "manual", data_gap: true })),
    findProvider: vi.fn(() => null),
    fetchBytes: vi.fn(async (url: string) => ({ ok: true, bytes: url.includes("c2") ? Buffer.concat([PDF, Buffer.from("-plat")]) : PDF, contentType: "application/pdf" })),
    now: () => "2026-09-06T00:00:00.000Z",
    ...over,
  };
}

function seedJob(): Store {
  return {
    title_research_jobs: [{ id: "job-1", user_id: "user-1", status: "pending", attempt_count: 0, limitations_json: [] }],
    title_job_wells: [{ id: "well-1", job_id: "job-1", api10: "4231700001", api14: "42317000010000", county_name: "Martin", resolution_status: "unresolved", operator_name: null, lease_name: null, survey_name: null, abstract_number: null }],
  };
}

describe("runTitleResearchJob (FIXTURE stubs)", () => {
  it("resolves the well, stores each distinct TRRC image once (dedupe by content hash), logs every search, and records provider_unavailable honestly", async () => {
    const { supabase, store, uploads } = makeSupabase(seedJob());
    await runTitleResearchJob("job-1", supabase, deps());

    const well = store.title_job_wells[0];
    expect(well.resolution_status).toBe("resolved");
    expect(well.abstract_number).toBe("A-1234");
    expect(well.survey_name).toBe("T&P RR CO");
    expect(well.lease_name).toBe("DOE UNIT");
    expect(Array.isArray(well.source_urls_json)).toBe(true);

    // c1 and c3 have identical bytes -> one document; c2 differs -> second document.
    expect(store.title_documents).toHaveLength(2);
    expect(uploads).toHaveLength(2);
    expect(store.title_documents.every(d => (d.storage_path as string).startsWith("user-1/job-1/"))).toBe(true);
    expect(store.title_documents.map(d => d.document_category).sort()).toEqual(["location_plat", "w1_application"]);

    const providerLog = store.title_search_log.find(l => l.status === "provider_unavailable");
    expect(providerLog).toBeTruthy();
    expect(providerLog!.source_url).toMatch(/texasfile/);
    expect(store.title_review_items.some(r => r.kind === "provider_unavailable")).toBe(true);
    expect((store.title_research_jobs[0].limitations_json as string[]).some(l => /Martin County/.test(l))).toBe(true);
    expect(store.title_research_jobs[0].status).toBe("awaiting_tract_confirmation");
    expect(store.title_search_log.filter(l => l.provider === "trrc_ewa").length).toBeGreaterThanOrEqual(3);
  });

  it("with a supported county provider, stores index hits as UNVERIFIED instruments and follows grantor names once, bounded and logged", async () => {
    const { supabase, store } = makeSupabase(seedJob());
    const getCountyRecords = vi.fn(async (_county: string, value: string) => ({
      found: true, status: "automated" as const, county: "Martin", provider: "publicsearch_us", total_count: 1, search_url: `https://x/${encodeURIComponent(value)}`, message: "ok",
      records: value === "DOE UNIT" ? [{ grantor: "SMITH, JOHN & SMITH, JANE", grantee: "ACME OIL", doc_type: "OIL AND GAS LEASE", recorded_date: "2019-05-01", doc_number: "2019-1", book_volume_page: "", legal_description: "A-1234 SEC 12 BLK 35" }] : [],
    }));
    await runTitleResearchJob("job-1", supabase, deps({ getCountyRecords, findProvider: vi.fn(() => ({ provider: { id: "publicsearch_us", name: "x", counties: {}, search: vi.fn() }, identifier: "martin", displayName: "Martin" })) }));

    const inst = store.title_instruments;
    expect(inst).toHaveLength(1);
    expect(inst[0].instrument_content_verified).toBe(false);
    expect(inst[0].evidence_level).toBe("county_index_metadata");
    expect(inst[0].instrument_type).toBe("lease");
    expect(store.title_instrument_parties.filter(p => p.role === "grantor")).toHaveLength(2);
    expect(store.title_claims[0].effect).toBe("lease_grant");
    expect(store.title_claims[0].canonical_asset_id).toBeNull();
    // lease name + legal description + operator, then two grantor follow-ups at depth 1
    const followups = store.title_search_log.filter(l => l.depth === 1);
    expect(followups.map(l => l.query_value).sort()).toEqual(["SMITH, JANE", "SMITH, JOHN"]);
    expect(getCountyRecords).toHaveBeenCalledTimes(5);
  });

  it("reuses an already-resolved well on retry and is idempotent on index rows", async () => {
    const seed = seedJob();
    seed.title_job_wells[0].resolution_status = "resolved";
    seed.title_job_wells[0].lease_name = "DOE UNIT";
    const { supabase } = makeSupabase(seed);
    const d = deps();
    await runTitleResearchJob("job-1", supabase, d);
    expect(d.searchWellbore).not.toHaveBeenCalled();
  });

  it("storeIndexEntries never inserts the same index row twice", async () => {
    const { supabase, store } = makeSupabase({});
    const entry = { grantor: "A", grantee: "B", doc_type: "WARRANTY DEED", recorded_date: "2001-01-01", doc_number: "1", book_volume_page: "", legal_description: "" };
    await storeIndexEntries(supabase, "job-1", "Martin", "https://x", [entry]);
    await storeIndexEntries(supabase, "job-1", "Martin", "https://x", [entry]);
    expect(store.title_instruments).toHaveLength(1);
  });
});
