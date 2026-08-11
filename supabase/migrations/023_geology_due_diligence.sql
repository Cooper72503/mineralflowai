-- ─────────────────────────────────────────────────────────────────────────────
-- Geological Due Diligence Engine — V1
--
-- Every table FKs to the EXISTING trrc_due_diligence_runs(id) rather than a
-- new "geology_assets" table — that run already resolves the subject asset
-- (resolved_primary_api, resolved_district, resolved_lease_number), so a
-- separate asset table would just duplicate identity resolution the pipeline
-- already does. Wells, operators, production, and permits already have
-- normalized homes (trrc_resolved_entities, trrc_production_monthly,
-- trrc_source_attempts) — this schema references them by api_number/lease
-- rather than re-storing their content.
--
-- Deliberately NO geology_scores table and no numeric score column anywhere
-- in this file. Classification (FAVORABLE/MIXED/UNFAVORABLE/INSUFFICIENT_DATA)
-- and confidence (HIGH/MODERATE/LOW) are both text enums — see
-- geology_assessments below.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Offset wells (1/3/5-mile radius search results) ─────────────────────────
create table if not exists geology_offsets (
  id                      uuid primary key default gen_random_uuid(),
  run_id                  uuid not null references trrc_due_diligence_runs(id) on delete cascade,

  api_number              text not null,
  well_number             text,
  latitude                numeric,
  longitude               numeric,
  distance_miles          numeric not null,
  bearing                 text,
  radius_band_miles       integer not null,   -- 1 | 3 | 5 — which ring this row qualified within (smallest that matched)

  gis_status_symbol       text,               -- raw TRRC GIS_SYMBOL_DESCRIPTION
  classified_status       text,               -- PRODUCING | RECENTLY_ACTIVE | SHUT_IN | PLUGGED | PERMITTED_NOT_DRILLED | DRY_HOLE | INJECTION_DISPOSAL | UNKNOWN

  target_formation        text,
  canonical_formation      text,              -- formation-normalization.ts output
  formation_match          boolean,           -- null until formation data is known for this candidate

  lateral_length_ft        numeric,
  completion_year          integer,
  first_production_date    text,

  six_month_oil_bbl        numeric,
  twelve_month_oil_bbl     numeric,
  cumulative_oil_bbl       numeric,
  cumulative_gas_mcf       numeric,
  cumulative_water_bbl     numeric,
  months_of_history        integer,

  comparable_group_id      text,              -- groups wells this engine considers apples-to-apples (same formation/vintage/lateral-length band)
  operator_name             text,

  source_url_or_query_id    text,
  retrieved_at              timestamptz not null default now(),
  created_at                timestamptz not null default now()
);

alter table geology_offsets enable row level security;

create policy "Users see own geology offsets"
  on geology_offsets for all
  using (exists (
    select 1 from trrc_due_diligence_runs r
    where r.id = run_id and r.user_id = auth.uid()
  ));

create index if not exists geology_offsets_run_id_idx on geology_offsets(run_id);
create index if not exists geology_offsets_comparable_group_idx on geology_offsets(comparable_group_id);

-- ── 2. Permit activity ───────────────────────────────────────────────────────
create table if not exists geology_permits (
  id                     uuid primary key default gen_random_uuid(),
  run_id                 uuid not null references trrc_due_diligence_runs(id) on delete cascade,

  api_number             text,
  permit_number          text,
  distance_miles         numeric,
  radius_band_miles      integer,

  filed_date             text,
  months_since_filed     integer,
  recency_bucket         text,               -- LAST_6_MONTHS | LAST_12_MONTHS | LAST_24_MONTHS | OLDER
  target_formation       text,
  operator_name          text,

  well_status_at_query   text,               -- e.g. still PERMITTED_NOT_DRILLED vs. now drilled — permits are NOT proof a well will be drilled; see interpretation layer

  source_url_or_query_id text,
  retrieved_at           timestamptz not null default now(),
  created_at             timestamptz not null default now()
);

alter table geology_permits enable row level security;

create policy "Users see own geology permits"
  on geology_permits for all
  using (exists (
    select 1 from trrc_due_diligence_runs r
    where r.id = run_id and r.user_id = auth.uid()
  ));

create index if not exists geology_permits_run_id_idx on geology_permits(run_id);

