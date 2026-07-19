/**
 * Daily cron job — send lease expiration alert emails.
 *
 * Runs at 9:00 AM UTC every day via Vercel Cron (vercel.json).
 * Protected by CRON_SECRET env var (set in Vercel project settings).
 *
 * Thresholds: 90 days, 30 days, 7 days.
 * Each threshold is sent exactly once per document (deduped by lease_alert_notifications).
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { RESEND_CONFIGURED, sendLeaseAlertEmail } from "@/lib/email/resend";
import { daysUntilExpiration } from "@/lib/alerts/parse-expiration";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const THRESHOLDS = [90, 30, 7]; // days before expiration

function serviceSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

export async function GET(req: NextRequest) {
  // Verify Vercel cron secret
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!RESEND_CONFIGURED) {
    return NextResponse.json({ ok: false, skipped: true, reason: "Resend not configured" });
  }

  const supabase = serviceSupabase();
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://mineralflowai.com";

  // Find all documents with a lease_expiration_date set and in the future (within 90 days)
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const in90 = new Date(today);
  in90.setDate(in90.getDate() + 90);

  const { data: docs, error: docsErr } = await supabase
    .from("documents")
    .select(`
      id, user_id, file_name, county, state,
      lease_expiration_date,
      document_extractions ( lessor, lessee )
    `)
    .not("lease_expiration_date", "is", null)
    .gte("lease_expiration_date", today.toISOString().slice(0, 10))
    .lte("lease_expiration_date", in90.toISOString().slice(0, 10));

  if (docsErr) {
    console.error("[lease-alerts] failed to fetch documents:", docsErr.message);
    return NextResponse.json({ ok: false, error: docsErr.message }, { status: 500 });
  }

  if (!docs || docs.length === 0) {
    return NextResponse.json({ ok: true, sent: 0, message: "No expiring leases found" });
  }

  // Get already-sent notifications to avoid re-sending
  const docIds = docs.map((d) => d.id);
  const { data: sentNotifs } = await supabase
    .from("lease_alert_notifications")
    .select("document_id, threshold_days")
    .in("document_id", docIds);

  const sentSet = new Set(
    (sentNotifs ?? []).map((n) => `${n.document_id}:${n.threshold_days}`)
  );

  let sent = 0;
  let errors = 0;

  for (const doc of docs) {
    const days = daysUntilExpiration(doc.lease_expiration_date);

    // Find which thresholds this doc qualifies for
    for (const threshold of THRESHOLDS) {
      if (days > threshold) continue; // not yet within this window
      const key = `${doc.id}:${threshold}`;
      if (sentSet.has(key)) continue; // already sent

      // Get user email from auth.users via service role
      const { data: userData } = await supabase.auth.admin.getUserById(doc.user_id);
      const email = userData?.user?.email;
      if (!email) continue;

      // Get owner name from extraction
      const extraction = Array.isArray(doc.document_extractions)
        ? doc.document_extractions[0]
        : doc.document_extractions;
      const owner = (extraction as { lessor?: string | null } | null)?.lessor ?? null;

      try {
        await sendLeaseAlertEmail({
          to: email,
          owner,
          county: doc.county,
          state: doc.state,
          file_name: doc.file_name,
          expiration_date: doc.lease_expiration_date,
          days_until: days,
          document_url: `${appUrl}/documents/${doc.id}`,
        });

        // Record sent
        await supabase.from("lease_alert_notifications").insert({
          document_id: doc.id,
          user_id: doc.user_id,
          threshold_days: threshold,
        });

        sentSet.add(key);
        sent++;
      } catch (err) {
        console.error(`[lease-alerts] failed to send for doc ${doc.id}:`, err);
        errors++;
      }
    }
  }

  return NextResponse.json({
    ok: true,
    checked: docs.length,
    sent,
    errors,
  });
}
