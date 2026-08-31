-- Texas Railroad Commission's public Oil & Gas Directory (P-5 organization
-- roster) — org number, name, address, phone, emergency phone, P-5 status
-- for every operator with an unexpired P-5 registration. Downloaded in bulk
-- from https://www.rrc.texas.gov/oil-and-gas/research-and-statistics/operator-information/oil-gas-directory-operator-contact/
-- (Excel export; confirmed to include real phone numbers, unlike the same
-- page's plain-text export which truncates them) rather than scraped
-- per-operator — the live P-5 query is session-based and far too slow to
-- call once per distinct operator in a permit search's result set.
--
-- Refreshed periodically (not real-time) — treat phone numbers as
-- "as of last sync," not authoritative-to-the-minute.

CREATE TABLE IF NOT EXISTS operator_directory (
  org_number TEXT PRIMARY KEY,
  org_name TEXT NOT NULL,
  phone TEXT,
  emergency_phone TEXT,
  city TEXT,
  state TEXT,
  p5_status TEXT,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Public reference data — readable by any authenticated app user (the
-- permit tracker joins on this for every search), writable only by the
-- service-role sync job.
ALTER TABLE operator_directory ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "operator_directory_select_authenticated" ON operator_directory;
CREATE POLICY "operator_directory_select_authenticated"
  ON operator_directory FOR SELECT
  TO authenticated
  USING (true);
