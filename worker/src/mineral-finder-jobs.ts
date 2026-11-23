import type { SupabaseClient } from "@supabase/supabase-js";
import { checkedQuery } from "./persistence.js";
import { getProduction } from "./tools/ewa.js";

const url = new URL("../dist/mineral-finder-engine.mjs", import.meta.url).href;
type Engine = (
  db: SupabaseClient,
  criteria: any,
  query: string,
  adapters: any,
) => Promise<any>;
const defaultEngine: Engine = async (...args) =>
  (await import(url)).runFinder(...args);

/** One durable research run at a time; expired claims recover after restart. */
export async function processMineralFinder(
  db: SupabaseClient,
  engine: Engine = defaultEngine,
): Promise<void> {
  const { data } = await checkedQuery(
    db.rpc("claim_mineral_finder"),
    "Finder claim",
  );
  const job = data?.[0];
  if (!job) return;
  const controller = new AbortController();
  const update = async (patch: Record<string, unknown>) => {
    const { data: rows } = await checkedQuery(
      db
        .from("mineral_finder_jobs")
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("id", job.id)
        .eq("claim_token", job.claim_token)
        .eq("status", "running")
        .select("id"),
      "Finder fenced update",
    );
    if (!rows?.length) {
      controller.abort();
      throw Error("Finder job claim lost");
    }
  };
  let heartbeatError: unknown = null;
  let heartbeatActive = false;
  const timer = setInterval(() => {
    if (heartbeatActive) return;
    heartbeatActive = true;
    update({ lease_until: new Date(Date.now() + 20 * 60_000).toISOString() })
      .catch((e) => {
        heartbeatError = e;
        controller.abort();
      })
      .finally(() => {
        heartbeatActive = false;
      });
  }, 60_000);
  try {
    const result = await engine(
      db,
      job.request_json.criteria,
      job.request_json.query,
      {
        production: getProduction,
        begMetadataEnabled:
          process.env.MINERAL_FINDER_BEG_METADATA_ACCESS === "approved",
        progress: (stage: string) =>
          update({
            stage,
            lease_until: new Date(Date.now() + 20 * 60_000).toISOString(),
          }),
        signal: controller.signal,
      },
    );
    if (heartbeatError) throw heartbeatError;
    const { data: saved } = await checkedQuery(
      db.rpc("finish_mineral_finder", {
        p_id: job.id,
        p_token: job.claim_token,
        p_result: result,
      }),
      "Finder publication",
    );
    if (!saved)
      throw Error("Finder publication rejected: expired or replaced claim");
    console.log(
      `[finder ${job.id}] ${result.prospects.length} research leads; ${result.wells} county wells; no acquisition approval asserted`,
    );
  } catch (error) {
    console.error(`[finder ${job.id}]`, error);
    await update({
      status: "failed",
      stage: "Research failed; source results were not sealed",
      error_summary: error instanceof Error ? error.message : String(error),
      claim_token: null,
      lease_until: null,
    });
  } finally {
    clearInterval(timer);
  }
}
