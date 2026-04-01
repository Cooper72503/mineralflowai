import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getSupabasePublicConfig, requireSupabasePublicConfig } from "./env";

/** Returns the current user when Supabase env is configured; otherwise null. */
export async function getSessionUser() {
  const cfg = getSupabasePublicConfig();
  if (!cfg.ok) return null;
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    return user;
  } catch {
    // Invalid/expired cookies or transient Supabase errors should not break public pages.
    return null;
  }
}

export async function createClient() {
  const { url, anonKey } = requireSupabasePublicConfig();
  const cookieStore = await cookies();

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          );
        } catch {
          // Ignore in Server Components; middleware will write cookies.
        }
      },
    },
  });
}
