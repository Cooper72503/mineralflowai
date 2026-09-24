/**
 * Wells on one TRRC lease share that lease's tracts.
 *
 * A TRRC oil lease number identifies one regulatory lease or pooled unit, and
 * production is reported for the lease as a whole. When one well on the lease
 * has a confirmed association to a tract, every other well on the same
 * district and lease number is associated with that tract as a unit tract.
 * Live case: 12 CMC BUTTERCUP 25-37 UNIT wells on lease 08-59990; only one
 * had a confirmed association (its GIS surface location in Sec 37 Blk 39
 * T4S), so GOLD withheld title for the other eleven although the county index
 * records an instrument to the CMC BUTTERCUP UNIT against that same tract.
 *
 * This propagates tract membership, never ownership or a share. A rejected
 * association is never overridden, and only associations a person confirmed
 * are propagated — never ones this rule itself created.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { selectAll } from "./select-all";

export const LEASE_PROPAGATION_LABEL = "Same TRRC lease as a well with a confirmed tract association";

export async function propagateLeaseAssociations(supabase: SupabaseClient, jobId: string, userId: string): Promise<number> {
  const [wellsRes, assocRes] = await Promise.all([
    selectAll<Record<string, unknown>>((a, b) => supabase.from("title_job_wells").select("id, api10, district, lease_number, resolution_status").eq("job_id", jobId).order("id").range(a, b)),
    selectAll<Record<string, unknown>>((a, b) => supabase.from("title_well_tract_associations").select("id, well_id, canonical_tract_id, association_type, review_status, confidence, evidence_json").eq("job_id", jobId).order("id").range(a, b)),
  ]);
  if (wellsRes.error) throw new Error(`Could not load title wells: ${wellsRes.error.message}`);
  if (assocRes.error) throw new Error(`Could not load tract associations: ${assocRes.error.message}`);

  const leaseKey = (w: Record<string, unknown>) =>
    w.resolution_status === "resolved" && w.district && w.lease_number ? `${String(w.district).padStart(2, "0")}-${String(w.lease_number)}` : null;
  const wells = wellsRes.data;
  const byLease = new Map<string, Record<string, unknown>[]>();
  for (const w of wells) { const k = leaseKey(w); if (k) byLease.set(k, [...(byLease.get(k) ?? []), w]); }

  const propagated = (a: Record<string, unknown>) => Array.isArray(a.evidence_json) && (a.evidence_json as Array<{ label?: string }>).some(e => e.label === LEASE_PROPAGATION_LABEL);
  let created = 0;
  for (const [lease, members] of byLease) {
    const memberIds = new Set(members.map(m => String(m.id)));
    // Tracts a person confirmed for any well on this lease.
    const sources = assocRes.data.filter(a => memberIds.has(String(a.well_id)) && a.review_status === "confirmed" && !propagated(a));
    for (const source of sources) {
      const tractId = String(source.canonical_tract_id);
      const fromWell = wells.find(w => String(w.id) === String(source.well_id));
      for (const m of members) {
        if (String(m.id) === String(source.well_id)) continue;
        const existing = assocRes.data.filter(a => String(a.well_id) === String(m.id) && String(a.canonical_tract_id) === tractId);
        if (existing.some(a => a.review_status === "confirmed" || a.review_status === "rejected")) continue;
        const evidence = [{
          documentId: null, instrumentId: null, page: null, sourceUrl: null, label: LEASE_PROPAGATION_LABEL,
          excerpt: `API ${String(m.api10)} and API ${String(fromWell?.api10)} are both on TRRC lease ${lease}. ${String(fromWell?.api10)}'s association to this tract was confirmed. Lease membership establishes a shared tract, not a share of production or ownership.`,
        }];
        const existingUnit = existing.find(a => a.association_type === "lease_unit_boundary");
        if (existingUnit) {
          const { error } = await supabase.from("title_well_tract_associations").update({ review_status: "confirmed", evidence_json: evidence, confidence: source.confidence }).eq("id", existingUnit.id).eq("review_status", "proposed");
          if (error) throw new Error(`Could not confirm lease association: ${error.message}`);
        } else {
          const { error } = await supabase.from("title_well_tract_associations").insert({
            job_id: jobId, user_id: userId, well_id: m.id, canonical_tract_id: tractId, association_type: "lease_unit_boundary",
            confidence: source.confidence, review_status: "confirmed", evidence_json: evidence,
          });
          if (error) throw new Error(`Could not record lease association: ${error.message}`);
        }
        created++;
      }
    }
  }
  return created;
}
