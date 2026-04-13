-- Subscriptions table — tracks Stripe plan per user
CREATE TABLE IF NOT EXISTS subscriptions (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID        NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  stripe_customer_id    TEXT,
  stripe_subscription_id TEXT,
  status                TEXT        NOT NULL DEFAULT 'free',
  -- status values: free | trialing | active | past_due | canceled | unpaid
  plan                  TEXT        NOT NULL DEFAULT 'free',
  -- plan values:   free | pro
  current_period_end    TIMESTAMPTZ,
  cancel_at_period_end  BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for Stripe webhook lookups
CREATE INDEX IF NOT EXISTS subscriptions_stripe_customer_id_idx
  ON subscriptions (stripe_customer_id);

CREATE INDEX IF NOT EXISTS subscriptions_stripe_subscription_id_idx
  ON subscriptions (stripe_subscription_id);

-- RLS: users can only read their own subscription row
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own subscription"
  ON subscriptions FOR SELECT
  USING (auth.uid() = user_id);

-- Service role (webhooks) can upsert freely via the API key — no RLS restriction
-- needed there because we use the service-role key.

-- Helper: ensure every new user gets a free-tier row automatically.
-- Wrapped in EXCEPTION so it can NEVER abort the signup transaction.
CREATE OR REPLACE FUNCTION handle_new_user_subscription()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  BEGIN
    INSERT INTO subscriptions (user_id) VALUES (NEW.id) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    -- Log but never propagate — signup must not fail due to billing setup
    NULL;
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created_subscription ON auth.users;
CREATE TRIGGER on_auth_user_created_subscription
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user_subscription();
