/**
 * Title sequencer tests — every fetcher is a FIXTURE stub (no live TRRC or
 * county traffic). Covers: provider-unavailable handling, document
 * deduplication by content hash, bounded/logged searches, and resumable
 * well resolution.
 */
import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runTitleResearchJob, searchCountyRecordsForJob, storeIndexEntries, retrieveOwnershipDocuments, ownershipReadPriority, MAX_COUNTY_QUERIES_PER_JOB, type TitleJobDeps } from "../title-sequencer.js";

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
    if (op === "neq") return row[k] !== v;
    if (op === "in") return (v as unknown[]).includes(row[k]);
    if (op === "is") return v === null ? row[k] == null : row[k] === v;
    return true;
  });
  const builder = (table: string) => {
    const filters: Array<[string, string, unknown]> = [];
    let op: "select" | "insert" | "update" | "upsert" | "delete" = "select";
    let payload: Record<string, unknown> | Record<string, unknown>[] | null = null;
    let upsertConflict: string[] = [];
    let ignoreDuplicates = false;
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
          if (existing) { if (!ignoreDuplicates) Object.assign(existing, r); out.push(existing); } else { const ins = { id: `${table}-${++idSeq}`, ...r }; rows().push(ins); out.push(ins); }
        }
        return { data: out, error: null };
      }
      if (op === "delete") {
        const keep = rows().filter(r => !matches(r, filters));
        const removed = rows().length - keep.length;
        store[table] = keep;
        return { data: [], error: null, count: removed };
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
      upsert: (p: never, o?: { onConflict?: string; ignoreDuplicates?: boolean }) => { op = "upsert"; payload = p; ignoreDuplicates = o?.ignoreDuplicates ?? false; upsertConflict = (o?.onConflict ?? "id").split(","); return chain; },
      eq: (k: string, v: unknown) => { filters.push(["eq", k, v]); return chain; },
      neq: (k: string, v: unknown) => { filters.push(["neq", k, v]); return chain; },
      in: (k: string, v: unknown[]) => { filters.push(["in", k, v]); return chain; },
      is: (k: string, v: unknown) => { filters.push(["is", k, v]); return chain; },
      delete: () => { op = "delete"; return chain; },
      order: () => chain, limit: () => chain, range: () => chain,
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
    expect(store.title_research_jobs[0].status).toBe("ingesting");
    expect(store.title_search_log.filter(l => l.provider === "trrc_ewa").length).toBeGreaterThanOrEqual(3);
  });

  it("with a supported county provider, stores index hits as UNVERIFIED instruments and follows grantor names once, bounded and logged", async () => {
    const { supabase, store } = makeSupabase({ ...seedJob(), title_canonical_tracts: [{ id: "t", job_id: "job-1", county: "Martin", section_name: "12", block_number: "35 T4S", match_status: "confirmed" }] });
    const getCountyRecords = vi.fn(async (_county: string, value: string) => ({
      found: true, status: "automated" as const, county: "Martin", provider: "publicsearch_us", total_count: 1, search_url: `https://x/${encodeURIComponent(value)}`, message: "ok",
      records: value === "DOE UNIT" ? [{ grantor: "SMITH, JOHN & SMITH, JANE", grantee: "ACME OIL", doc_type: "OIL AND GAS LEASE", recorded_date: "2019-05-01", doc_number: "2019-1", book_volume_page: "", legal_description: "A-1234 SEC 12 BLK 35 T4S" }] : [],
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
    expect(getCountyRecords).toHaveBeenCalledTimes(7);
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


describe("title handoff regression", () => {
  it("persists cited GIS candidates before review, without inventing acreage or title", async () => {
    const { supabase, store } = makeSupabase(seedJob());
    await runTitleResearchJob("job-1", supabase, deps());
    expect(store.title_canonical_tracts).toHaveLength(1);
    expect(store.title_canonical_tracts[0]).toMatchObject({ abstract_number: "A-1234", block_number: "35", section_name: "12", gross_acres: null, match_status: "proposed", needs_user_selection: true });
    expect(store.title_well_tract_associations[0]).toMatchObject({ well_id: "well-1", association_type: "surface_location", review_status: "proposed" });
    expect(store.title_research_jobs[0].status).toBe("ingesting");
    store.title_canonical_tracts[0].match_status = "confirmed";
    store.title_well_tract_associations[0].review_status = "confirmed";
    store.title_research_jobs[0].status = "pending";
    await runTitleResearchJob("job-1", supabase, deps());
    expect(store.title_canonical_tracts).toHaveLength(1);
    expect(store.title_well_tract_associations).toHaveLength(1);
    expect(store.title_well_tract_associations[0].review_status).toBe("confirmed");
  });
  it("fails a legacy empty job explicitly instead of displaying an empty confirmation", async () => {
    const seed = seedJob(); seed.title_job_wells = [];
    const { supabase, store } = makeSupabase(seed); const d = deps();
    await runTitleResearchJob("job-1", supabase, d);
    expect(store.title_research_jobs[0].status).toBe("failed");
    expect(d.searchWellbore).not.toHaveBeenCalled();
  });
  it("does not propose a tract when GIS retrieval failed", async () => {
    const { supabase, store } = makeSupabase(seedJob());
    const d = deps({ getGisLocation: vi.fn(async () => ({ found: false, latitude: null, longitude: null, well_type: null, survey: null, alert_areas: [], message: "network failed", error: "network failed" })) });
    await runTitleResearchJob("job-1", supabase, d);
    expect(store.title_canonical_tracts ?? []).toHaveLength(0);
    expect(String(store.title_research_jobs[0].stage_detail)).toContain("no supported tract candidate");
  });
  it("does not restart a cancelled job", async () => {
    const seed = seedJob(); seed.title_research_jobs[0].status = "cancelled";
    const { supabase, store } = makeSupabase(seed); const d = deps();
    await runTitleResearchJob("job-1", supabase, d);
    expect(store.title_research_jobs[0].status).toBe("cancelled");
    expect(d.searchWellbore).not.toHaveBeenCalled();
  });
});


describe("title current-row selection", () => {
  it("uses the unique current association instead of the first historical row", async () => {
    const { supabase, store } = makeSupabase(seedJob()); const d = deps();
    const original = await d.searchWellbore("4231700001");
    d.searchWellbore = vi.fn(async () => ({ ...original, wells: [
      {...original.wells[0],on_schedule:"N",well_no:"1",lease_no:"11111",operator_name:"OLD OPERATOR"},
      {...original.wells[0],on_schedule:"Y",well_no:"1D",lease_no:"22222",district:"08",operator_name:"CURRENT OPERATOR"},
    ] }));
    await runTitleResearchJob("job-1",supabase,d);
    expect(store.title_job_wells[0]).toMatchObject({well_number:"1D",lease_number:"22222",operator_name:"CURRENT OPERATOR",operator_number:null});
  });
  it("surfaces multiple current rows rather than choosing one", async () => {
    const { supabase, store } = makeSupabase(seedJob()); const d = deps(); const original = await d.searchWellbore("4231700001");
    d.searchWellbore = vi.fn(async () => ({...original,wells:[{...original.wells[0],on_schedule:"Y",well_no:"1"},{...original.wells[0],on_schedule:"Y",well_no:"1D"}]}));
    await runTitleResearchJob("job-1",supabase,d);
    expect(store.title_job_wells[0].well_number).toBeNull();
    expect(store.title_review_items.some(r=>r.kind==="well_identity_ambiguous")).toBe(true);
  });
});

describe("automatic county previews", () => {
 it("retrieves unit-name candidates, excludes unrelated records, and leaves instruments unverified", async () => {
  const {supabase, store} = makeSupabase(seedJob());
  const doc = {grantor:"A",grantee:"B",doc_type:"MINERAL DEED",recorded_date:"2020-01-01",doc_number:"123",book_volume_page:"",legal_description:"DOE UNIT",document_url:"https://midland.tx.publicsearch.us/doc/1"};
  const getDocument = vi.fn(async () => ({ok:true as const,bytes:Buffer.from("%PDF-county-preview"),pageCount:3,sourceUrl:doc.document_url}));
  const d = deps({
   findProvider: vi.fn(() => ({provider:{id:"publicsearch_us",name:"x",counties:{},search:vi.fn()},identifier:"midland",displayName:"Midland"})),
   getCountyRecords: vi.fn(async () => ({found:true,status:"automated" as const,county:"Midland",provider:"publicsearch.us",records:[doc,{...doc,doc_number:"124",document_url:"https://midland.tx.publicsearch.us/doc/2",legal_description:"RESIDENTIAL SUBDIVISION"}],total_count:2,search_url:"https://midland.tx.publicsearch.us/",message:"ok"})),
   getCountyDocument:getDocument,
  });
  await runTitleResearchJob("job-1",supabase,d);
  expect(getDocument).toHaveBeenCalledTimes(1);
  expect(store.title_documents.filter(x=>x.source==="county_public_preview")).toHaveLength(1);
  expect(store.title_instruments.every(x=>x.instrument_content_verified===false)).toBe(true);
  store.title_research_jobs[0].status="pending";
  await runTitleResearchJob("job-1",supabase,d);
  expect(getDocument).toHaveBeenCalledTimes(1);
 });
});


describe("county search coverage", () => {
  const provider = () => ({ provider: { id: "publicsearch_us", name: "x", counties: {}, search: vi.fn() }, identifier: "midland", displayName: "Midland" });
  const well = { id: "w", api10: "4232946216", api14: null, county_name: "Midland", resolution_status: "resolved", operator_name: "CHEVRON U.S.A. INC.", lease_name: "CMC BUTTERCUP 25-37 UNIT", survey_name: "T&P RR CO", abstract_number: "A-329236" };
  const empty = (value: string) => ({ found: false, status: "automated" as const, county: "Midland", provider: "publicsearch_us", total_count: 0, search_url: `https://example.test/${encodeURIComponent(value)}`, message: "No matches", records: [] });

  it("twelve shared-lease wells search unique variants without exhausting the budget and expose empty coverage", async () => {
    const { supabase, store } = makeSupabase(seedJob());
    const fetch = vi.fn(async (_county: string, value: string) => empty(value));
    await searchCountyRecordsForJob(supabase, deps({ getCountyRecords: fetch, findProvider: provider }), "job-1", "user-1", Array.from({ length: 12 }, (_, i) => ({ ...well, id: String(i) })));
    const queries = fetch.mock.calls.map(c => c[1]);
    expect(queries).toContain("CMC BUTTERCUP 25 37 UNIT");
    expect(queries).toContain("BUTTERCUP");
    expect(queries).toContain("T&P RR CO");
    expect(queries.length).toBe(new Set(queries).size);
    expect(queries.length).toBeLessThan(12);
    expect(store.title_search_log.some(r => r.status === "skipped_bounded")).toBe(false);
    expect(store.title_review_items.some(r => String(r.title).includes("No county instruments"))).toBe(true);
  });

  it("retries a persisted failed legal query on resume", async () => {
    const seed = seedJob();
    seed.title_search_log = [{ job_id: "job-1", provider: "county:publicsearch_us", query_type: "legal_description", query_value: "T&P RR CO A-329236", status: "failed" }];
    const { supabase } = makeSupabase(seed);
    const fetch = vi.fn(async (_county: string, value: string) => empty(value));
    await searchCountyRecordsForJob(supabase, deps({ getCountyRecords: fetch, findProvider: provider }), "job-1", "user-1", [well]);
    expect(fetch).toHaveBeenCalledWith("Midland", "T&P RR CO A-329236");
  });

  it("surfaces truncated result sets and does not chase operator-only grantors", async () => {
    const { supabase, store } = makeSupabase(seedJob());
    const fetch = vi.fn(async (_county: string, value: string) => value === well.operator_name ? { ...empty(value), total_count: 50, records: [{ grantor: "UNRELATED RESIDENT", grantee: "PIPELINE CO", doc_type: "EASEMENT", recorded_date: "2020-01-01", doc_number: "1", book_volume_page: "", legal_description: "RESIDENTIAL SUBDIVISION" }] } : empty(value));
    await searchCountyRecordsForJob(supabase, deps({ getCountyRecords: fetch, findProvider: provider }), "job-1", "user-1", [well]);
    expect(fetch).not.toHaveBeenCalledWith("Midland", "UNRELATED RESIDENT");
    expect(store.title_review_items.some(r => String(r.title).includes("truncated"))).toBe(true);
    expect(store.title_instruments[0].instrument_content_verified).toBe(false);
  });

  it("records the unfinished search plan when distinct leases exceed the budget", async () => {
    const { supabase, store } = makeSupabase(seedJob());
    const fetch = vi.fn(async (_county: string, value: string) => empty(value));
    await searchCountyRecordsForJob(supabase, deps({ getCountyRecords: fetch, findProvider: provider }), "job-1", "user-1", Array.from({ length: MAX_COUNTY_QUERIES_PER_JOB + 4 }, (_, i) => ({ ...well, lease_name: `LEASE ${i}`, id: String(i) })));
    expect(fetch.mock.calls.length).toBe(MAX_COUNTY_QUERIES_PER_JOB);
    expect(store.title_search_log.some(r => r.status === "skipped_bounded")).toBe(true);
    expect(store.title_review_items.some(r => r.title === "County search budget reached")).toBe(true);
  });
});


describe("operator discovery on resumed title jobs", () => {
  it.each(["CHEVRON U. S. A. INC.", "CHEVRON U.S.A. INC."])("searches normalized %s despite a cached empty raw query, without following unrelated parties", async (operator) => {
    const seed = seedJob();
    seed.title_search_log = [{ job_id: "job-1", provider: "county:publicsearch_us", query_type: "operator", query_value: operator, status: "empty" }];
    const { supabase, store } = makeSupabase(seed);
    const fetch = vi.fn(async (_county: string, value: string) => ({ found: true, status: "automated" as const, county: "Midland", provider: "publicsearch_us", total_count: 1, search_url: "https://example.test", message: "ok", records: value === "CHEVRON USA INC" ? [{ grantor: "UNRELATED GRANTOR", grantee: "CHEVRON USA INC", doc_type: "EASEMENT", recorded_date: "2020-01-01", doc_number: "1", book_volume_page: "", legal_description: "OTHER TRACT", document_url: "https://example.test/doc/1" }] : [] }));
    const getCountyDocument = vi.fn();
    const findProvider = () => ({ provider: { id: "publicsearch_us", name: "x", counties: {}, search: vi.fn() }, identifier: "midland", displayName: "Midland" });
    const well = { id: "w", api10: "4232946216", api14: null, county_name: "Midland", resolution_status: "resolved", operator_name: operator, lease_name: null, survey_name: null, abstract_number: null };
    await searchCountyRecordsForJob(supabase, deps({ getCountyRecords: fetch, findProvider, getCountyDocument }), "job-1", "user-1", Array.from({ length: 12 }, (_, i) => ({ ...well, id: String(i) })));
    expect(fetch.mock.calls.map(c => c[1])).toEqual(["CHEVRON USA INC"]);
    expect(getCountyDocument).not.toHaveBeenCalled();
    expect(store.title_instruments[0].instrument_content_verified).toBe(false);
    expect(store.title_search_log.some(r => r.query_type === "operator_variant" && r.status === "success")).toBe(true);
  });
});


describe("confirmed tract search priority and predecessor gating", () => {
  it("prioritizes the confirmed tract independently of well order and excludes street/wrong-township grantors", async () => {
    const { supabase, store } = makeSupabase({ ...seedJob(), title_canonical_tracts: [{ id: "t", job_id: "job-1", county: "Midland", section_name: "37", block_number: "39 T4S", match_status: "confirmed" }] });
    const row = (n: string, legal: string) => ({ doc_number: n, grantor: n, grantee: "BUYER", doc_type: "MINERAL DEED", recorded_date: "2020-01-01", book_volume_page: "", legal_description: legal });
    const fetch = vi.fn(async (_county: string, value: string) => ({ found: true, status: "automated" as const, county: "Midland", provider: "publicsearch_us", total_count: 3, search_url: "https://example.test", message: "ok", records: value === "SEC 37 BLK 39 T4S" ? [row("RELEVANT OWNER", "SEC 37 BLK 39 T4S"), row("WRONG TOWNSHIP", "SEC 37 BLK 39 T3S"), row("STREET OWNER", "OWNER: 3810 BUTTERCUP GARDENDALE TX 79758")] : [] }));
    const well = { id: "w", api10: "4232946216", api14: null, county_name: "Midland", resolution_status: "resolved", operator_name: null, lease_name: "BUTTERCUP UNIT", survey_name: null, abstract_number: null };
    const findProvider = () => ({ provider: { id: "publicsearch_us", name: "x", counties: {}, search: vi.fn() }, identifier: "midland", displayName: "Midland" });
    await searchCountyRecordsForJob(supabase, deps({ getCountyRecords: fetch, findProvider }), "job-1", "user-1", Array.from({ length: 12 }, (_, i) => ({ ...well, id: String(i) })));
    expect(fetch.mock.calls.slice(0, 2).map(c => c[1])).toEqual(["SEC 37 BLK 39 T4S", "SECTION 37 BLOCK 39 T4S"]);
    expect(fetch).toHaveBeenCalledWith("Midland", "RELEVANT OWNER");
    expect(fetch).not.toHaveBeenCalledWith("Midland", "WRONG TOWNSHIP");
    expect(fetch).not.toHaveBeenCalledWith("Midland", "STREET OWNER");
    expect(store.title_instruments.every(r => r.instrument_content_verified === false)).toBe(true);
  });
});

describe("unit tracts from the TRRC lateral (FIXTURE stubs)", () => {
  const lateral = { found: true, surface: { latitude: 32.1, longitude: -102.1 }, terminus: { latitude: 32.07, longitude: -102.09 }, query_url: "https://gis.example/9/query?API=31700001", message: "ok",
    surveys: [
      { abstract_number: "1234", survey_name: "T&P RR CO", block_number: "35", section_name: "12", share: 0.47 },
      { abstract_number: "1235", survey_name: "T&P RR CO", block_number: "35", section_name: "13", share: 0.43 },
      { abstract_number: "1240", survey_name: "T&P RR CO", block_number: "35", section_name: "24", share: 0.1 },
    ] };
  it("confirms every section the lateral runs through, reusing the surface tract and citing the GIS line", async () => {
    const { supabase, store } = makeSupabase(seedJob());
    await runTitleResearchJob("job-1", supabase, deps({ getLateralSurveys: vi.fn(async () => lateral) }));
    const tracts = store.title_canonical_tracts;
    // Section 12 is the surface survey too: one tract, now confirmed, not a duplicate.
    expect(tracts.filter(t => t.section_name === "12")).toHaveLength(1);
    expect(tracts.filter(t => t.match_status === "confirmed").map(t => t.section_name).sort()).toEqual(["12", "13", "24"]);
    expect(tracts.find(t => t.section_name === "24")!.resolution_method).toBe("gis_lateral_path");
    const assoc = store.title_well_tract_associations.filter(a => a.association_type === "well_path");
    expect(assoc).toHaveLength(3);
    expect(assoc.every(a => a.review_status === "confirmed" && (a.evidence_json as Array<{ sourceUrl: string; excerpt: string }>)[0].sourceUrl === lateral.query_url)).toBe(true);
    expect((assoc[2].evidence_json as Array<{ excerpt: string }>)[0].excerpt).toContain("about 10% of its length");
    expect(store.title_search_log.some(l => l.provider === "trrc_gis_lateral" && l.status === "success")).toBe(true);
  });
  it("adds the lateral to a well resolved before lateral lookup existed, when the job is re-run", async () => {
    const seed = seedJob();
    Object.assign(seed.title_job_wells[0], { resolution_status: "resolved", lease_name: "DOE UNIT", county_name: "Martin", well_path_json: { wellType: "Oil Well", surfacePoint: { latitude: 32.1, longitude: -102.1 }, lateral: null } });
    const { supabase, store } = makeSupabase(seed);
    const getLateralSurveys = vi.fn(async () => lateral);
    const searchWellbore = vi.fn();
    await runTitleResearchJob("job-1", supabase, deps({ getLateralSurveys, searchWellbore }));
    expect(searchWellbore).not.toHaveBeenCalled();
    expect(getLateralSurveys).toHaveBeenCalledTimes(1);
    expect((store.title_job_wells[0].well_path_json as { lateral: { surveys: unknown[] } }).lateral.surveys).toHaveLength(3);
    expect(store.title_canonical_tracts.filter(t => t.match_status === "confirmed").map(t => t.section_name).sort()).toEqual(["12", "13", "24"]);
  });
  it("never revives a rejected tract", async () => {
    const seed = seedJob();
    seed.title_canonical_tracts = [{ id: "t-rej", job_id: "job-1", county: "Martin", abstract_number: "A-1235", block_number: "35", section_name: "13", match_status: "rejected" }];
    const { supabase, store } = makeSupabase(seed);
    await runTitleResearchJob("job-1", supabase, deps({ getLateralSurveys: vi.fn(async () => lateral) }));
    expect(store.title_canonical_tracts.find(t => t.id === "t-rej")!.match_status).toBe("rejected");
    expect(store.title_canonical_tracts.filter(t => t.section_name === "13")).toHaveLength(1);
  });
});

describe("county document reading order and budget", () => {
  it("parses clerk dates so the newest instrument is read first", async () => {
    const { recordedTime } = await import("../title-sequencer.js");
    expect(recordedTime("12/27/1957")).toBeLessThan(recordedTime("4/9/2026"));
    expect(recordedTime("4/16/1955")).toBeLessThan(recordedTime("12/27/1957"));
    expect(recordedTime("")).toBe(Number.NEGATIVE_INFINITY);
  });
  it("scales the image budget with the unit's tracts, within a ceiling", async () => {
    const { countyDocumentLimit } = await import("../title-sequencer.js");
    expect(countyDocumentLimit(1)).toBe(40);
    expect(countyDocumentLimit(3)).toBe(90);
    expect(countyDocumentLimit(10)).toBe(120);
  });
});

describe("county document continuation", () => {
  const countySeed = (status = "confirmed", count = 1): Store => ({
    ...seedJob(),
    title_canonical_tracts: [{ id: "t", job_id: "job-1", county: "MIDLAND", section_name: "37", block_number: "39 T4S", match_status: status }],
    title_instruments: Array.from({ length: count }, (_, i) => ({ id: `i${i}`, job_id: "job-1", county: "MIDLAND", document_id: null, extraction_json: { index: {
      doc_number: `D${i}`, doc_type: "MINERAL DEED", grantor: "PIPELINE COMPANY", grantee: "BUYER", legal_description: "SEC 37 BLK 39 T4S", document_url: `https://midland.tx.publicsearch.us/doc/${i+1}`, recorded_date: "2020-01-01",
    } } })),
  });
  const preview = vi.fn(async (url: string) => ({ ok: true as const, bytes: Buffer.concat([PDF, Buffer.from(url)]), pageCount: 1, sourceUrl: url }));
  it("reads a mineral conveyance regardless of a midstream party name", () => {
    expect(ownershipReadPriority({ doc_type: "MINERAL DEED", grantor: "PIPELINE COMPANY" })).toBe(0);
    expect(ownershipReadPriority({ doc_type: "SURFACE EASEMENT" })).toBe(6);
  });
  it("reads proposed tract leads without changing their confirmation", async () => {
    const { supabase, store } = makeSupabase(countySeed("proposed"));
    expect(await retrieveOwnershipDocuments(supabase, deps({ getCountyDocument: preview }), "job-1", "user-1")).toBe(1);
    expect(store.title_canonical_tracts[0].match_status).toBe("proposed");
    expect(store.title_documents[0].extraction_status).toBe("pending");
  });
  it("never follows rejected tract leads", async () => {
    const { supabase } = makeSupabase(countySeed("rejected"));
    expect(await retrieveOwnershipDocuments(supabase, deps({ getCountyDocument: preview }), "job-1", "user-1")).toBe(0);
  });
  it("continues beyond forty stored documents on the next pass", async () => {
    const { supabase, store } = makeSupabase(countySeed("confirmed", 41));
    const d = deps({ getCountyDocument: preview });
    expect(await retrieveOwnershipDocuments(supabase, d, "job-1", "user-1")).toBe(40);
    expect(await retrieveOwnershipDocuments(supabase, d, "job-1", "user-1")).toBe(1);
    expect(store.title_documents).toHaveLength(41);
    expect(await retrieveOwnershipDocuments(supabase, d, "job-1", "user-1")).toBe(0);
  });
  it("shares one image budget across a run's passes, and a new run continues the queue", async () => {
    const { supabase, store } = makeSupabase(countySeed("confirmed", 90));
    const d = deps({ getCountyDocument: preview });
    const run1 = { remaining: null as number | null };
    expect(await retrieveOwnershipDocuments(supabase, d, "job-1", "user-1", [], run1)).toBe(40);
    // A discovery round in the same run reads nothing more: the run's 40 are spent.
    expect(await retrieveOwnershipDocuments(supabase, d, "job-1", "user-1", [], run1)).toBe(0);
    expect(store.title_review_items.some(r => r.title === "County document retrieval limit reached")).toBe(true);
    const run2 = { remaining: null as number | null };
    expect(await retrieveOwnershipDocuments(supabase, d, "job-1", "user-1", [], run2)).toBe(40);
    expect(store.title_documents).toHaveLength(80);
    // The limitation states the latest run's shortfall, and the review item is restated, not kept from run 1.
    const lims = () => (store.title_research_jobs[0].limitations_json as string[]).filter(l => l.startsWith("County document reading limit:"));
    expect(lims()).toEqual(["County document reading limit: 10 further recording(s) on the tracts were not read in the latest run (limit 40 images a run). Re-running the title job continues the queue."]);
    expect(store.title_review_items.filter(r => r.title === "County document retrieval limit reached")).toHaveLength(1);
    expect(store.title_review_items.find(r => r.title === "County document retrieval limit reached")!.detail).toContain("10 further");
    expect(await retrieveOwnershipDocuments(supabase, d, "job-1", "user-1", [], { remaining: null })).toBe(10);
    expect(lims()).toEqual([]);
  });
  it("retries a transient preview failure once", async () => {
    const { supabase } = makeSupabase(countySeed());
    const fetch = vi.fn().mockResolvedValueOnce({ ok: false, error: "Viewer unavailable" }).mockImplementation(preview);
    expect(await retrieveOwnershipDocuments(supabase, deps({ getCountyDocument: fetch }), "job-1", "user-1")).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("does not report success for an empty or non-PDF preview", async () => {
    const { supabase, store } = makeSupabase(countySeed());
    const fetch = vi.fn(async () => ({ ok: true as const, bytes: Buffer.from("<html>login</html>"), pageCount: 1, sourceUrl: "x" }));
    expect(await retrieveOwnershipDocuments(supabase, deps({ getCountyDocument: fetch }), "job-1", "user-1")).toBe(0);
    expect(store.title_documents ?? []).toHaveLength(0);
    expect(store.title_search_log.some(r => r.query_type === "document" && r.status === "success")).toBe(false);
  });
});
