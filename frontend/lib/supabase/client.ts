import { createBrowserClient } from "@supabase/ssr";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (typeof window !== "undefined") {
  if (!supabaseUrl || !supabaseKey) {
    console.error(
      "[Supabase] Missing env: NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are required. " +
        "Get them from Supabase Dashboard → Project Settings → API (use the anon/public key or publishable key)."
    );
  }
}

export function createClient() {
  if (!supabaseUrl || !supabaseKey) {
    throw new Error(
      "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local. " +
        "Use the anon key (JWT starting with eyJ) or publishable key (sb_publishable_...) from Project Settings → API."
    );
  }
  return createBrowserClient(supabaseUrl, supabaseKey);
}
