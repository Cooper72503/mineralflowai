import { createClient as createSupabaseAnonClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "./server";
import { requireSupabasePublicConfig } from "./env";

/**
 * Route handlers: use Supabase with the user's JWT from `Authorization: Bearer …`
 * when present (e.g. client sent session from `getSession()`), otherwise fall back
 * to cookies. Keeps Storage + Postgres RLS aligned with the same identity for the whole request.
 */
export async function createSupabaseFromRouteRequest(request: Request): Promise<SupabaseClient> {
  const raw = request.headers.get("authorization") ?? request.headers.get("Authorization");
  const trimmed = raw?.trim() ?? "";
  const bearer = /^Bearer\s+/i.test(trimmed) ? trimmed.replace(/^Bearer\s+/i, "").trim() : "";

  if (bearer) {
    const { url, anonKey } = requireSupabasePublicConfig();
    return createSupabaseAnonClient(url, anonKey, {
      global: {
        headers: { Authorization: `Bearer ${bearer}` },
      },
    });
  }

  return createClient();
}
