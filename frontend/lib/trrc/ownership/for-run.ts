/**
 * Ownership and interest values for one retained run, computed exactly as
 * the diligence report computes them (same production window, identity,
 * price deck and valuation), so every report surface shows the same owners
 * and the same numbers.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TrrcDDProductionRow, TrrcDueDiligenceRun } from "../types";
import { latestSourceAttempts, type LiteSourceAttempt } from "../coverage";
import { currentProduction, reportedProductionSeries } from "../production-series";
import { computeProductionAnalytics, extractIdentity, getAttempt } from "../report-builder";
import { getPriceDeck } from "../eia-pricing";
import { loadLeaseOwnership, type LeaseOwnership } from "./mineral-roll";
import { valueLeaseInterests, producingWellCount, type InterestValuation } from "./interest-value";

export interface RunOwnership { ownership: LeaseOwnership; valuation: InterestValuation; leaseName: string | null }

export async function ownershipForRun(supabase: SupabaseClient, run: Record<string, unknown>, attemptRows: LiteSourceAttempt[]): Promise<RunOwnership> {
  const { data: prod, error } = await supabase.from("trrc_production_monthly").select("*").eq("run_id", String(run.id)).order("production_month", { ascending: false }).limit(120);
  if (error) throw new Error(`Production could not be loaded: ${error.message}`);
  const attempts = latestSourceAttempts(attemptRows).filter(a => a.source_name !== "submit_report");
  const production = currentProduction((prod ?? []) as unknown as TrrcDDProductionRow[], attempts);
  const identity = extractIdentity(attempts, run as unknown as TrrcDueDiligenceRun);
  const reported = reportedProductionSeries(computeProductionAnalytics(production).months);
  const leaseName = identity.wellName || null;
  const ownership = await loadLeaseOwnership(supabase, { leaseNumber: (run.resolved_lease_number as string | null) ?? null, leaseName });
  const proration = getAttempt(attempts, "fetch_oil_proration");
  const producingWells = producingWellCount(Array.isArray(proration?.["wells"]) ? proration!["wells"] as unknown[] : []).count;
  const valuation = valueLeaseInterests(ownership, { monthlyOilBbl: reported.oil, monthlyGasMcf: reported.gas, fieldName: identity.field || null, county: identity.county || null }, await getPriceDeck(), producingWells);
  return { ownership, valuation, leaseName };
}
