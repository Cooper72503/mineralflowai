/**
 * When the worker downloads a document from a county index entry and that
 * document is then read, the same recorded instrument exists twice: once as
 * the clerk's index row (parties and type as indexed, content unverified)
 * and once as the read instrument (content verified). Left alone, the chain
 * shows every such instrument twice.
 *
 * The read copy supersedes its index row. It takes the clerk's instrument
 * number and recording date — the recording's identity — and the clerk's
 * grantor/grantee, labeled as coming from the index rather than the
 * instrument text (a release recites the date and parties of the deed of
 * trust it clears, which are not its own), and the tract
 * the clerk's legal description names when the text's own description could
 * not be matched — OCR through the watermark turns "Block 39, T-4-S" into
 * "0% 39, Township 4-Sou". County public previews
 * are watermarked, and OCR through the watermark can make a 1957 release's
 * parties unrecoverable ("Valor Oil Qt / ~ x \ / Xa Company hereby releases
 * onggoiusshes to the said Rutter and Wilbanks ... Brothers") while the
 * index states them cleanly. The clerk's grantor-grantee index governs
 * party identity and the clerk's classification governs the instrument type;
 * the text is read for terms and tract language.
 *
 * Idempotent: safe to run before every analysis.
 */
import { selectAll } from "./select-all";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mapTractRow } from "./job-store";
import { legalDescriptionCoversTract } from "./legal-match";
import { clerkInstrumentType, effectForInstrumentType } from "./clerk-types";

export const SUPERSEDED_EVIDENCE_LEVEL = "superseded_by_read_instrument";
export const INDEX_PARTY_EXCERPT = "As indexed by the county clerk; not read from the instrument text.";

