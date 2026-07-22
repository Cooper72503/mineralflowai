/**
 * GET /api/auth/signout
 *
 * Hard-navigation sign-out target. The browser navigates here via window.location.href
 * (not fetch) so no ByteString error fires even if the session cookie is corrupted.
 *
 * Steps:
 *  1. Best-effort server-side Supabase signOut (no-op if session is corrupted)
 *  2. Forcibly expire every known Supabase auth cookie chunk
 *  3. Redirect to /login
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Supabase project ref — determines cookie names
const PROJECT_REF = "mevttpgjaeqxccmqitax";

export async function GET(request: NextRequest) {
  // Best-effort signout — silently swallow all errors (session may be corrupted)
  try {
    const supabase = await createClient();
    await supabase.auth.signOut();
  } catch {
    // proceed
  }

  const response = NextResponse.redirect(new URL("/login", request.url));

  // Expire the base token cookie and up to 5 chunks (.0 through .4)
  const names = [
    `sb-${PROJECT_REF}-auth-token`,
    ...Array.from({ length: 5 }, (_, i) => `sb-${PROJECT_REF}-auth-token.${i}`),
  ];
  for (const name of names) {
    response.cookies.set(name, "", {
      expires: new Date(0),
      path: "/",
      sameSite: "lax",
      secure: true,
    });
  }

  return response;
}
