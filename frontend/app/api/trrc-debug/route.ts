/**
 * Debug endpoint — shows exactly what TRRC returns for a given API number.
 * Used to diagnose which query strategy resolves correctly.
 *
 * GET /api/trrc-debug?api=15131926
 */
import { NextResponse } from "next/server";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EWA = "https://webapps2.rrc.texas.gov/EWA";

async function queryTrrc(params: Record<string, string>, label: string) {
  const body = new URLSearchParams(params);
  try {
    const res = await fetch(`${EWA}/wellboreQueryAction.do`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "Mozilla/5.0" },
      body: body.toString(),
      signal: AbortSignal.timeout(12_000),
    });
    const html = await res.text();

    // Count apiNo links
    const apiLinks: RegExpExecArray[] = [];
    const leaseLinks: RegExpExecArray[] = [];
    const opLinks: RegExpExecArray[] = [];
    const reApi   = /apiNo=(\d+)&distCode=(\w+)&leaseNo=(\d+)/g;
    const reLease = /leaseDetailAction\.do[^"']*distCode=([A-Z0-9]+)[^"']*leaseNo=(\d+)/gi;
    const reOp    = /title="Operator # \d+">(.*?)<\/a>/g;
    let m: RegExpExecArray | null;
    while ((m = reApi.exec(html))   !== null) apiLinks.push(m);
    while ((m = reLease.exec(html)) !== null) leaseLinks.push(m);
    while ((m = reOp.exec(html))    !== null) opLinks.push(m);

    return {
      label,
      status: res.status,
      html_length: html.length,
      api_no_links_found: apiLinks.length,
      lease_detail_links_found: leaseLinks.length,
      operator_links_found: opLinks.length,
      first_5_api_links: apiLinks.slice(0, 5).map(m => ({
        apiNo8: m[1], distCode: m[2], leaseNo: m[3],
      })),
      first_5_lease_links: leaseLinks.slice(0, 5).map(m => ({
        distCode: m[1], leaseNo: m[2],
      })),
      // First 500 chars of html for structure clues
      html_snippet: html.slice(0, 500).replace(/\s+/g, " "),
    };
  } catch (err) {
    return { label, error: String(err), status: 0, html_length: 0 };
  }
}

export async function GET(request: Request) {
  const supabase = await createSupabaseFromRouteRequest(request);
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const url = new URL(request.url);
  const rawApi = url.searchParams.get("api") ?? "15131926";

  // Normalise: strip non-digits
  const digits = rawApi.replace(/\D/g, "");
  const api8 = digits.length === 10 && digits.startsWith("42") ? digits.slice(2) : digits.slice(0, 8);
  const county3 = api8.slice(0, 3);   // "151"
  const well5   = api8.slice(3);      // "31926"
  const prefix5 = "42" + county3;     // "42151"

  const results = await Promise.all([
    // Strategy A: countyCodeArg + apiNoSuffixArg (current approach)
    queryTrrc({
      methodToCall: "search",
      "searchArgs.countyCodeArg": county3,
      "searchArgs.apiNoSuffixArg": well5,
      "searchArgs.wellTypeArg": "",
      "pager.pageSize": "25",
    }, `A: countyCode=${county3} + suffix=${well5}`),

    // Strategy B: apiNoPrefixArg (county only, 3-digit) + apiNoSuffixArg
    queryTrrc({
      methodToCall: "search",
      "searchArgs.apiNoPrefixArg": county3,
      "searchArgs.apiNoSuffixArg": well5,
      "searchArgs.wellTypeArg": "",
      "pager.pageSize": "25",
    }, `B: prefix=${county3} + suffix=${well5}`),

    // Strategy C: apiNoPrefixArg (full 5-digit state+county) + apiNoSuffixArg
    queryTrrc({
      methodToCall: "search",
      "searchArgs.apiNoPrefixArg": prefix5,
      "searchArgs.apiNoSuffixArg": well5,
      "searchArgs.wellTypeArg": "",
      "pager.pageSize": "25",
    }, `C: prefix=${prefix5} + suffix=${well5}`),

    // Strategy D: countyCodeArg only, pageSize=25 (to see sort order)
    queryTrrc({
      methodToCall: "search",
      "searchArgs.countyCodeArg": county3,
      "searchArgs.wellTypeArg": "PR",
      "pager.pageSize": "25",
    }, `D: countyCode=${county3} only, first 25`),

    // Strategy E: countyCodeArg only, pageSize=500
    queryTrrc({
      methodToCall: "search",
      "searchArgs.countyCodeArg": county3,
      "searchArgs.wellTypeArg": "PR",
      "pager.pageSize": "500",
    }, `E: countyCode=${county3} only, pageSize=500`),

    // Strategy F: suffix only, no county
    queryTrrc({
      methodToCall: "search",
      "searchArgs.apiNoSuffixArg": well5,
      "searchArgs.wellTypeArg": "",
      "pager.pageSize": "25",
    }, `F: suffix=${well5} only (no county)`),
  ]);

  return NextResponse.json({
    input: { rawApi, api8, county3, well5, prefix5 },
    results,
  }, { status: 200 });
}
