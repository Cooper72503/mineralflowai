import type { SupabaseClient } from "@supabase/supabase-js";
import { createDueDiligenceRun } from "./create-run";

/** Bounded intake, stable input order, and one explicit result per accepted row. */
export async function createDueDiligenceBatch(db: SupabaseClient, userId: string, inputs: string[]) {
  type Result = {original_input: string; ok: true; id: string; status: string; needs_user_selection: boolean; title_link_warning: string | null}
    | {original_input: string; ok: false; error: string};
  const results: Result[] = new Array(inputs.length);
  let next = 0;
  await Promise.all(Array.from({length: Math.min(3, inputs.length)}, async () => {
    while (next < inputs.length) {
      const index = next++;
      const input = inputs[index];
      try {
        const result = await createDueDiligenceRun(db, userId, {input});
        results[index] = result.ok
          ? {original_input: input, ok: true, id: result.id, status: result.status, needs_user_selection: result.needs_user_selection, title_link_warning: result.title_link_warning ?? null}
          : {original_input: input, ok: false, error: result.error};
      } catch (error) {
        console.error("[bulk intake] Entry failed:", error);
        results[index] = {original_input: input, ok: false, error: "Intake could not complete. Check run history before retrying this entry."};
      }
    }
  }));
  return results;
}
