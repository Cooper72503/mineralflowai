/**
 * EWA Proxy Route
 *
 * Proxies requests to webapps2.rrc.texas.gov on behalf of the Supabase
 * Edge Function. Deno's rustls TLS stack refuses to connect to webapps2
 * (RSA key exchange without forward secrecy). Node.js/OpenSSL supports it.
 *
 * Covers the full webapps2.rrc.texas.gov origin:
 *   /EWA/   — wellbore, production, lease queries
 *   /PDA/   — ICE compliance & violations portal (JSF/PrimeFaces)
 *
 * POST /api/trrc/ewa-proxy
 * Body: {
 *   url:            string                     — full target URL
 *   method?:        string                     — default "GET"
 *   body?:          string                     — request body
 *   cookies?:       string                     — Cookie header value (for session maintenance)
 *   extra_headers?: Record<string, string>     — additional headers (e.g. Faces-Request for JSF AJAX)
 * }
 * Response: { html: string, status: number, set_cookie: string[] }
 * Auth: Authorization: Bearer <TRRC_EWA_PROXY_SECRET>
 */

import { NextRequest, NextResponse } from "next/server";

const PROXY_SECRET = process.env.TRRC_EWA_PROXY_SECRET;
const EWA_ORIGIN   = "https://webapps2.rrc.texas.gov";

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  if (PROXY_SECRET && auth !== `Bearer ${PROXY_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    url: string;
    method?: string;
    body?: string;
    cookies?: string;
    extra_headers?: Record<string, string>;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { url, method = "GET", body: reqBody, cookies, extra_headers } = body;

  if (!url.startsWith(EWA_ORIGIN)) {
    return NextResponse.json({ error: "Only webapps2.rrc.texas.gov origin allowed" }, { status: 400 });
  }

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent":   "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept":       "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      ...(cookies       ? { "Cookie": cookies }   : {}),
      ...(extra_headers ?? {}),
    };

    const upstream = await fetch(url, {
      method,
      headers,
      ...(reqBody ? { body: reqBody } : {}),
      signal: AbortSignal.timeout(25_000),
    });

    const html = await upstream.text();

    // Collect all Set-Cookie headers so the edge function can maintain sessions
    const rawSetCookie = upstream.headers.get("set-cookie");
    const setCookies   = rawSetCookie ? [rawSetCookie] : [];

    return NextResponse.json(
      { html, status: upstream.status, set_cookie: setCookies },
      { status: 200 },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
