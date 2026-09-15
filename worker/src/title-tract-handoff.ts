import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { checkedQuery } from "./persistence.js";

const string = (x: unknown): string | null => typeof x === "string" && x.trim() ? x.trim() : null;
function stableId(parts: unknown[]): string {
  const h = createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}

/** Surface survey evidence only. It never establishes the mineral tract, unit
 * participation or ownership, even if this is the only candidate returned. */
export async function persistSurfaceTractCandidates(db: SupabaseClient, jobId: string, userId: string, wells: Record<string, unknown>[]): Promise<number> {
  let count = 0;
  for (const well of wells) {
    if (well.resolution_status !== "resolved") continue;
    const survey = string(well.survey_name), abstract = string(well.abstract_number);
    const county = string(well.county_name), block = string(well.block_number), section = string(well.section_name);
    const sources = Array.isArray(well.source_urls_json) ? well.source_urls_json : [];
    const source = sources.find(s => s?.source === "trrc_gis" && s?.status === "success" && string(s?.url));
    if (!county || (!survey && !abstract) || !source) continue;
    const identity = [county, survey, abstract, block, section].map(s => s?.toLowerCase() ?? null);
    const id = stableId([jobId, "gis_surface_location_survey", ...identity]);
    const label = [survey, abstract, block && `Block ${block}`, section && `Section ${section}`, `${county} County`].filter(Boolean).join(", ");
    const trace = `Surface survey reported by TRRC GIS for ${well.api10}; this does not establish the producing tract or ownership.`;
    const { data: existing } = await checkedQuery(db.from("title_canonical_tracts").select("id").eq("id", id).eq("job_id", jobId).maybeSingle(), "title candidate lookup");
    if (!existing) {
      await checkedQuery(db.from("title_canonical_tracts").upsert({
        id, job_id: jobId, run_id: null, tract_label: label, county,
        survey_name: survey, abstract_number: abstract, block_number: block, section_name: section,
        legal_description: null, gross_acres: null, confidence: 0.55,
        resolution_method: "gis_surface_location_survey", resolution_trace: [trace],
        needs_user_selection: true, match_status: "proposed", source_json: [source],
      }, { onConflict: "id", ignoreDuplicates: true }), "title candidate persistence");
    }
    // Ignore conflicts so a retry cannot reset a human confirmation/rejection.
    await checkedQuery(db.from("title_well_tract_associations").upsert({
      job_id: jobId, user_id: userId, well_id: well.id, canonical_tract_id: id,
      association_type: "surface_location", confidence: 0.55, review_status: "proposed",
      evidence_json: [{ documentId: null, instrumentId: null, page: null, sourceUrl: source.url,
        excerpt: trace, label: "TRRC GIS surface survey" }],
    }, { onConflict: "well_id,canonical_tract_id,association_type", ignoreDuplicates: true }), "title candidate association");
    count++;
  }
  return count;
}
