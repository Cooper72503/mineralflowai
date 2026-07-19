-- The original underwriting_reports migration never created a unique
-- constraint on (user_id, report_id), but the application's upsert
-- (app/api/underwriting/reports/route.ts) specifies onConflict: "user_id,report_id".
-- Without a matching constraint, Postgres rejects every upsert with:
--   42P10: there is no unique or exclusion constraint matching the ON CONFLICT specification
-- This has caused every report auto-save to fail in production since the table
-- was created.

alter table public.underwriting_reports
  add constraint underwriting_reports_user_report_unique
  unique (user_id, report_id);
