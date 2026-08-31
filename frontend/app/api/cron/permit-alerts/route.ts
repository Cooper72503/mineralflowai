/**
 * GET /api/cron/permit-alerts
 *
 * Triggered by Vercel Cron (see vercel.json). Checks every active,
 * SMS-enabled permit-alert subscription belonging to a PAID user, searches
 * TRRC once for new-drill filings across the union of their watched
 * counties, and texts each affected subscriber — skipping any (permit,
 * user) pair already recorded in permit_alert_sent so overlapping lookback
 * windows across runs never double-text anyone.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/admin";
import { searchNewDrillPermits } from "@/lib/trrc/permit-tracker/fetch-permits";
import { sendPermitAlertSms } from "@/lib/notifications/sms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// How far back to search on every run. Wider than the cron interval on
// purpose — permit_alert_sent (not this window) is what actually prevents
// duplicate texts, so a missed or delayed run self-heals on the next one
// instead of silently skipping filings.
const LOOKBACK_DAYS = 3;

interface Subscription {
  user_id: string;
  phone_number: string | null;
  counties: string[];
}

function isAuthorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  // Fail closed: an unconfigured secret means this endpoint refuses every
  // request rather than silently running unauthenticated (the same
  // "unconfigured env var must never mean 'skip enforcement'" lesson from
  // the ambrose-app data-leak incident).
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  const supabase = createServiceRoleClient();
  if (!supabase) {
    return NextResponse.json({ ok: false, error: "Service role not configured." }, { status: 500 });
  }

  // 1. Load enabled subscriptions with a phone number.
  const { data: subsRaw, error: subsError } = await supabase
    .from("permit_alert_subscriptions")
    .select("user_id, phone_number, counties")
    .eq("sms_enabled", true)
    .not("phone_number", "is", null);

  if (subsError) {
    return NextResponse.json({ ok: false, error: subsError.message }, { status: 500 });
  }

  const allSubs = (subsRaw ?? []) as Subscription[];
  if (allSubs.length === 0) {
    return NextResponse.json({ ok: true, data: { checked: 0, sent: 0 } });
  }

  // 2. Paid-plan gate — enforced here too, not just in the UI, since a
  // subscription row surviving a lapsed plan (e.g. a downgrade) must never
  // still cost real SMS spend.
  const userIds = Array.from(new Set(allSubs.map((s) => s.user_id)));
  const { data: profiles, error: profilesError } = await supabase
    .from("profiles")
    .select("id, subscription_status")
    .in("id", userIds);

  if (profilesError) {
    return NextResponse.json({ ok: false, error: profilesError.message }, { status: 500 });
  }

  const paidUserIds = new Set(
    (profiles ?? []).filter((p) => p.subscription_status === "active").map((p) => p.id)
  );
  const subs = allSubs.filter((s) => paidUserIds.has(s.user_id) && s.counties.length > 0);
  if (subs.length === 0) {
    return NextResponse.json({ ok: true, data: { checked: 0, sent: 0 } });
  }

  // 3. One shared TRRC search across the union of every watched county —
  // never one search per subscriber.
  const counties = Array.from(new Set(subs.flatMap((s) => s.counties)));
  const until = new Date();
  const since = new Date(until.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  let searchResult;
  try {
    searchResult = await searchNewDrillPermits({ counties, since, until });
  } catch (err) {
    const message = err instanceof Error ? err.message : "TRRC search failed.";
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }

  const permitsByCounty = new Map<string, typeof searchResult.rows>();
  for (const row of searchResult.rows) {
    const county = (row.county ?? "").toUpperCase();
    if (!permitsByCounty.has(county)) permitsByCounty.set(county, []);
    permitsByCounty.get(county)!.push(row);
  }

  // 4. Fan out: for each subscriber, each of their watched counties, each
  // permit found there — unless already sent.
  let sentCount = 0;
  const errors: string[] = [];

  for (const sub of subs) {
    const watchedCounties = sub.counties.map((c) => c.toUpperCase());
    const candidatePermits = watchedCounties.flatMap((c) => permitsByCounty.get(c) ?? []);
    if (candidatePermits.length === 0) continue;

    for (const permit of candidatePermits) {
      if (!permit.statusNumber) continue; // no stable identity to dedupe on — skip rather than risk a repeat text

      const { data: existing } = await supabase
        .from("permit_alert_sent")
        .select("status_number")
        .eq("status_number", permit.statusNumber)
        .eq("user_id", sub.user_id)
        .maybeSingle();
      if (existing) continue;

      const [result] = await sendPermitAlertSms(
        [{ userId: sub.user_id, phoneNumber: sub.phone_number! }],
        {
          operatorName: permit.operatorName,
          leaseName: permit.leaseName,
          county: permit.county,
          wellNumber: permit.wellNumber,
        }
      );

      if (result.ok) {
        sentCount++;
        await supabase.from("permit_alert_sent").insert({
          status_number: permit.statusNumber,
          user_id: sub.user_id,
          county: permit.county,
          operator_name: permit.operatorName,
          lease_name: permit.leaseName,
        });
      } else {
        errors.push(`${sub.user_id}/${permit.statusNumber}: ${result.error}`);
      }
    }
  }

  return NextResponse.json({
    ok: true,
    data: {
      subscribersChecked: subs.length,
      countiesSearched: counties.length,
      permitsFound: searchResult.rows.length,
      sent: sentCount,
      errors,
    },
  });
}
