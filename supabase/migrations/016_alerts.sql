-- Per-user deal alert preferences (one row per user).

CREATE TABLE IF NOT EXISTS alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  minimum_score INTEGER NOT NULL DEFAULT 50 CHECK (minimum_score IN (50, 60, 70, 80)),
  county TEXT,
  acreage_min NUMERIC,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id)
);

CREATE INDEX IF NOT EXISTS idx_alerts_user_id ON alerts(user_id);

ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "alerts_select_own" ON alerts;
CREATE POLICY "alerts_select_own"
  ON alerts FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "alerts_insert_own" ON alerts;
CREATE POLICY "alerts_insert_own"
  ON alerts FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "alerts_update_own" ON alerts;
CREATE POLICY "alerts_update_own"
  ON alerts FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "alerts_delete_own" ON alerts;
CREATE POLICY "alerts_delete_own"
  ON alerts FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);
