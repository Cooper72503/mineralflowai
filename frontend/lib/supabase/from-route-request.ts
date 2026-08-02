import { createClient as createSupabaseAnonClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "./server";
import { requireSupabasePublicConfig } from "./env";

/**
 * Route handlers: use Supabase with the user's JWT from `Authorization: Bearer …`
 * when present (e.g. client sent session from `getSession()`), otherwise fall back
 * to cookies. Keeps Storage + Postgres RLS aligned with the same identity for the whole request.
 *
 * Falls back to the cookie-based client if the bearer client's own token
 * doesn't actually validate. Previously, any request with a bearer header
 * always used the bearer client and never even tried cookies, no matter
 * what — confirmed live: a demonstrably valid bearer token (fresh from
 * verifyOtp, itself confirmed working directly against Supabase's own
 * /auth/v1/user endpoint) still got rejected specifically through this
 * app's deployed routes, most likely from a stale/corrupted
 * NEXT_PUBLIC_SUPABASE_ANON_KEY in that environment specifically — but
 * real, valid session cookies were sitting right there on every one of
 * these requests the whole time, never given a chance. This is the exact
 * failure mode behind the TRRC due-diligence progress page freezing at a
 * low percentage forever: every poll carried a bearer header, every poll's
 * bearer auth silently failed, and cookies — which would have worked —
 * were never tried.
 */
export async function createSupabaseFromRouteRequest(request: Request): Promise<SupabaseClient> {
  const raw = request.headers.get("authorization") ?? request.headers.get("Authorization");
  const trimmed = raw?.trim() ?? "";
  const bearer = /^Bearer\s+/i.test(trimmed) ? trimmed.replace(/^Bearer\s+/i, "").trim() : "";

  if (bearer) {
    const { url, anonKey } = requireSupabasePublicConfig();
    const bearerClient = createSupabaseAnonClient(url, anonKey, {
      global: {
        headers: { Authorization: `Bearer ${bearer}` },
      },
    });
    const { data, error } = await bearerClient.auth.getUser();
    if (!error && data.user) {
      return bearerClient;
    }
    // Bearer token was present but didn't validate — fall through to the
    // cookie-based client instead of failing the request outright.
  }

  return createClient();
}
