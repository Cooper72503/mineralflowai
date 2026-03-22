import { createBrowserClient } from "@supabase/ssr";
import { createClient as createSupabaseJsClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Placeholder project used only during SSR/SSG when env is unset so prerender does not throw.
 * Real requests still fail until env is configured; the browser path throws below.
 */
const BUILD_PLACEHOLDER_URL = "https://build-placeholder.supabase.co";
const BUILD_PLACEHOLDER_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJvbGUiOiJhbm9uIn0.build-placeholder";

/**
 * `createBrowserClient` uses cookie storage whose setAll throws in non-browser runtimes
 * (including Next.js page data collection). Use the JS client with persistence off for SSR/build.
 */
function createSsrSafeClient(url: string, key: string): SupabaseClient {
  return createSupabaseJsClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

export function createClient(): SupabaseClient {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

  // Never attach the real project during SSR, SSG, or `next build` page data collection.
  // Client components still run once on the server; a real GoTrue client here can block or hang the build.
  if (typeof window === "undefined") {
    return createSsrSafeClient(BUILD_PLACEHOLDER_URL, BUILD_PLACEHOLDER_ANON_KEY);
  }

  if (supabaseUrl && supabaseKey) {
    return createBrowserClient(supabaseUrl, supabaseKey);
  }

  console.error(
    "[Supabase] Missing env: NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are required. " +
      "Get them from Supabase Dashboard → Project Settings → API (use the anon/public key or publishable key)."
  );
  throw new Error(
    "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local. " +
      "Use the anon key (JWT starting with eyJ) or publishable key (sb_publishable_...) from Project Settings → API."
  );
}
