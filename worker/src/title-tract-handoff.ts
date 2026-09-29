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

const norm = (v: unknown) => String(v ?? "").toUpperCase().replace(/^A-?/, "").replace(/[^A-Z0-9]/g, "");
const abstractLabel = (v: string) => v ? `A-${v.replace(/^A-?/i, "")}` : null;

/**
 * The sections a well's lateral runs through, as tracts of the lease's
 * title. A pooled unit's laterals lie within the unit, so a section holding a
 * material share of a TRRC-reported lateral is confirmed from that public
 * record (never as a person's review) and cited to the GIS line. An existing
 * tract with the same survey identity is reused; a rejected one is left alone.
 */
export async function persistLateralTracts(db: SupabaseClient, jobId: string, userId: string, wells: Record<string, unknown>[]): Promise<number> {
  const { data: existingRows } = await checkedQuery(db.from("title_canonical_tracts").select("id, county, abstract_number, block_number, section_name, match_status").eq("job_id", jobId), "title tracts for lateral");
  const existing = (existingRows ?? []) as Array<{ id: string; county: string | null; abstract_number: string | null; block_number: string | null; section_name: string | null; match_status: string }>;
  const key = (county: unknown, abstract: unknown, block: unknown, section: unknown) => [county, abstract, block, section].map(norm).join("|");
  let count = 0;
  for (const well of wells) {
    if (well.resolution_status !== "resolved") continue;
    const county = string(well.county_name);
    const lateral = (well.well_path_json as { lateral?: { surveys?: Array<{ abstract_number: string; survey_name: string; block_number: string; section_name: string; share: number }>; source_url?: string } } | null)?.lateral;
    if (!county || !lateral?.surveys?.length || !lateral.source_url) continue;
    for (const s of lateral.surveys) {
      const pct = Math.round(s.share * 100);
      const trace = `TRRC GIS draws the lateral of ${well.api10} through ${s.survey_name}, Block ${s.block_number}, Section ${s.section_name} for about ${pct}% of its length (straight line from surface location to terminus). A pooled unit's laterals lie within the unit.`;
      const match = existing.find(t => key(t.county, t.abstract_number, t.block_number, t.section_name) === key(county, s.abstract_number, s.block_number, s.section_name));
      if (match?.match_status === "rejected") continue;
      let id = match?.id;
      if (!id) {
        id = stableId([jobId, "gis_lateral_survey", ...[county, s.survey_name, s.abstract_number, s.block_number, s.section_name].map(v => v.toLowerCase())]);
        const label = [s.survey_name, abstractLabel(s.abstract_number), `Block ${s.block_number}`, `Section ${s.section_name}`, `${county} County`].filter(Boolean).join(", ");
        await checkedQuery(db.from("title_canonical_tracts").upsert({
          id, job_id: jobId, run_id: null, tract_label: label, county,
          survey_name: s.survey_name, abstract_number: abstractLabel(s.abstract_number), block_number: s.block_number, section_name: s.section_name,
          legal_description: null, gross_acres: null, confidence: 0.8,
          resolution_method: "gis_lateral_path", resolution_trace: [trace],
          needs_user_selection: false, match_status: "confirmed", source_json: [{ source: "trrc_gis_lateral", url: lateral.source_url, status: "success" }],
        }, { onConflict: "id", ignoreDuplicates: true }), "title lateral tract");
        existing.push({ id, county, abstract_number: abstractLabel(s.abstract_number), block_number: s.block_number, section_name: s.section_name, match_status: "confirmed" });
      } else if (match?.match_status === "proposed") {
        await checkedQuery(db.from("title_canonical_tracts").update({ match_status: "confirmed", needs_user_selection: false }).eq("id", id).eq("match_status", "proposed"), "title lateral confirmation");
        match.match_status = "confirmed";
      }
      await checkedQuery(db.from("title_well_tract_associations").upsert({
        job_id: jobId, user_id: userId, well_id: well.id, canonical_tract_id: id,
        association_type: "well_path", confidence: 0.8, review_status: "confirmed",
        evidence_json: [{ documentId: null, instrumentId: null, page: null, sourceUrl: lateral.source_url, excerpt: trace, label: "TRRC GIS horizontal lateral" }],
      }, { onConflict: "well_id,canonical_tract_id,association_type", ignoreDuplicates: true }), "title lateral association");
      count++;
    }
  }
  return count;
}
