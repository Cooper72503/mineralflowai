import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getStripe, STRIPE_CONFIGURED } from "@/lib/stripe";
import Stripe from "stripe";

export const dynamic = "force-dynamic";

// Stripe sends raw body — Next.js must NOT parse it
export const config = { api: { bodyParser: false } };

function respond(status: number, body: object) {
  return NextResponse.json(body, { status });
}

// Service-role client for webhook upserts (bypasses RLS)
function serviceSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

export async function POST(req: NextRequest) {
  if (!STRIPE_CONFIGURED) return respond(200, { received: true });

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) return respond(400, { error: "Webhook secret not configured." });

  const rawBody = await req.text();
  const signature = req.headers.get("stripe-signature") ?? "";

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    console.error("[billing/webhook] signature verification failed:", err);
    return respond(400, { error: "Invalid signature." });
  }

  const supabase = serviceSupabase();

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.mode !== "subscription") break;

        const userId = session.metadata?.supabase_user_id;
        if (!userId) break;

        const subId = session.subscription as string;
        const sub = await getStripe().subscriptions.retrieve(subId);
        await upsertSubscription(supabase, userId, session.customer as string, sub);
        break;
      }

      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const userId = sub.metadata?.supabase_user_id;
        if (!userId) {
          // Look up by customer id
          const { data } = await supabase
            .from("subscriptions")
            .select("user_id")
            .eq("stripe_customer_id", sub.customer as string)
            .maybeSingle();
          if (data?.user_id) {
            await upsertSubscription(supabase, data.user_id, sub.customer as string, sub);
          }
        } else {
          await upsertSubscription(supabase, userId, sub.customer as string, sub);
        }
        break;
      }

      default:
        break;
    }
  } catch (err) {
    console.error("[billing/webhook] handler error:", err);
    return respond(500, { error: "Webhook handler failed." });
  }

  return respond(200, { received: true });
}

async function upsertSubscription(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  userId: string,
  customerId: string,
  sub: Stripe.Subscription
) {
  const status = sub.status; // active | past_due | canceled | unpaid | trialing …
  const plan = status === "active" || status === "trialing" ? "pro" : "free";
  const periodEnd = sub.current_period_end
    ? new Date(sub.current_period_end * 1000).toISOString()
    : null;

  await supabase.from("subscriptions").upsert(
    {
      user_id: userId,
      stripe_customer_id: customerId,
      stripe_subscription_id: sub.id,
      status,
      plan,
      current_period_end: periodEnd,
      cancel_at_period_end: sub.cancel_at_period_end ?? false,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" }
  );
}
