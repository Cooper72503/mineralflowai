/**
 * Links instrument tracts (and their claims) that have no canonical tract
 * yet to the job's canonical tracts by legal-description components. Used
 * for county-index rows the worker writes before any tract is confirmed,
 * and re-run before every analysis so a tract confirmed later still picks
 * up its instruments. Never links on a lease name or operator alone.
 */

import { selectAll } from "./select-all";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mapTractRow } from "./job-store";
import { tractKey } from "./tract-candidates";
import { legalDescriptionCoversTract } from "./legal-match";

export async function linkUnmatchedClaims(supabase: SupabaseClient, jobId: string): Promise<number> {
  const [{ data: canonRows }, { data: unlinked }] = await Promise.all([
    supabase.from("title_canonical_tracts").select("*").eq("job_id", jobId).neq("match_status", "rejected"),
    selectAll<Record<string, unknown>>((a, b) => supabase.from("title_instrument_tracts").select("id, county, legal_description, abstract_number, survey_name, block_number, section_name").eq("job_id", jobId).is("canonical_tract_id", null).order("id").range(a, b)),
  ]);
  const canon = ((canonRows ?? []) as Record<string, unknown>[]).map(mapTractRow);
  const byKey = new Map<string, string>();
  for (const c of canon) { const k = tractKey(c); if (k) byKey.set(k, c.id); }
  const byAbstract = new Map<string, string>();
  for (const c of canon) if (c.abstractNumber) byAbstract.set(`${(c.county ?? "").toLowerCase()}|${c.abstractNumber.replace(/\D/g, "")}`, c.id);

  let linked = 0;
  for (const t of (unlinked ?? []) as Record<string, unknown>[]) {
    const fields = {
      county: (t.county as string | null) ?? null, abstractNumber: (t.abstract_number as string | null) ?? null, surveyName: (t.survey_name as string | null) ?? null,
      blockNumber: (t.block_number as string | null) ?? null, sectionName: (t.section_name as string | null) ?? null, legalDescription: (t.legal_description as string | null) ?? null,
    };
    const k = tractKey(fields);
    let target = k ? byKey.get(k) ?? null : null;
    if (!target && fields.abstractNumber) target = byAbstract.get(`${(fields.county ?? "").toLowerCase()}|${fields.abstractNumber.replace(/\D/g, "")}`) ?? byAbstract.get(`|${fields.abstractNumber.replace(/\D/g, "")}`) ?? null;
    // County index rows carry only the clerk's free text, so the component
    // key above can never match them. Fall back to the section/block/township
    // named in that text, against confirmed tracts only.
    if (!target) target = uniqueConfirmedCover(canon, fields.county, fields.legalDescription);
    if (!target) continue;
    await supabase.from("title_instrument_tracts").update({ canonical_tract_id: target }).eq("id", t.id);
    await supabase.from("title_claims").update({ canonical_asset_id: target }).eq("instrument_tract_id", t.id);
    linked++;
  }

  // Ingestion proposes a new tract for every legal description it cannot
  // match, and parks the claim there. When OCR noise leaks into the survey
  // name ("OC WwW Ng WW T&P Ry. Co. Survey") that proposal can never equal
  // the confirmed tract, so a read instrument covering the subject section
  // stayed out of every branch. Re-point only claims sitting on such
  // machine-made proposals; anything a person confirmed or rejected is left
  // exactly as they set it.
  const machineProposals = new Set(canon.filter(c => c.matchStatus === "proposed" && c.resolutionMethod === "instrument_legal_description").map(c => c.id));
  if (machineProposals.size > 0) {
    const { data: parked } = await selectAll<Record<string, unknown>>((a, b) => supabase.from("title_instrument_tracts")
      .select("id, county, legal_description, canonical_tract_id").eq("job_id", jobId).in("canonical_tract_id", [...machineProposals]).order("id").range(a, b));
    for (const t of (parked ?? []) as Record<string, unknown>[]) {
      const target = uniqueConfirmedCover(canon, (t.county as string | null) ?? null, (t.legal_description as string | null) ?? null);
      if (!target) continue;
      await supabase.from("title_instrument_tracts").update({ canonical_tract_id: target }).eq("id", t.id);
      await supabase.from("title_claims").update({ canonical_asset_id: target }).eq("instrument_tract_id", t.id);
      linked++;
    }
  }
  return linked;
}

/** The single confirmed tract in this county the description covers, or null if none or several. */
function uniqueConfirmedCover(canon: ReturnType<typeof mapTractRow>[], county: string | null, legal: string | null): string | null {
  if (!legal) return null;
  const hits = canon.filter(c => c.matchStatus === "confirmed"
    && (!county || !c.county || c.county.trim().toLowerCase() === county.trim().toLowerCase())
    && legalDescriptionCoversTract(legal, c));
  return hits.length === 1 ? hits[0].id : null;
}
