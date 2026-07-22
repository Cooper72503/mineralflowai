export type SupabasePublicConfig =
  | { ok: true; url: string; anonKey: string }
  | { ok: false };

/** Log any non-ASCII character in an env var value so Vercel logs expose corrupted keys. */
function warnNonAscii(label: string, value: string): void {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code > 127) {
      console.error(
        `[supabase/env] CRITICAL: ${label} contains non-ASCII character at index ${i}: ` +
        `U+${code.toString(16).toUpperCase().padStart(4, "0")} (decimal ${code}). ` +
        `This causes ByteString errors in fetch() calls. Fix the Vercel environment variable.`
      );
    }
  }
}

export function getSupabasePublicConfig(): SupabasePublicConfig {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!url || !anonKey) return { ok: false };
  if (typeof process !== "undefined" && typeof process.env !== "undefined") {
    // Only log server-side (NEXT_PUBLIC vars are available on both sides; this avoids
    // redundant browser-console noise while keeping Vercel function logs clean)
    if (typeof window === "undefined") {
      warnNonAscii("NEXT_PUBLIC_SUPABASE_ANON_KEY", anonKey);
      warnNonAscii("NEXT_PUBLIC_SUPABASE_URL", url);
    }
  }
  // Strip any non-ASCII characters that may have been introduced by copy-paste corruption.
  // The anon key is base64url + underscores — all ASCII. Any char > 127 is garbage.
  const cleanAnonKey = anonKey.replace(/[^\x00-\x7F]/g, "");
  const cleanUrl = url.replace(/[^\x00-\x7F]/g, "");
  if (!cleanAnonKey || !cleanUrl) return { ok: false };
  return { ok: true, url: cleanUrl, anonKey: cleanAnonKey };
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
