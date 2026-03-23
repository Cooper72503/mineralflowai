import { createServerClient, serializeCookieHeader } from "@supabase/ssr";
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

type CookieWrite = {
  name: string;
  value: string;
  options?: Parameters<typeof serializeCookieHeader>[2];
};

/**
 * Forwards Supabase auth cookies onto a redirect without dropping attributes.
 * Prefer raw Set-Cookie lines from the source response; if none are exposed,
 * rebuild from the same name/value/options Supabase passed to setAll.
 */
function redirectWithCookies(
  url: URL,
  sourceResponse: NextResponse,
  cookieWritesFallback: Map<string, CookieWrite>
): NextResponse {
  const redirectResponse = NextResponse.redirect(url);
  const list =
    typeof sourceResponse.headers.getSetCookie === "function"
      ? sourceResponse.headers.getSetCookie()
      : [];
  if (list.length > 0) {
    for (const cookieHeader of list) {
      redirectResponse.headers.append("Set-Cookie", cookieHeader);
    }
    return redirectResponse;
  }
  for (const { name, value, options } of Array.from(
    cookieWritesFallback.values()
  )) {
    redirectResponse.headers.append(
      "Set-Cookie",
      serializeCookieHeader(name, value, options ?? {})
    );
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
  const cookieWritesForRedirect = new Map<string, CookieWrite>();

  const supabase = createServerClient(supabaseUrl, supabaseKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => {
          request.cookies.set(name, value);
        });
        supabaseResponse = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => {
          supabaseResponse.cookies.set(name, value, options);
          cookieWritesForRedirect.set(name, { name, value, options });
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
    return redirectWithCookies(
      new URL("/dashboard", request.url),
      supabaseResponse,
      cookieWritesForRedirect
    );
  }

  if (!user && isProtected(pathname)) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("redirect", pathname);
    console.log("MIDDLEWARE REDIRECT TO LOGIN", pathname);
    return redirectWithCookies(
      loginUrl,
      supabaseResponse,
      cookieWritesForRedirect
    );
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
