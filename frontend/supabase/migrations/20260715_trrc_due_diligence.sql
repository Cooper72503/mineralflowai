-- ─── TRRC Due Diligence ──────────────────────────────────────────────────────
-- Description: Creates 8 tables to persist the full lifecycle of a TRRC
-- due-diligence run: input resolution, source fetching, public record storage,
-- monthly production, analytical findings, missing-record tracking, and
-- extracted record facts.  All tables are RLS-protected so users can only
-- access their own data.
-- Run via `supabase db push` or the Supabase SQL editor.

-- ─── 1. trrc_due_diligence_runs ──────────────────────────────────────────────

create table if not exists public.trrc_due_diligence_runs (
  id                      uuid        primary key default gen_random_uuid(),
  user_id                 uuid        not null references auth.users(id) on delete cascade,

  -- Raw input captured from the user
  original_input          text        not null,
  detected_input_type     text        not null,  -- 'api_number' | 'rrc_lease_number' | 'gas_well_id' | 'operator_name' | 'p5_number' | 'legal_description' | 'lease_name' | 'unknown'
  selected_input_type     text        not null,
  normalized_input        text        not null,

  -- Run lifecycle
  status                  text        not null default 'pending',  -- 'pending' | 'resolving' | 'awaiting_selection' | 'retrieving' | 'analyzing' | 'generating' | 'complete' | 'failed' | 'cancelled'
  started_at              timestamptz not null default now(),
  completed_at            timestamptz,
  progress_percent        integer     not null default 0 check (progress_percent >= 0 and progress_percent <= 100),

  -- High-level results
  result_summary          text,
  error_summary           text,

  -- Resolved TRRC identifiers
  resolved_primary_api    text,
  resolved_district       text,
  resolved_lease_number   text,
  resolved_gas_id         text,
  resolved_operator_number text,

  -- Storage paths for generated artefacts
  report_storage_path     text,
  archive_storage_path    text,
  manifest_storage_path   text,

  -- Structured scorecard and source-coverage summary
  scorecard_json          jsonb,
  coverage_json           jsonb,

  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

alter table public.trrc_due_diligence_runs enable row level security;

drop policy if exists "users_own_diligence_runs" on public.trrc_due_diligence_runs;
create policy "users_own_diligence_runs"
  on public.trrc_due_diligence_runs
  for all
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists trrc_due_diligence_runs_user_id_idx
  on public.trrc_due_diligence_runs (user_id);

create index if not exists trrc_due_diligence_runs_status_idx
  on public.trrc_due_diligence_runs (status);

create index if not exists trrc_due_diligence_runs_created_at_idx
  on public.trrc_due_diligence_runs (created_at desc);

-- Auto-update updated_at (reuses set_updated_at() if already defined)
create or replace function public.set_updated_at()
  returns trigger language plpgsql as $$
  begin new.updated_at = now(); return new; end;
$$;

create trigger trrc_due_diligence_runs_updated_at
  before update on public.trrc_due_diligence_runs
  for each row execute function public.set_updated_at();


-- ─── 2. trrc_resolved_entities ───────────────────────────────────────────────

create table if not exists public.trrc_resolved_entities (
  id                   uuid        primary key default gen_random_uuid(),
  run_id               uuid        not null references public.trrc_due_diligence_runs(id) on delete cascade,

  entity_type          text        not null,  -- 'wellbore' | 'lease' | 'completion' | 'operator' | 'permit' | 'uic_authority'
  canonical_identifier text        not null,
  display_name         text        not null,
  attributes_json      jsonb       not null default '{}',

  confidence           numeric(4,3) not null check (confidence >= 0 and confidence <= 1),
  resolution_method    text        not null,
  is_user_selected     boolean     not null default false,

  created_at           timestamptz not null default now()
);

alter table public.trrc_resolved_entities enable row level security;

drop policy if exists "users_own_resolved_entities" on public.trrc_resolved_entities;
create policy "users_own_resolved_entities"
  on public.trrc_resolved_entities
  for all
  using  (auth.uid() = (select user_id from public.trrc_due_diligence_runs where id = run_id))
  with check (auth.uid() = (select user_id from public.trrc_due_diligence_runs where id = run_id));

create index if not exists trrc_resolved_entities_run_id_idx
  on public.trrc_resolved_entities (run_id);


-- ─── 3. trrc_source_attempts ─────────────────────────────────────────────────

create table if not exists public.trrc_source_attempts (
  id                   uuid        primary key default gen_random_uuid(),
  run_id               uuid        not null references public.trrc_due_diligence_runs(id) on delete cascade,

  source_id            text        not null,
  source_name          text        not null,
  request_parameters   jsonb       not null default '{}',
  request_url          text,

  started_at           timestamptz not null,
  completed_at         timestamptz,
  status               text        not null,  -- SourceAttemptStatus values

  result_count         integer     not null default 0,
  http_status          integer,
  retry_count          integer     not null default 0,
  error_code           text,
  error_message        text,
  manual_action_url    text,
  parser_version       text        not null default '1.0',

  created_at           timestamptz not null default now()
);

alter table public.trrc_source_attempts enable row level security;

drop policy if exists "users_own_source_attempts" on public.trrc_source_attempts;
create policy "users_own_source_attempts"
  on public.trrc_source_attempts
  for all
  using  (auth.uid() = (select user_id from public.trrc_due_diligence_runs where id = run_id))
  with check (auth.uid() = (select user_id from public.trrc_due_diligence_runs where id = run_id));

create index if not exists trrc_source_attempts_run_id_idx
  on public.trrc_source_attempts (run_id);

create index if not exists trrc_source_attempts_source_id_idx
  on public.trrc_source_attempts (source_id);


-- ─── 4. trrc_public_records ──────────────────────────────────────────────────

create table if not exists public.trrc_public_records (
  id                       uuid        primary key default gen_random_uuid(),
  run_id                   uuid        not null references public.trrc_due_diligence_runs(id) on delete cascade,
  resolved_entity_id       uuid        references public.trrc_resolved_entities(id) on delete set null,
  source_attempt_id        uuid        references public.trrc_source_attempts(id) on delete set null,

  -- Classification
  category                 text        not null,
  document_type            text        not null,
  form_type                text,
  form_version             text,
  source_document_id       text,

  -- Display
  title                    text        not null,
  filing_date              date,
  effective_date           date,

  -- File location
  source_url               text,
  storage_path             text,
  original_filename        text,
  normalized_filename      text,
  mime_type                text,
  file_size                bigint,
  sha256                   text,

  -- Processing state
  extraction_status        text        not null default 'pending',
  classification_confidence numeric(4,3),

  -- Parsed content
  structured_data          jsonb,
  source_metadata          jsonb,

  is_manual_required       boolean     not null default false,

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

alter table public.trrc_public_records enable row level security;

drop policy if exists "users_own_public_records" on public.trrc_public_records;
create policy "users_own_public_records"
  on public.trrc_public_records
  for all
  using  (auth.uid() = (select user_id from public.trrc_due_diligence_runs where id = run_id))
  with check (auth.uid() = (select user_id from public.trrc_due_diligence_runs where id = run_id));

create index if not exists trrc_public_records_run_id_idx
  on public.trrc_public_records (run_id);

create index if not exists trrc_public_records_category_idx
  on public.trrc_public_records (category);

create trigger trrc_public_records_updated_at
  before update on public.trrc_public_records
  for each row execute function public.set_updated_at();


-- ─── 5. trrc_production_monthly ──────────────────────────────────────────────

create table if not exists public.trrc_production_monthly (
  id                   uuid         primary key default gen_random_uuid(),
  run_id               uuid         not null references public.trrc_due_diligence_runs(id) on delete cascade,

  entity_type          text         not null check (entity_type in ('lease', 'api')),
  api_number           text,
  district             text         not null,
  lease_number         text,
  gas_id               text,
  operator_number      text,

  -- 'YYYY-MM' format
  production_month     text         not null,

  -- Volumes
  oil_bbl              numeric(14,3),
  casinghead_gas_mcf   numeric(14,3),
  gas_mcf              numeric(14,3),
  condensate_bbl       numeric(14,3),
  water_bbl            numeric(14,3),

  disposition_json     jsonb,
  raw_source_json      jsonb,
  source_attempt_id    uuid         references public.trrc_source_attempts(id) on delete set null,

  created_at           timestamptz  not null default now(),

  -- Prevent duplicate rows for the same entity + month within a run
  unique (run_id, entity_type, coalesce(api_number, ''), coalesce(lease_number, ''), production_month)
);

alter table public.trrc_production_monthly enable row level security;

drop policy if exists "users_own_production_monthly" on public.trrc_production_monthly;
create policy "users_own_production_monthly"
  on public.trrc_production_monthly
  for all
  using  (auth.uid() = (select user_id from public.trrc_due_diligence_runs where id = run_id))
  with check (auth.uid() = (select user_id from public.trrc_due_diligence_runs where id = run_id));

create index if not exists trrc_production_monthly_run_id_idx
  on public.trrc_production_monthly (run_id);

create index if not exists trrc_production_monthly_production_month_idx
  on public.trrc_production_monthly (production_month);


-- ─── 6. trrc_due_diligence_findings ──────────────────────────────────────────

create table if not exists public.trrc_due_diligence_findings (
  id                   uuid         primary key default gen_random_uuid(),
  run_id               uuid         not null references public.trrc_due_diligence_runs(id) on delete cascade,

  category             text         not null,
  severity             text         not null check (severity in ('critical', 'high', 'medium', 'low', 'info')),
  finding_type         text         not null,
  title                text         not null,
  description          text         not null,

  evidence_json        jsonb        not null default '{}',
  source_record_ids    text[]       not null default '{}',

  analytical_method    text         not null,
  confidence           numeric(4,3) not null check (confidence >= 0 and confidence <= 1),
  recommended_action   text         not null,

  is_directly_reported boolean      not null default true,

  created_at           timestamptz  not null default now()
);

alter table public.trrc_due_diligence_findings enable row level security;

drop policy if exists "users_own_diligence_findings" on public.trrc_due_diligence_findings;
create policy "users_own_diligence_findings"
  on public.trrc_due_diligence_findings
  for all
  using  (auth.uid() = (select user_id from public.trrc_due_diligence_runs where id = run_id))
  with check (auth.uid() = (select user_id from public.trrc_due_diligence_runs where id = run_id));

create index if not exists trrc_due_diligence_findings_run_id_idx
  on public.trrc_due_diligence_findings (run_id);

create index if not exists trrc_due_diligence_findings_severity_idx
  on public.trrc_due_diligence_findings (severity);


-- ─── 7. trrc_missing_items ───────────────────────────────────────────────────

create table if not exists public.trrc_missing_items (
  id                    uuid        primary key default gen_random_uuid(),
  run_id                uuid        not null references public.trrc_due_diligence_runs(id) on delete cascade,

  category              text        not null,
  expected_record_type  text        not null,
  status                text        not null,  -- 'confirmed_no_record' | 'no_result_from_query' | 'retrieval_failed' | 'source_unavailable' | 'manual_required' | 'outside_date_range'
  explanation           text        not null,
  source_checked        text        not null,
  manual_retrieval_url  text,
  recommended_action    text        not null,

  created_at            timestamptz not null default now()
);

alter table public.trrc_missing_items enable row level security;

drop policy if exists "users_own_missing_items" on public.trrc_missing_items;
create policy "users_own_missing_items"
  on public.trrc_missing_items
  for all
  using  (auth.uid() = (select user_id from public.trrc_due_diligence_runs where id = run_id))
  with check (auth.uid() = (select user_id from public.trrc_due_diligence_runs where id = run_id));

create index if not exists trrc_missing_items_run_id_idx
  on public.trrc_missing_items (run_id);


-- ─── 8. trrc_record_facts ────────────────────────────────────────────────────

create table if not exists public.trrc_record_facts (
  id                uuid         primary key default gen_random_uuid(),
  record_id         uuid         not null references public.trrc_public_records(id) on delete cascade,
  run_id            uuid         not null references public.trrc_due_diligence_runs(id) on delete cascade,

  fact_type         text         not null,
  value_json        jsonb        not null,
  normalized_value  text,
  confidence        numeric(4,3),
  extraction_method text,
  page_number       integer,
  source_text       text,

  created_at        timestamptz  not null default now()
);

alter table public.trrc_record_facts enable row level security;

drop policy if exists "users_own_record_facts" on public.trrc_record_facts;
create policy "users_own_record_facts"
  on public.trrc_record_facts
  for all
  using  (auth.uid() = (select user_id from public.trrc_due_diligence_runs where id = run_id))
  with check (auth.uid() = (select user_id from public.trrc_due_diligence_runs where id = run_id));