-- ── 3. Formation tops (schema present, unused in V1) ────────────────────────────
-- No free, bulk-queryable public source of Texas formation top/depth data was
-- found — confirmed live against TRRC's public GIS and EWA endpoints during
-- this engine's design (see formations.ts). This table exists so the schema
-- is ready the moment a real source (subsurface log data, e.g.) is
-- connected — it is NOT populated by V1, and the report says so explicitly
-- rather than leaving the gap silent.
create table if not exists formation_tops (
  id                uuid primary key default gen_random_uuid(),
  run_id            uuid not null references trrc_due_diligence_runs(id) on delete cascade,
  api_number        text,
  formation_name    text not null,
  top_depth_ft      numeric,
  base_depth_ft     numeric,
  depth_reference   text,               -- MD | TVD | TVDSS — never assume, always store what was actually reported
  source            text not null,
  source_url_or_doc_id text,
  retrieved_at      timestamptz not null default now(),
  created_at        timestamptz not null default now()
);

alter table formation_tops enable row level security;

create policy "Users see own formation tops"
  on formation_tops for all
  using (exists (
    select 1 from trrc_due_diligence_runs r
    where r.id = run_id and r.user_id = auth.uid()
  ));

create index if not exists formation_tops_run_id_idx on formation_tops(run_id);

-- ── 4. Structure/depth surfaces (schema present, unused in V1) ─────────────────
-- Same rationale as formation_tops — no public structure/depth surface
-- dataset exists to populate this table today.
create table if not exists geology_surfaces (
  id                uuid primary key default gen_random_uuid(),
  run_id            uuid not null references trrc_due_diligence_runs(id) on delete cascade,
  formation_name    text not null,
  surface_geojson   jsonb,
  depth_reference   text,
  source            text not null,
  source_url_or_doc_id text,
  retrieved_at      timestamptz not null default now(),
  created_at        timestamptz not null default now()
);

alter table geology_surfaces enable row level security;

create policy "Users see own geology surfaces"
  on geology_surfaces for all
  using (exists (
    select 1 from trrc_due_diligence_runs r
    where r.id = run_id and r.user_id = auth.uid()
  ));

create index if not exists geology_surfaces_run_id_idx on geology_surfaces(run_id);

-- ── 5. Assessment (one row per run) ─────────────────────────────────────────────
create table if not exists geology_assessments (
  id                     uuid primary key default gen_random_uuid(),
  run_id                 uuid not null references trrc_due_diligence_runs(id) on delete cascade,

  classification         text not null,   -- FAVORABLE | MIXED | UNFAVORABLE | INSUFFICIENT_DATA
  confidence             text not null,   -- HIGH | MODERATE | LOW
  confidence_dimensions  jsonb default '{}',

  diligence_implication  text not null,

  subject_formation      text,
  producing_formation    text,
  permitted_formation    text,
  subject_tvd_ft         numeric,
  subject_tvdss_ft       numeric,
  tvdss_elevation_source text,
  tvdss_methodology      text,           -- e.g. "TVDSS = TVD - reference elevation"; null when TVDSS could not be calculated

  target_formation_data_gap boolean not null default true,  -- true unless a real formation-top/depth source was actually used

  generated_at           timestamptz not null default now(),
  created_at             timestamptz not null default now(),

  unique (run_id)
);

alter table geology_assessments enable row level security;

create policy "Users see own geology assessments"
  on geology_assessments for all
  using (exists (
    select 1 from trrc_due_diligence_runs r
    where r.id = run_id and r.user_id = auth.uid()
  ));

create index if not exists geology_assessments_run_id_idx on geology_assessments(run_id);

-- ── 6. Findings (supporting / contradicting / risk / gap) ──────────────────────
create table if not exists geology_findings (
  id                uuid primary key default gen_random_uuid(),
  run_id            uuid not null references trrc_due_diligence_runs(id) on delete cascade,

  category          text not null,   -- supporting | contradicting | risk | gap
  classification    text not null,   -- observed | calculated | inferred
  title             text not null,
  description       text not null,

  evidence_ids      uuid[] default '{}',   -- references geology_evidence.id, not enforced as an FK array (Postgres has no array-FK) but validated at write time by evidence.ts

  display_order      integer default 0,
  created_at         timestamptz not null default now()
);

alter table geology_findings enable row level security;

create policy "Users see own geology findings"
  on geology_findings for all
  using (exists (
    select 1 from trrc_due_diligence_runs r
    where r.id = run_id and r.user_id = auth.uid()
  ));

create index if not exists geology_findings_run_id_idx on geology_findings(run_id);
create index if not exists geology_findings_category_idx on geology_findings(category);

