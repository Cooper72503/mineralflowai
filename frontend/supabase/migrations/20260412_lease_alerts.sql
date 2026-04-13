-- ============================================================
-- Lease expiration alerts
-- ============================================================

-- 1. Expiration date stored on the document when processed
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS lease_expiration_date  DATE,
  ADD COLUMN IF NOT EXISTS lease_expiration_source TEXT; -- 'calculated' | 'manual'

CREATE INDEX IF NOT EXISTS documents_lease_expiration_date_idx
  ON documents (lease_expiration_date)
  WHERE lease_expiration_date IS NOT NULL;

-- 2. Track which alert emails have been sent (dedup across runs)
CREATE TABLE IF NOT EXISTS lease_alert_notifications (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id    UUID        NOT NULL REFERENCES documents(id)    ON DELETE CASCADE,
  user_id        UUID        NOT NULL REFERENCES auth.users(id)   ON DELETE CASCADE,
  threshold_days INT         NOT NULL,  -- 90, 30, or 7
  sent_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (document_id, threshold_days)
);

ALTER TABLE lease_alert_notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_own_alert_notifications"
  ON lease_alert_notifications FOR SELECT
  USING (auth.uid() = user_id);

-- 3. Ensure alerts table exists with the expected schema
--    (AlertsPage already uses it; this just confirms the columns)
CREATE TABLE IF NOT EXISTS alerts (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  min_score   INT         NOT NULL DEFAULT 50,
  county      TEXT,
  acreage_min NUMERIC,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users_own_alerts" ON alerts;
CREATE POLICY "users_own_alerts"
  ON alerts FOR ALL
  USING  (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
