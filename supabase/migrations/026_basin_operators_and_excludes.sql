-- Operators confirmed active (via real permit history) in the basins the
-- Permit Tracker covers — backfilled by scripts/sync-basin-operators.ts,
-- which crawls TRRC's public W-1 search across every Permian Basin +
-- Eagle Ford county over a trailing window and aggregates distinct
-- operators. This is a derived, periodically-refreshed roster, not a
-- live query — treat "last seen" as "as of the last sync," not real-time.
CREATE TABLE IF NOT EXISTS basin_operators (
  org_number TEXT PRIMARY KEY,
  org_name TEXT NOT NULL,
  basins TEXT[] NOT NULL DEFAULT '{}',
  permit_count INTEGER NOT NULL DEFAULT 0,
  first_seen DATE,
  last_seen DATE,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_basin_operators_org_name ON basin_operators (org_name);

ALTER TABLE basin_operators ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "basin_operators_select_authenticated" ON basin_operators;
CREATE POLICY "basin_operators_select_authenticated"
  ON basin_operators FOR SELECT
  TO authenticated
  USING (true);

-- Per-user "hide this operator from my permit tracker results" list.
-- Deliberately keyed the same way permit_alert_subscriptions is (per user,
-- RLS-scoped to the owner) so this can be reused to filter SMS alerts too,
-- if that's wanted later — not wired into the alert cron yet, only into
-- the on-demand search results.
CREATE TABLE IF NOT EXISTS permit_tracker_operator_excludes (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  org_number TEXT NOT NULL,
  org_name TEXT,
  excluded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, org_number)
);

ALTER TABLE permit_tracker_operator_excludes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "operator_excludes_select_own" ON permit_tracker_operator_excludes;
CREATE POLICY "operator_excludes_select_own"
  ON permit_tracker_operator_excludes FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "operator_excludes_insert_own" ON permit_tracker_operator_excludes;
CREATE POLICY "operator_excludes_insert_own"
  ON permit_tracker_operator_excludes FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "operator_excludes_delete_own" ON permit_tracker_operator_excludes;
CREATE POLICY "operator_excludes_delete_own"
  ON permit_tracker_operator_excludes FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);
