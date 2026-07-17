/**
 * EWA Proxy Route
 *
 * Proxies requests to webapps2.rrc.texas.gov/EWA on behalf of the Supabase
 * Edge Function. This is necessary because Deno's rustls TLS stack refuses
 * to connect to EWA (webapps2 uses RSA key exchange without forward secrecy,
 * which rustls rejects). Node.js uses OpenSSL which supports it.
 *
 * POST /api/trrc/ewa-proxy
 * Body: { url: string, method?: string, body?: string }
 * Auth: Authorization: Bearer <TRRC_EWA_PROXY_SECRET>
 */

import { NextRequest, NextResponse } from "next/server";

const PROXY_SECRET = process.env.TRRC_EWA_PROXY_SECRET;
const EWA_ORIGIN = "https://webapps2.rrc.texas.gov";

export async function POST(req: NextRequest) {
  // Auth check
  const auth = req.headers.get("authorization") ?? "";
  if (PROXY_SECRET && auth !== `Bearer ${PROXY_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { url: string; method?: string; body?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { url, method = "GET", body: reqBody } = body;

  // Only allow requests to EWA origin
  if (!url.startsWith(EWA_ORIGIN)) {
    return NextResponse.json({ error: "Only EWA origin allowed" }, { status: 400 });
  }

  try {
    const upstream = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0 (compatible; MineralFlow/1.0)",
        "Accept": "text/html,application/xhtml+xml",
      },
      ...(reqBody ? { body: reqBody } : {}),
      signal: AbortSignal.timeout(25_000),
    });

    const html = await upstream.text();
    return NextResponse.json({ html, status: upstream.status }, { status: 200 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
