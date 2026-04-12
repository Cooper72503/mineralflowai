import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getStripe, STRIPE_CONFIGURED } from "@/lib/stripe";

export const dynamic = "force-dynamic";

function respond(status: number, body: object) {
  return NextResponse.json(body, { status });
}

export async function POST(_req: NextRequest) {
  if (!STRIPE_CONFIGURED) {
    return respond(503, { ok: false, error: "Billing not configured." });
  }

  const cookieStore = cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll() } }
  );

  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) return respond(401, { ok: false, error: "Unauthorized" });

  const { data: sub } = await supabase
    .from("subscriptions")
    .select("stripe_customer_id")
    .eq("user_id", user.id)
    .maybeSingle();

  const customerId = sub?.stripe_customer_id as string | undefined;
  if (!customerId) {
    return respond(400, { ok: false, error: "No billing account found. Please subscribe first." });
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const stripe = getStripe();

  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${appUrl}/billing`,
  });

  return respond(200, { ok: true, url: session.url });
}
