-- ─────────────────────────────────────────────────────────────────────────────
-- TRRC Due Diligence Schema
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Runs ───────────────────────────────────────────────────────────────────
create table if not exists trrc_due_diligence_runs (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references auth.users(id) on delete cascade,

  -- Input
  original_input          text not null,
  detected_input_type     text,
  selected_input_type     text,
  normalized_input        text,

  -- Status
  status                  text not null default 'pending',   -- pending | retrieving | analyzing | complete | failed | cancelled
  progress_percent        integer not null default 0,
  started_at              timestamptz,
  completed_at            timestamptz,

  -- Resolved identifiers (filled in by agent)
  resolved_primary_api    text,
  resolved_district       text,
  resolved_lease_number   text,
  resolved_gas_id         text,
  resolved_operator_number text,

  -- Results
  result_summary          text,
  scorecard_json          jsonb,
  error_summary           text,

  -- Storage paths (for pre-generated PDF/ZIP, optional)
  report_storage_path     text,
  archive_storage_path    text,
  manifest_storage_path   text,

  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

alter table trrc_due_diligence_runs enable row level security;

create policy "Users see own runs"
  on trrc_due_diligence_runs for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists trrc_dd_runs_user_id_idx on trrc_due_diligence_runs(user_id);
create index if not exists trrc_dd_runs_status_idx  on trrc_due_diligence_runs(status);

-- ── 2. Resolved entities ──────────────────────────────────────────────────────
create table if not exists trrc_resolved_entities (
  id                    uuid primary key default gen_random_uuid(),
  run_id                uuid not null references trrc_due_diligence_runs(id) on delete cascade,
  entity_type           text not null,   -- wellbore | lease | operator | legal_description
  canonical_identifier  text not null,
  display_name          text,
  attributes_json       jsonb default '{}',
  confidence            numeric,
  resolution_method     text,
  is_user_selected      boolean not null default false,
  created_at            timestamptz not null default now()
);

alter table trrc_resolved_entities enable row level security;

create policy "Users see own entities"
  on trrc_resolved_entities for all
  using (exists (
    select 1 from trrc_due_diligence_runs r
    where r.id = run_id and r.user_id = auth.uid()
  ));

create index if not exists trrc_resolved_entities_run_id_idx on trrc_resolved_entities(run_id);

-- ── 3. Source attempts ────────────────────────────────────────────────────────
create table if not exists trrc_source_attempts (
  id              uuid primary key default gen_random_uuid(),
  run_id          uuid not null references trrc_due_diligence_runs(id) on delete cascade,
  source_id       text not null,
  source_name     text not null,
  status          text not null,   -- success | failed_transient | failed_permanent | not_applicable
  result_count    integer default 0,
  error_message   text,
  attempted_at    timestamptz not null default now(),
  unique (run_id, source_id)
);

alter table trrc_source_attempts enable row level security;

create policy "Users see own source attempts"
  on trrc_source_attempts for all
  using (exists (
    select 1 from trrc_due_diligence_runs r
    where r.id = run_id and r.user_id = auth.uid()
  ));

create index if not exists trrc_source_attempts_run_id_idx on trrc_source_attempts(run_id);

-- ── 4. Findings ───────────────────────────────────────────────────────────────
create table if not exists trrc_due_diligence_findings (
  id                    uuid primary key default gen_random_uuid(),
  run_id                uuid not null references trrc_due_diligence_runs(id) on delete cascade,
  finding_id            text,
  category              text not null,   -- identity | production | compliance | inactive_well | plugging | mechanical | operator | data_gap
  severity              text not null,   -- critical | high | medium | low | info
  finding_type          text,
  title                 text not null,
  description           text,
  evidence_json         jsonb default '{}',
  source_record_ids     text[],
  analytical_method     text,
  confidence            numeric,
  recommended_action    text,
  is_directly_reported  boolean default true,
  created_at            timestamptz not null default now()
);

alter table trrc_due_diligence_findings enable row level security;

create policy "Users see own findings"
  on trrc_due_diligence_findings for all
  using (exists (
    select 1 from trrc_due_diligence_runs r
    where r.id = run_id and r.user_id = auth.uid()
  ));

create index if not exists trrc_findings_run_id_idx on trrc_due_diligence_findings(run_id);
create index if not exists trrc_findings_severity_idx on trrc_due_diligence_findings(severity);

-- ── 5. Production monthly ─────────────────────────────────────────────────────
create table if not exists trrc_production_monthly (
  id                  uuid primary key default gen_random_uuid(),
  run_id              uuid not null references trrc_due_diligence_runs(id) on delete cascade,
  entity_type         text not null,   -- lease | wellbore
  api_number          text,
  district            text not null,
  lease_number        text,
  gas_id              text,
  operator_number     text,
  production_month    text not null,   -- YYYY-MM
  oil_bbl             numeric,
  casinghead_gas_mcf  numeric,
  gas_mcf             numeric,
  condensate_bbl      numeric,
  water_bbl           numeric,
  created_at          timestamptz not null default now(),
  unique (run_id, entity_type, api_number, lease_number, production_month)
);

alter table trrc_production_monthly enable row level security;

create policy "Users see own production"
  on trrc_production_monthly for all
  using (exists (
    select 1 from trrc_due_diligence_runs r
    where r.id = run_id and r.user_id = auth.uid()
  ));

create index if not exists trrc_production_run_id_idx on trrc_production_monthly(run_id);

-- ── 6. Auto-updated_at trigger ────────────────────────────────────────────────
create or replace function update_updated_at_column()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger trrc_dd_runs_updated_at
  before update on trrc_due_diligence_runs
  for each row execute function update_updated_at_column();