-- ── 7. Evidence ledger ───────────────────────────────────────────────────────
-- One row per material fact cited anywhere in the assessment. Inferred
-- values must never be written here with classification='observed' — the
-- classification column is exactly what stops an inference from
-- masquerading as source data (see interpretation.ts).
create table if not exists geology_evidence (
  id                    uuid primary key default gen_random_uuid(),
  run_id                uuid not null references trrc_due_diligence_runs(id) on delete cascade,

  field_name            text not null,        -- what material fact this backs, e.g. "offset_well_count_3mi"
  classification        text not null,        -- observed | calculated | inferred

  source                text not null,
  source_url_or_doc_id  text,
  retrieved_at          timestamptz not null default now(),

  raw_value             text,
  normalized_value      text,
  confidence            numeric,              -- 0-1, null when not applicable

  transformation_method text,                 -- formula/method for calculated values; null for raw observed facts

  created_at            timestamptz not null default now()
);

alter table geology_evidence enable row level security;

create policy "Users see own geology evidence"
  on geology_evidence for all
  using (exists (
    select 1 from trrc_due_diligence_runs r
    where r.id = run_id and r.user_id = auth.uid()
  ));

create index if not exists geology_evidence_run_id_idx on geology_evidence(run_id);
create index if not exists geology_evidence_field_name_idx on geology_evidence(field_name);

-- ── 8. Well logs (Phase 5 — schema only, no live data source connected yet) ────
create table if not exists well_log_files (
  id                uuid primary key default gen_random_uuid(),
  run_id            uuid not null references trrc_due_diligence_runs(id) on delete cascade,
  api_number        text,
  file_name         text not null,
  storage_path      text not null,
  file_format       text not null default 'LAS',
  uploaded_by       uuid references auth.users(id),
  uploaded_at       timestamptz not null default now(),
  created_at        timestamptz not null default now()
);

alter table well_log_files enable row level security;

create policy "Users see own log files"
  on well_log_files for all
  using (exists (
    select 1 from trrc_due_diligence_runs r
    where r.id = run_id and r.user_id = auth.uid()
  ));

create index if not exists well_log_files_run_id_idx on well_log_files(run_id);

create table if not exists well_log_curves (
  id                uuid primary key default gen_random_uuid(),
  log_file_id       uuid not null references well_log_files(id) on delete cascade,
  curve_type        text not null,    -- GR | RESISTIVITY | BULK_DENSITY | NEUTRON_POROSITY | SONIC | CALIPER
  unit              text,
  depth_start_ft    numeric,
  depth_stop_ft     numeric,
  step_ft           numeric,
  values_json       jsonb,            -- [{depth, value}, ...] — small logs only; large curves belong in storage, not this column
  created_at        timestamptz not null default now()
);

alter table well_log_curves enable row level security;

create policy "Users see own log curves"
  on well_log_curves for all
  using (exists (
    select 1 from well_log_files f
    join trrc_due_diligence_runs r on r.id = f.run_id
    where f.id = log_file_id and r.user_id = auth.uid()
  ));

create index if not exists well_log_curves_log_file_id_idx on well_log_curves(log_file_id);

-- ── 9. Petrophysical results (Phase 5) ──────────────────────────────────────────
-- Deliberately NO numeric "rock quality score" column — per-calculation
-- deterministic results only (gross/net thickness, Vshale, density porosity,
-- etc.), each with its own methodology string. See petrophysics.ts.
create table if not exists petrophysical_results (
  id                uuid primary key default gen_random_uuid(),
  run_id            uuid not null references trrc_due_diligence_runs(id) on delete cascade,
  log_file_id       uuid references well_log_files(id) on delete set null,

  calculation_type  text not null,    -- GROSS_THICKNESS | NET_THICKNESS | VSHALE_GR | DENSITY_POROSITY | NEUTRON_DENSITY_XPLOT | LITHOLOGY_INDICATOR
  result_value      numeric,
  unit              text,
  methodology       text not null,
  inputs_json       jsonb default '{}',   -- preserves the exact input values/curves used, per the spec's provenance requirement

  computed_at       timestamptz not null default now(),
  created_at        timestamptz not null default now()
);

alter table petrophysical_results enable row level security;

create policy "Users see own petrophysical results"
  on petrophysical_results for all
  using (exists (
    select 1 from trrc_due_diligence_runs r
    where r.id = run_id and r.user_id = auth.uid()
  ));

create index if not exists petrophysical_results_run_id_idx on petrophysical_results(run_id);
