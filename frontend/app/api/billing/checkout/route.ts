import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getStripe, STRIPE_CONFIGURED } from "@/lib/stripe";

export const dynamic = "force-dynamic";

function respond(status: number, body: object) {
  return NextResponse.json(body, { status });
}

export async function POST(req: NextRequest) {
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

  const body = await req.json().catch(() => ({}));
  const plan = body?.plan === "basic" ? "basic" : "pro";

  const priceId =
    plan === "basic"
      ? process.env.STRIPE_BASIC_PRICE_ID
      : process.env.STRIPE_PRO_PRICE_ID;
  if (!priceId) return respond(503, { ok: false, error: `${plan} plan price not configured.` });

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const stripe = getStripe();

  // Retrieve or create Stripe customer
  const { data: sub } = await supabase
    .from("subscriptions")
    .select("stripe_customer_id")
    .eq("user_id", user.id)
    .maybeSingle();

  let customerId = sub?.stripe_customer_id as string | undefined;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email,
      metadata: { supabase_user_id: user.id },
    });
    customerId = customer.id;
    // Store for future lookups
    await supabase
      .from("subscriptions")
      .upsert({ user_id: user.id, stripe_customer_id: customerId }, { onConflict: "user_id" });
  }

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${appUrl}/billing?success=1`,
    cancel_url: `${appUrl}/billing?canceled=1`,
    subscription_data: { metadata: { supabase_user_id: user.id } },
    allow_promotion_codes: true,
  });

  return respond(200, { ok: true, url: session.url });
}
