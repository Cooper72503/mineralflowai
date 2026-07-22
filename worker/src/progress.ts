import type { SupabaseClient } from "@supabase/supabase-js";

export async function reportProgress(
  supabase: SupabaseClient,
  runId: string,
  pct: number,
  status: string,
): Promise<void> {
  await supabase.from("trrc_due_diligence_runs").update({
    progress_percent: pct,
    status,
    updated_at: new Date().toISOString(),
  }).eq("id", runId).then(null, () => {});
}

export async function logStep(
  supabase: SupabaseClient,
  runId: string,
  tool: string,
  phase: "running" | "done" | "failed",
  detail?: string,
): Promise<void> {
  console.log(`[${runId.slice(0, 8)}] ${tool} → ${phase}${detail ? ` — ${detail}` : ""}`);
}
