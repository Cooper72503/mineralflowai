-- ─────────────────────────────────────────────────────────────────────────────
-- Add result_data_json to trrc_source_attempts (raw tool result storage)
-- Add coverage_json to trrc_due_diligence_runs (source coverage matrix)
-- ─────────────────────────────────────────────────────────────────────────────

-- Store the raw data returned by each agent tool call so the PDF report
-- can render actual TRRC record exhibits (wellbore tables, operator records, etc.)
alter table trrc_source_attempts
  add column if not exists result_data_json jsonb;

-- Store the source coverage matrix as built by the agent at run completion.
-- Each element follows SourceCoverageStatus shape: { category, label, status,
-- records_found, data_current_through, sources_checked, notes }
alter table trrc_due_diligence_runs
  add column if not exists coverage_json jsonb default '[]'::jsonb;
