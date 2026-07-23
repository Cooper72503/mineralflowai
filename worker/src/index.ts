/**
 * MineralFlow TRRC Worker
 *
 * Polls Supabase for pending runs, executes the landman agent for each.
 * Runs on DigitalOcean droplet — no timeout constraints.
 *
 * Deploy:
 *   npm install && npx playwright install chromium
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... ANTHROPIC_API_KEY=... npm start
 */

import { createClient } from "@supabase/supabase-js";
import { runLandmanAgent } from "./agent.js";
import { closeBrowser } from "./tools/browser.js";

const SUPABASE_URL             = process.env.SUPABASE_URL             ?? "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const MAX_CONCURRENT           = parseInt(process.env.MAX_CONCURRENT ?? "3", 10);
const POLL_INTERVAL_MS         = parseInt(process.env.POLL_INTERVAL_MS ?? "5000", 10);

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  process.exit(1);
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is required");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const activeRuns = new Set<string>();

async function claimAndRun(runId: string, input: string): Promise<void> {
  if (activeRuns.has(runId)) return;

  // Atomic claim: update only succeeds if status is still "pending".
  // If another process already claimed it, data will be empty — we abort.
  const { data: claimed } = await supabase
    .from("trrc_due_diligence_runs")
    .update({
      status:           "running",
      progress_percent: 2,
      updated_at:       new Date().toISOString(),
    })
    .eq("id", runId)
    .eq("status", "pending")
    .select("id");

  if (!claimed || claimed.length === 0) {
    return; // lost the race to another worker process
  }

  activeRuns.add(runId);
  console.log(`[worker] starting run ${runId} — "${input}"`);

  try {
    await runLandmanAgent(runId, input, supabase);
    console.log(`[worker] completed run ${runId}`);
  } catch (err) {
    console.error(`[worker] run ${runId} failed:`, err);
    await supabase.from("trrc_due_diligence_runs").update({
      status:        "failed",
      error_summary: err instanceof Error ? err.message : String(err),
      completed_at:  new Date().toISOString(),
      updated_at:    new Date().toISOString(),
    }).eq("id", runId);
  } finally {
    activeRuns.delete(runId);
  }
}

async function poll(): Promise<void> {
  if (activeRuns.size >= MAX_CONCURRENT) return;

  const available = MAX_CONCURRENT - activeRuns.size;

  const { data: runs, error } = await supabase
    .from("trrc_due_diligence_runs")
    .select("id, original_input, normalized_input")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(available);

  if (error) {
    console.error("[worker] poll error:", error.message);
    return;
  }

  for (const run of (runs ?? [])) {
    const input = String(run["normalized_input"] ?? run["original_input"] ?? "");
    claimAndRun(String(run["id"]), input).catch(console.error);
  }
}

async function main() {
  console.log(`[worker] MineralFlow TRRC Worker starting — max ${MAX_CONCURRENT} concurrent runs`);
  console.log(`[worker] polling every ${POLL_INTERVAL_MS}ms`);

  // Graceful shutdown
  process.on("SIGTERM", async () => {
    console.log("[worker] SIGTERM received — waiting for active runs to finish");
    await closeBrowser();
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    console.log("[worker] SIGINT received");
    await closeBrowser();
    process.exit(0);
  });

  // Poll loop
  setInterval(() => { poll().catch(console.error); }, POLL_INTERVAL_MS);
  await poll(); // immediate first poll
}

main().catch(err => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