export async function supersedeIndexedCopies(supabase: SupabaseClient, jobId: string): Promise<number> {
  const [docs, read, index, canonRes] = await Promise.all([
    supabase.from("title_documents").select("id, source_url").eq("job_id", jobId),
    selectAll<Record<string, unknown>>((a, b) => supabase.from("title_instruments").select("id, document_id, instrument_number, doc_number, recorded_date, instrument_type, extraction_json").eq("job_id", jobId).not("document_id", "is", null).order("id").range(a, b)),
    selectAll<Record<string, unknown>>((a, b) => supabase.from("title_instruments").select("id, instrument_number, doc_number, recorded_date, evidence_level, extraction_json").eq("job_id", jobId).is("document_id", null).order("id").range(a, b)),
    supabase.from("title_canonical_tracts").select("*").eq("job_id", jobId).neq("match_status", "rejected"),
  ]);
  for (const [name, r] of [["documents", docs], ["read instruments", read], ["index rows", index], ["tracts", canonRes]] as const) {
    if (r.error) throw new Error(`Could not load title ${name}: ${r.error.message}`);
  }
  const canon = ((canonRes.data ?? []) as Record<string, unknown>[]).map(mapTractRow);
  const confirmed = canon.filter(c => c.matchStatus === "confirmed");
  // Any proposed tract is undecided, whichever machine step proposed it. A
  // 1957 release covering E/2 Sec 27, W/2 Sec 37 and S/2 Sec 47 was parked
  // on a Sec 27 / Upton County proposal (the first section in the text and
  // the county of a recited recording); the clerk indexed it against Sec 37.
  // Confirmed and rejected tracts are never moved.
  const undecided = new Set(canon.filter(c => c.matchStatus === "proposed").map(c => c.id));
  const urlByDoc = new Map((docs.data ?? []).map(d => [String(d.id), d.source_url as string | null]));
  const indexByUrl = new Map<string, Record<string, unknown>>();
  for (const row of (index.data ?? []) as Record<string, unknown>[]) {
    const url = ((row.extraction_json as { index?: { document_url?: unknown } } | null)?.index?.document_url);
    if (typeof url === "string" && url) indexByUrl.set(url, row);
  }

  let superseded = 0;
  for (const r of (read.data ?? []) as Record<string, unknown>[]) {
    const url = urlByDoc.get(String(r.document_id));
    const idx = url ? indexByUrl.get(url) : undefined;
    if (!idx) continue;
    const indexNumber = (idx.instrument_number as string | null) ?? (idx.doc_number as string | null) ?? null;

    // The document was downloaded from this exact index entry, so the
    // clerk's instrument number and recording date are this recording's
    // identity by definition. Text-derived values are references recited in
    // the body (a 1960 right-of-way read as "1942"; an instrument numbered
    // 2015-1861 read as 2014-30002).
    const patch: Record<string, unknown> = {};
    if (indexNumber && r.instrument_number !== indexNumber) Object.assign(patch, { instrument_number: indexNumber, doc_number: indexNumber });
    if (idx.recorded_date && r.recorded_date !== idx.recorded_date) patch.recorded_date = idx.recorded_date;
    // Keep the clerk's entry beside the extraction, so reports can print the
    // clerk's own document type for the recording.
    const clerkEntry = (idx.extraction_json as { index?: Record<string, unknown> } | null)?.index ?? null;
    const extraction = (r.extraction_json as Record<string, unknown> | null) ?? {};
    if (clerkEntry && JSON.stringify(extraction.clerk_index ?? null) !== JSON.stringify(clerkEntry)) patch.extraction_json = { ...extraction, clerk_index: clerkEntry };
    if (Object.keys(patch).length) {
      const { error } = await supabase.from("title_instruments").update(patch).eq("id", r.id);
      if (error) throw new Error(`Could not record index metadata on read instrument: ${error.message}`);
    }

    // The clerk's legal description for this recording names the tract.
    // Apply it only to the read copy's tracts that are unmatched or parked
    // on an undecided proposal; a tract a person confirmed or rejected keeps
    // its assignment.
    const indexLegal = ((idx.extraction_json as { index?: { legal_description?: unknown } } | null)?.index?.legal_description);
    const covers = typeof indexLegal === "string" ? confirmed.filter(c => legalDescriptionCoversTract(indexLegal, c)) : [];
    if (covers.length === 1) {
      const { data: own, error: ownTractError } = await supabase.from("title_instrument_tracts").select("id, canonical_tract_id").eq("instrument_id", r.id);
      if (ownTractError) throw new Error(`Could not load read instrument tracts: ${ownTractError.message}`);
      for (const t of (own ?? []) as Array<{ id: string; canonical_tract_id: string | null }>) {
        if (t.canonical_tract_id && !undecided.has(t.canonical_tract_id)) continue;
        await supabase.from("title_instrument_tracts").update({ canonical_tract_id: covers[0].id }).eq("id", t.id);
        await supabase.from("title_claims").update({ canonical_asset_id: covers[0].id }).eq("instrument_tract_id", t.id);
      }
    }

    // The clerk's classification governs the instrument type. Typing from the
    // body scans for keywords, and every live mismatch was the body being
    // wrong: a 2018 pipeline easement (clerk: AGREEMENT) read as an
    // "assignment", which made Targa Pipeline a mineral holder in the
    // ownership graph; a 1960 GRANT OF RIGHT OF WAY read as a "release"; a
    // 2015 pipeline agreement read as a "lien" from an indemnity clause.
    // Probate and heirship are kept when the clerk indexes them generically:
    // they only add succession evidence and never create a conveyance.
    const clerkType = clerkInstrumentType((idx.extraction_json as { index?: { doc_type?: string } } | null)?.index?.doc_type);
    const readType = String(r.instrument_type ?? "other");
    const keepRead = clerkType === "other" && (readType === "probate" || readType === "affidavit_of_heirship");
    const governingType = clerkType && !keepRead ? clerkType : null;
    if (governingType && governingType !== readType) {
      const { error } = await supabase.from("title_instruments").update({ instrument_type: governingType }).eq("id", r.id);
      if (error) throw new Error(`Could not apply clerk instrument type: ${error.message}`);
      await supabase.from("title_claims").update({ effect: effectForInstrumentType(governingType), notes: `Instrument type as indexed by the county clerk; the text was read as ${readType.replace(/_/g, " ")}.` })
        .eq("instrument_id", r.id).eq("human_review_status", "unreviewed");
    }

    // Party identity comes from the clerk's grantor-grantee index — the
    // record a landman runs a chain from. Watermarked OCR yields fragments
    // ("WOO, successors, assigns, Atlas Pipeline Mid: Cofifid"); the index
    // yields "BOB AND TONI MIDKIFF LTD". The text is read for terms.
    const { data: indexed, error: indexedError } = await supabase.from("title_instrument_parties")
      .select("party_name, party_name_verbatim, role").eq("instrument_id", idx.id);
    if (indexedError) throw new Error(`Could not load index parties: ${indexedError.message}`);
    const { data: own, error: ownError } = await supabase.from("title_instrument_parties").select("id, source_excerpt").eq("instrument_id", r.id);
    if (ownError) throw new Error(`Could not load read instrument parties: ${ownError.message}`);
    const alreadyIndexed = (own ?? []).length > 0 && (own ?? []).every(p => p.source_excerpt === INDEX_PARTY_EXCERPT);
    if (indexed?.length && !alreadyIndexed) {
      if ((own ?? []).length) {
        const { error: deleteError } = await supabase.from("title_instrument_parties").delete().eq("instrument_id", r.id);
        if (deleteError) throw new Error(`Could not replace read instrument parties: ${deleteError.message}`);
      }
      const { error } = await supabase.from("title_instrument_parties").insert(indexed.map(p => ({
        job_id: jobId, run_id: null, instrument_id: r.id, party_name: p.party_name, party_name_verbatim: p.party_name_verbatim,
        role: p.role, capacity: "unknown", source_page: null, source_excerpt: INDEX_PARTY_EXCERPT,
      })));
      if (error) throw new Error(`Could not copy index parties: ${error.message}`);
    }

    if (idx.evidence_level !== SUPERSEDED_EVIDENCE_LEVEL) {
      const { error } = await supabase.from("title_instruments").update({ evidence_level: SUPERSEDED_EVIDENCE_LEVEL }).eq("id", idx.id);
      if (error) throw new Error(`Could not mark index row superseded: ${error.message}`);
      superseded++;
    }
  }
  return superseded;
}
