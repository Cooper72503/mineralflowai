-- Add operator_name to trrc_due_diligence_runs so the edge function can
-- receive the operator the user typed in the form even when API number
-- is the primary identifier (in which case the entity resolver never
-- creates an operator entity, so operator_name was silently dropped).

alter table trrc_due_diligence_runs
  add column if not exists operator_name text;
