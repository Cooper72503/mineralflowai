/**
 * Links instrument tracts (and their claims) that have no canonical tract
 * yet to the job's canonical tracts by legal-description components. Used
 * for county-index rows the worker writes before any tract is confirmed,
 * and re-run before every analysis so a tract confirmed later still picks
 * up its instruments. Never links on a lease name or operator alone.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { mapTractRow } from "./job-store";
import { tractKey } from "./tract-candidates";

export async function linkUnmatchedClaims(supabase: SupabaseClient, jobId: string): Promise<number> {
  const [{ data: canonRows }, { data: unlinked }] = await Promise.all([
    supabase.from("title_canonical_tracts").select("*").eq("job_id", jobId).neq("match_status", "rejected"),
    supabase.from("title_instrument_tracts").select("id, county, legal_description, abstract_number, survey_name, block_number, section_name").eq("job_id", jobId).is("canonical_tract_id", null),
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
    if (!target) continue;
    await supabase.from("title_instrument_tracts").update({ canonical_tract_id: target }).eq("id", t.id);
    await supabase.from("title_claims").update({ canonical_asset_id: target }).eq("instrument_tract_id", t.id);
    linked++;
  }
  return linked;
}
