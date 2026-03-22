import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Placeholder project used only during SSR/SSG when env is unset so prerender does not throw.
 * Real requests still fail until env is configured; the browser path throws below.
 */
const BUILD_PLACEHOLDER_URL = "https://build-placeholder.supabase.co";
const BUILD_PLACEHOLDER_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJvbGUiOiJhbm9uIn0.build-placeholder";

export function createClient(): SupabaseClient {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

  if (supabaseUrl && supabaseKey) {
    return createBrowserClient(supabaseUrl, supabaseKey);
  }

  if (typeof window !== "undefined") {
    console.error(
      "[Supabase] Missing env: NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are required. " +
        "Get them from Supabase Dashboard → Project Settings → API (use the anon/public key or publishable key)."
    );
    throw new Error(
      "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local. " +
        "Use the anon key (JWT starting with eyJ) or publishable key (sb_publishable_...) from Project Settings → API."
    );
  }

  return createBrowserClient(BUILD_PLACEHOLDER_URL, BUILD_PLACEHOLDER_ANON_KEY);
}
