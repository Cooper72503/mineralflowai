import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";

export function createClient(): SupabaseClient {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:0",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "missing-anon-key"
  );
}
