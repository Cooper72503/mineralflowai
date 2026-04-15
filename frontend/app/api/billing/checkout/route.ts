import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getStripe, STRIPE_CONFIGURED } from "@/lib/stripe";

export const dynamic = "force-dynamic";

function respond(status: number, body: object) {
  return NextResponse.json(body, { status });
}

export async function POST(req: NextRequest) {
  if (!STRIPE_CONFIGURED) {
    console.error("[checkout] Stripe not configured — STRIPE_SECRET_KEY missing");
    return respond(503, { ok: false, error: "Billing not configured." });
  }

  // Extract JWT from Authorization header (client sends it explicitly since pricing page
  // is public and may not have a server-side cookie session)
  const authHeader = req.headers.get("authorization") ?? req.headers.get("Authorization") ?? "";
  const bearer = /^Bearer\s+/i.test(authHeader.trim())
    ? authHeader.trim().replace(/^Bearer\s+/i, "").trim()
    : "";

  const supabaseAnon = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  // auth.getUser(jwt) validates the JWT server-side — correct approach for public pages
  const { data: { user }, error: authErr } = bearer
    ? await supabaseAnon.auth.getUser(bearer)
    : await supabaseAnon.auth.getUser();

  if (authErr || !user) {
    console.error("[checkout] Auth failed:", authErr?.message ?? "no user");
    return respond(401, { ok: false, error: "Unauthorized" });
  }

  const body = await req.json().catch(() => ({}));
  const plan = body?.plan === "basic" ? "basic" : "pro";

  const priceId =
    plan === "basic"
      ? process.env.STRIPE_BASIC_PRICE_ID
      : process.env.STRIPE_PRO_PRICE_ID;

  if (!priceId) {
    console.error(`[checkout] No price ID for plan: ${plan}`);
    return respond(503, { ok: false, error: `${plan} plan price not configured.` });
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

  try {
    const stripe = getStripe();

    // Use service role to read/write subscriptions table (bypasses RLS)
    const supabaseAdmin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    // Retrieve or create Stripe customer
    const { data: sub } = await supabaseAdmin
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
      await supabaseAdmin
        .from("subscriptions")
        .upsert(
          { user_id: user.id, stripe_customer_id: customerId },
          { onConflict: "user_id" }
        );
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

    if (!session.url) {
      console.error("[checkout] Stripe session created but no URL returned");
      return respond(500, { ok: false, error: "Checkout session has no URL." });
    }

    return respond(200, { ok: true, url: session.url });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[checkout] Stripe error:", msg);
    return respond(500, { ok: false, error: `Stripe error: ${msg}` });
  }
}
