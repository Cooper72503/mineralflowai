import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getSupabasePublicConfig } from "@/lib/supabase/env";

const PROTECTED_PREFIXES = [
  "/dashboard",
  "/documents",
  "/leads",
  "/alerts",
  "/upload",
  "/settings",
  "/billing",
];

const AUTH_PATHS_EXACT = new Set(["/login", "/signup"]);

function isProtected(pathname: string) {
  return PROTECTED_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`)
  );
}

function isAuthPage(pathname: string) {
  return AUTH_PATHS_EXACT.has(pathname);
}

/** Preserve full Set-Cookie headers (httpOnly, max-age, SameSite, etc.) on redirects. */
function redirectPreservingSetCookies(
  url: URL,
  sourceResponse: NextResponse
): NextResponse {
  const redirectResponse = NextResponse.redirect(url);
  const list =
    typeof sourceResponse.headers.getSetCookie === "function"
      ? sourceResponse.headers.getSetCookie()
      : [];
  for (const cookieHeader of list) {
    redirectResponse.headers.append("Set-Cookie", cookieHeader);
  }
  return redirectResponse;
}

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  const cfg = getSupabasePublicConfig();
  if (!cfg.ok) {
    console.error(
      "[Supabase middleware] Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY."
    );
    if (isProtected(pathname)) {
      console.log("MIDDLEWARE REDIRECT TO LOGIN", pathname);
      return NextResponse.redirect(new URL("/login", request.url));
    }
    return NextResponse.next({ request });
  }

  const { url: supabaseUrl, anonKey: supabaseKey } = cfg;

  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(supabaseUrl, supabaseKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        // NextRequest cookies accept name/value only; full attributes go on the response.
        cookiesToSet.forEach(({ name, value }) => {
          request.cookies.set(name, value);
        });
        supabaseResponse = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => {
          supabaseResponse.cookies.set(name, value, options);
        });
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    console.log("MIDDLEWARE SESSION FOUND", pathname);
  }

  if (user && pathname === "/login") {
    console.log("MIDDLEWARE REDIRECT TO DASHBOARD", pathname);
    return redirectPreservingSetCookies(
      new URL("/dashboard", request.url),
      supabaseResponse
    );
  }

  if (!user && isProtected(pathname)) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("redirect", pathname);
    console.log("MIDDLEWARE REDIRECT TO LOGIN", pathname);
    return redirectPreservingSetCookies(loginUrl, supabaseResponse);
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
