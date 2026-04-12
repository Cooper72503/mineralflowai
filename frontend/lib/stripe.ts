import Stripe from "stripe";

// Lazily initialised so the module can be imported without STRIPE_SECRET_KEY
// being set (e.g. during tests or static builds).
let _stripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
    _stripe = new Stripe(key, { apiVersion: "2023-10-16" });
  }
  return _stripe;
}

export const STRIPE_CONFIGURED = Boolean(process.env.STRIPE_SECRET_KEY);
