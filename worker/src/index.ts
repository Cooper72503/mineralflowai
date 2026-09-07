/**
 * MineralFlow TRRC Worker
 *
 * Polls Supabase for pending runs, executes the deterministic TRRC
 * sequencer for each. Runs on DigitalOcean droplet — no timeout
 * constraints.
 *
 * Deploy:
 *   npm install && npx playwright install chromium
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm start
 *
 * This worker has no runtime LLM-vendor dependency of any kind — the
 * retrieval loop that used to be Claude-orchestrated (agent.ts,
 * tools/definitions.ts, both deleted) is now real, deterministic control
 * flow (sequencer.ts). See the project plan "Deterministic TRRC
 * Sequencer — Remove the Anthropic Runtime Dependency" (Phases 0-5) for
 * the full rationale, the characterization tests that proved parity
 * before the cutover, and the live-traffic validation (5 real scenarios,
 * 2026-09-03) that gated it. A source-tree search for the SDK package
 * name this worker used to import returns nothing outside this sentence
 * — that's the concrete, checkable artifact behind the "doesn't depend
 * on any LLM" claim.
 */

import { createClient } from "@supabase/supabase-js";
import { runLandmanSequencer } from "./sequencer.js";
import { closeBrowser } from "./tools/browser.js";

const SUPABASE_URL             = process.env.SUPABASE_URL             ?? "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const MAX_CONCURRENT           = parseInt(process.env.MAX_CONCURRENT ?? "3", 10);
const POLL_INTERVAL_MS         = parseInt(process.env.POLL_INTERVAL_MS ?? "5000", 10);

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  process.exit(1);
}

// Every request header (Anthropic x-api-key, Supabase auth, Cookie) must be a
// valid ByteString — any character above code point 255 makes fetch() throw
// before a single request goes out, and every run in the queue fails silently
// with no source_attempts recorded. This is a real incident: a copy-pasted
// masked key display (e.g. "sk-ant-a•••...") once made every run fail this way
// with zero visibility into why. Fail loudly at boot instead of at request time.
function assertCleanSecret(name: string, value: string): void {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code > 255) {
      console.error(
        `[worker] ${name} contains a non-ByteString character at index ${i} ` +
        `(code point ${code}, "${value[i]}"). This is usually a masked/redacted ` +
        `key pasted by mistake instead of the real secret. Refusing to start.`,
      );
      process.exit(1);
    }
  }
}

assertCleanSecret("SUPABASE_URL", SUPABASE_URL);
assertCleanSecret("SUPABASE_SERVICE_ROLE_KEY", SUPABASE_SERVICE_ROLE_KEY);

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
    await runLandmanSequencer(runId, input, supabase);
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

// This process is the only writer to "running" rows (single fork-mode
// instance — see deploy.sh). On a fresh boot, activeRuns is empty, so any
// row still marked "running" cannot belong to in-flight work in this
// process; it can only be orphaned by a previous crash, deploy, or restart
// that killed the process mid-run (SIGTERM/SIGINT below don't actually
// drain in-flight runs before exiting). Confirmed live: a `pm2 restart`
// during an active run left it stuck at status="running" forever, with no
// recovery path — the retry endpoint's allowlist doesn't even include
// "running". Reset those rows back to "pending" so the poll loop below
// picks them up again instead of leaving the user staring at a progress
// bar that will never move.
async function recoverStaleRuns(): Promise<void> {
  const { data: recovered, error } = await supabase
    .from("trrc_due_diligence_runs")
    .update({ status: "pending", progress_percent: 0, updated_at: new Date().toISOString() })
    .eq("status", "running")
    .select("id");

  if (error) {
    console.error("[worker] failed to recover stale running runs:", error.message);
    return;
  }
  if (recovered && recovered.length > 0) {
    console.log(`[worker] recovered ${recovered.length} run(s) stuck in "running" from a previous process: ${recovered.map(r => r["id"]).join(", ")}`);
  }

}

async function main() {
  console.log(`[worker] MineralFlow TRRC Worker starting — max ${MAX_CONCURRENT} concurrent runs — standalone sequencer, no LLM dependency`);
  console.log(`[worker] polling every ${POLL_INTERVAL_MS}ms`);

  await recoverStaleRuns();

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
