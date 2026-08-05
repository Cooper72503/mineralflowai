import type { SupabaseClient } from "@supabase/supabase-js";

export async function reportProgress(
  supabase: SupabaseClient,
  runId: string,
  pct: number,
  status: string,
): Promise<void> {
  const { error } = await supabase.from("trrc_due_diligence_runs").update({
    progress_percent: pct,
    status,
    updated_at: new Date().toISOString(),
  }).eq("id", runId);
  // Previously silently swallowed (.then(null, () => {})) — a failed write
  // here is indistinguishable, from the user's side, from the agent
  // genuinely hanging: the progress bar just stops moving, forever, with
  // no error surfaced anywhere. Log it so a real write failure shows up in
  // `pm2 logs` instead of only manifesting as "still frozen at 2%" reports
  // with nothing in the database or the console to explain why.
  if (error) {
    console.error(`[${runId.slice(0, 8)}] reportProgress(${pct}%, ${status}) failed:`, error.message);
  }
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
