import Stripe from "stripe";

export function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
  return new Stripe(key, {
    apiVersion: "2023-10-16",
    // Required for Next.js serverless/edge environments
    httpClient: Stripe.createFetchHttpClient(),
  });
}

export const STRIPE_CONFIGURED = Boolean(process.env.STRIPE_SECRET_KEY);
