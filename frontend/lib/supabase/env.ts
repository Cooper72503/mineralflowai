export type SupabasePublicConfig =
  | { ok: true; url: string; anonKey: string }
  | { ok: false };

export function getSupabasePublicConfig(): SupabasePublicConfig {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!url || !anonKey) return { ok: false };
  return { ok: true, url, anonKey };
}

export function requireSupabasePublicConfig(): { url: string; anonKey: string } {
  const c = getSupabasePublicConfig();
  if (!c.ok) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY"
    );
  }
  return { url: c.url, anonKey: c.anonKey };
}
