import { describe, it, expect } from "vitest";
import { supersedeIndexedCopies, SUPERSEDED_EVIDENCE_LEVEL, INDEX_PARTY_EXCERPT } from "../supersede-index";

type Row = Record<string, unknown>;
function store(seed: Record<string, Row[]>) {
  const t: Record<string, Row[]> = JSON.parse(JSON.stringify(seed));
  let seq = 0;
  const from = (name: string) => {
    const f: Array<(r: Row) => boolean> = [];
    let op: "select" | "update" | "insert" | "delete" = "select", payload: Row | Row[] | null = null;
    const rows = () => (t[name] ??= []);
    const run = () => {
      if (op === "insert") { const list = Array.isArray(payload) ? payload : [payload!]; rows().push(...list.map(r => ({ id: `${name}-${++seq}`, ...r }))); return { data: null, error: null }; }
      const hit = rows().filter(r => f.every(p => p(r)));
      if (op === "update") { hit.forEach(r => Object.assign(r, payload)); return { data: hit, error: null }; }
      if (op === "delete") { t[name] = rows().filter(r => !hit.includes(r)); return { data: null, error: null }; }
      return { data: hit, error: null };
    };
    const q: Record<string, unknown> = {
      select: () => q, order: () => q, range: () => q, limit: () => q,
      eq: (k: string, v: unknown) => { f.push(r => r[k] === v); return q; },
      neq: (k: string, v: unknown) => { f.push(r => r[k] !== v); return q; },
      in: (k: string, v: unknown[]) => { f.push(r => v.includes(r[k])); return q; },
      is: (k: string, v: unknown) => { f.push(r => (r[k] ?? null) === v); return q; },
      not: (k: string, _o: string, v: unknown) => { f.push(r => (r[k] ?? null) !== v); return q; },
      update: (p: Row) => { op = "update"; payload = p; return q; },
      insert: (p: Row | Row[]) => { op = "insert"; payload = p; return q; },
      delete: () => { op = "delete"; return q; },
      then: (res: (v: unknown) => void, rej?: (e: unknown) => void) => Promise.resolve(run()).then(res, rej),
    };
    return q;
  };
  return { db: { from } as never, t };
}

describe("a read copy supersedes every index row of its recording (live Buttercup 1994-1140)", () => {
  it("retires both grantee rows and keeps both grantees", async () => {
    const url = "https://midland.tx.publicsearch.us/doc/1";
    const index = (id: string, grantee: string) => ({ id, job_id: "j", document_id: null, instrument_number: "1994-1140", doc_number: "1994-1140", recorded_date: "1/14/1994", evidence_level: "county_index_metadata",
      extraction_json: { index: { document_url: url, doc_type: "DEED", grantor: "BUCHANAN JOHN H TRUST", grantee, legal_description: "SEC 36 BLK 39 T4S" } } });
    const { db, t } = store({
      title_documents: [{ id: "d", job_id: "j", source_url: url }],
      title_instruments: [index("i1", "GARRETT SHIRLEY JEAN"), index("i2", "DANIEL ANN MILLER"),
        { id: "r", job_id: "j", document_id: "d", instrument_number: "1994-1140", recorded_date: "1/14/1994", instrument_type: "deed", extraction_json: {} }],
      title_instrument_parties: [
        { id: "p1", instrument_id: "i1", party_name: "BUCHANAN JOHN H TRUST", role: "grantor" }, { id: "p2", instrument_id: "i1", party_name: "GARRETT SHIRLEY JEAN", role: "grantee" },
        { id: "p3", instrument_id: "i2", party_name: "BUCHANAN JOHN H TRUST", role: "grantor" }, { id: "p4", instrument_id: "i2", party_name: "DANIEL ANN MILLER", role: "grantee" },
        { id: "p5", instrument_id: "r", party_name: "OCR NOISE", role: "grantor" }],
      title_canonical_tracts: [{ id: "t36", job_id: "j", match_status: "confirmed", county: "MIDLAND", section_name: "36", block_number: "39 T4S", tract_label: "Section 36" }],
      title_instrument_tracts: [{ id: "it", instrument_id: "r", canonical_tract_id: null }],
      title_claims: [],
    });
    expect(await supersedeIndexedCopies(db, "j")).toBe(2);
    expect(t.title_instruments.filter(i => i.document_id === null).every(i => i.evidence_level === SUPERSEDED_EVIDENCE_LEVEL)).toBe(true);
    const own = t.title_instrument_parties.filter(p => p.instrument_id === "r");
    expect(own.map(p => `${p.role}:${p.party_name}`).sort()).toEqual(["grantee:DANIEL ANN MILLER", "grantee:GARRETT SHIRLEY JEAN", "grantor:BUCHANAN JOHN H TRUST"]);
    expect(own.every(p => p.source_excerpt === INDEX_PARTY_EXCERPT)).toBe(true);
    // Idempotent.
    expect(await supersedeIndexedCopies(db, "j")).toBe(0);
    expect(t.title_instrument_parties.filter(p => p.instrument_id === "r")).toHaveLength(3);
  });
});
