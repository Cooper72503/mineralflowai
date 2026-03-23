import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabasePublicConfig } from "./env";

/** Browser client uses @supabase/ssr so auth is stored in cookies; middleware/server use the same cookie contract. */
export function createClient(): SupabaseClient {
  const { url, anonKey } = requireSupabasePublicConfig();
  return createBrowserClient(url, anonKey);
}
