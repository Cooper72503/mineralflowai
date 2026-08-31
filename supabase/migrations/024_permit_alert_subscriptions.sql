-- SMS alerts for new TRRC drilling-permit (W-1) filings.
-- One row per user: which counties they watch, their phone number, and
-- whether SMS delivery is currently on. Reading every user's row (to fan
-- out an alert) is a service-role operation from the alert cron — see
-- lib/supabase/admin.ts, whose comment already anticipated this table.

CREATE TABLE IF NOT EXISTS permit_alert_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  phone_number TEXT,
  sms_enabled BOOLEAN NOT NULL DEFAULT false,
  counties TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id)
);

CREATE INDEX IF NOT EXISTS idx_permit_alert_subscriptions_user_id ON permit_alert_subscriptions(user_id);
-- Fed to `county = ANY(counties)` filtering during fan-out — GIN speeds up
-- the eventual "which subscriptions care about county X" query.
CREATE INDEX IF NOT EXISTS idx_permit_alert_subscriptions_counties ON permit_alert_subscriptions USING GIN (counties);

ALTER TABLE permit_alert_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "permit_alert_subscriptions_select_own" ON permit_alert_subscriptions;
CREATE POLICY "permit_alert_subscriptions_select_own"
  ON permit_alert_subscriptions FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "permit_alert_subscriptions_insert_own" ON permit_alert_subscriptions;
CREATE POLICY "permit_alert_subscriptions_insert_own"
  ON permit_alert_subscriptions FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "permit_alert_subscriptions_update_own" ON permit_alert_subscriptions;
CREATE POLICY "permit_alert_subscriptions_update_own"
  ON permit_alert_subscriptions FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "permit_alert_subscriptions_delete_own" ON permit_alert_subscriptions;
CREATE POLICY "permit_alert_subscriptions_delete_own"
  ON permit_alert_subscriptions FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- Dedup log: one row per (permit, user) that has actually been texted, so
-- a cron run that overlaps the previous run's lookback window never sends
-- the same permit twice to the same person. Keyed on RRC's own "Status #"
-- tracking number (stable per filing; see lib/trrc/permit-tracker).
CREATE TABLE IF NOT EXISTS permit_alert_sent (
  status_number TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  county TEXT,
  operator_name TEXT,
  lease_name TEXT,
  sent_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (status_number, user_id)
);

-- No RLS policies here on purpose: this table is only ever read/written by
-- the service-role cron job, never by a user's own browser session.
ALTER TABLE permit_alert_sent ENABLE ROW LEVEL SECURITY;
