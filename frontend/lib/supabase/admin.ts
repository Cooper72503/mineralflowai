import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Server-only client that bypasses RLS. Set SUPABASE_SERVICE_ROLE_KEY in the environment
 * so deal processing can load every user's alert preferences.
 */
export function createServiceRoleClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
