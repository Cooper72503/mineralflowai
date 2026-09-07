/**
 * One-off Phase 3 validation script (not part of the app) — runs the new
 * deterministic sequencer against REAL wells via live TRRC queries and the
 * real linked Supabase project, then prints results for diffing against
 * known-good LLM-path baseline runs for the same inputs.
 *
 * Deliberately does NOT touch the production worker process/queue: each
 * new run row is inserted with status "running" directly (never
 * "pending"), so the droplet's poll loop can never claim it.
 *
 * Usage: cd worker && node --loader ts-node/esm scripts/validate-sequencer.ts <scenario>
 * where <scenario> is one of: clean_production | inactive_well | wellbore_miss | operator_name
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { runLandmanSequencer } from "../src/sequencer.js";

const envText = readFileSync(new URL("../../frontend/.env.local", import.meta.url), "utf8");
const env: Record<string, string> = {};
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const SUPABASE_URL = env["NEXT_PUBLIC_SUPABASE_URL"];
const SUPABASE_SERVICE_ROLE_KEY = env["SUPABASE_SERVICE_ROLE_KEY"];
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in frontend/.env.local");
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const USER_ID = "f015f547-5b7a-4b78-ac29-6572aa9b3d54";

interface Scenario {
  input: string;
  detected_input_type: string;
  selected_input_type: string;
  resolved_primary_api: string | null;
  operator_name: string | null;
}

const SCENARIOS: Record<string, Scenario> = {
  clean_production: {
    input: "42-165-02733",
    detected_input_type: "api_number", selected_input_type: "api_number",
    resolved_primary_api: "4216502733", operator_name: null,
  },
  inactive_well: {
    input: "4215131926",
    detected_input_type: "api_number", selected_input_type: "api_number",
    resolved_primary_api: "4215131926", operator_name: null,
  },
  wellbore_miss: {
    // create-run.ts's normalizeApiNumber truncates this specific (unusually
    // long, 11-digit) real input to "4216550208" today — reproducing
    // exactly what the real pipeline hands the sequencer, not re-deriving
    // an idealized value. This scenario exercises search_wellbore genuinely
    // missing and get_well_status catching it on a different TRRC index.
    input: "42-165-502085",
    detected_input_type: "api_number", selected_input_type: "api_number",
    resolved_primary_api: "4216550208", operator_name: null,
  },
  operator_name: {
    input: "Southwest Royalties Inc",
    detected_input_type: "operator_name", selected_input_type: "operator_name",
    resolved_primary_api: null, operator_name: "Southwest Royalties Inc",
  },
};

async function main() {
  const scenarioName = process.argv[2];
  const scenario = SCENARIOS[scenarioName];
  if (!scenario) {
    console.error(`Usage: validate-sequencer.ts <${Object.keys(SCENARIOS).join("|")}>`);
    process.exit(1);
  }

  const { data: runRow, error: insertErr } = await supabase
    .from("trrc_due_diligence_runs")
    .insert({
      user_id: USER_ID,
      original_input: scenario.input,
      normalized_input: scenario.input,
      detected_input_type: scenario.detected_input_type,
      selected_input_type: scenario.selected_input_type,
      status: "running",
      started_at: new Date().toISOString(),
      progress_percent: 2,
      resolved_primary_api: scenario.resolved_primary_api,
      resolved_district: null,
      resolved_lease_number: null,
      resolved_operator_number: null,
      operator_name: scenario.operator_name,
    })
    .select("id")
    .single();
  if (insertErr || !runRow) {
    console.error("Could not create validation run:", insertErr?.message);
    process.exit(1);
  }

  const runId = runRow["id"] as string;
  console.log(`[validate:${scenarioName}] created sequencer-mode run ${runId} for input "${scenario.input}" — running live...`);

  await runLandmanSequencer(runId, scenario.input, supabase);

  console.log(`[validate:${scenarioName}] sequencer run complete. runId=${runId}`);

  const { data: finalRow } = await supabase
    .from("trrc_due_diligence_runs")
    .select("status,result_summary,resolved_primary_api,resolved_district,resolved_lease_number,resolved_operator_number")
    .eq("id", runId)
    .single();
  console.log(`[validate:${scenarioName}] final run row:`, JSON.stringify(finalRow, null, 2));

  const { data: attempts } = await supabase
    .from("trrc_source_attempts")
    .select("source_name,status,result_count")
    .eq("run_id", runId)
    .order("source_name");
  console.log(`[validate:${scenarioName}] ${attempts?.length ?? 0} source_attempts rows:`);
  for (const a of attempts ?? []) {
    console.log(`  ${String(a["source_name"]).padEnd(28)} ${String(a["status"]).padEnd(16)} count=${a["result_count"]}`);
  }

  const { count: prodCount } = await supabase
    .from("trrc_production_monthly")
    .select("*", { count: "exact", head: true })
    .eq("run_id", runId);
  console.log(`[validate:${scenarioName}] trrc_production_monthly rows: ${prodCount}`);

  console.log(`\n[validate:${scenarioName}] RUN_ID_FOR_DIFF=${runId}`);
}

main().catch(err => {
  console.error(`[validate] fatal:`, err);
  process.exit(1);
});
