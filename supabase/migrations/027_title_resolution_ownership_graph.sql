-- ─────────────────────────────────────────────────────────────────────────────
-- Title Resolution / Ownership Graph — Phase 1 (revised)
--
-- Every table FKs to the EXISTING trrc_due_diligence_runs(id), same RLS
-- pattern as 023_geology_due_diligence.sql.
--
-- Revision note: the first version of this migration modeled one grantor +
-- one grantee per row on a single title_claims table. That collapses real
-- multi-party instruments (multiple grantors, multiple grantees, spouses,
-- trustees, separate capacities, multiple tracts in one deed) and makes a
-- canonical_asset_id column meaningless without a real canonical-identity
-- table behind it. This version separates the INSTRUMENT (the document
-- itself) from its PARTIES (who's on it, in what role/capacity) and its
-- TRACTS (what land/interest it covers), with CLAIMS as the derived
-- assertion linking an instrument to a specific tract. Canonical tract and
-- party identity get their own tables so a proposed match — confidence,
-- resolution method, resolution trace, needs-user-selection, confirmed/
-- rejected status — persists instead of existing only in memory for one run.
--
-- Deliberately NO title_scores table, no numeric score column anywhere.
-- classification/confidence/status columns are text enums documented via
-- comment, not Postgres enums — TypeScript owns enum enforcement.
--
-- Terminology note: title_assessments.classification has NO "intact"/
-- "clean" option. Phase 1 never walks or reconciles a chain — it only
-- reports the absence or presence of surface-level discontinuities and
-- variances in the available instruments. See title/types.ts.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Instruments (the document itself, one row per deed/lease/etc.) ──────
create table if not exists title_instruments (
  id                     uuid primary key default gen_random_uuid(),
  run_id                 uuid not null references trrc_due_diligence_runs(id) on delete cascade,

  instrument_type        text not null,   -- deed | mineral_deed | lease | assignment | reservation | probate | affidavit_of_heirship | release | other
  instrument_date        text,
  recorded_date           text,
  doc_number               text,
  book_volume_page          text,

  source                    text not null,   -- county_clerk_index | user_provided_bulk_import
  source_url_or_doc_id      text,
  source_doc_id              text,
  source_page                 integer,
  source_exact_language       text,
  extraction_confidence       numeric,   -- 0-1, null when not applicable

  -- A county-clerk INDEX entry proves an indexed record exists — it does not
  -- prove the legal effect of the underlying instrument (interest conveyed,
  -- reservations, exceptions). Only an instrument whose actual text has been
  -- read can have instrument_content_verified = true.
  evidence_level              text not null default 'county_index_metadata',  -- county_index_metadata | instrument_verified
  instrument_content_verified boolean not null default false,

  human_review_status         text not null default 'unreviewed',  -- unreviewed | confirmed | corrected | rejected

  created_at                   timestamptz not null default now()
);

alter table title_instruments enable row level security;

create policy "Users see own title instruments"
  on title_instruments for all
  using (exists (
    select 1 from trrc_due_diligence_runs r
    where r.id = run_id and r.user_id = auth.uid()
  ));

create index if not exists title_instruments_run_id_idx on title_instruments(run_id);

-- ── 2. Instrument parties (who's on the instrument, in what role) ──────────
-- One row per party per instrument — a deed with 3 grantors and 2 grantees
-- is 5 rows here, not a flattened single grantor/grantee pair.
create table if not exists title_instrument_parties (
  id                    uuid primary key default gen_random_uuid(),
  instrument_id         uuid not null references title_instruments(id) on delete cascade,
  run_id                uuid not null references trrc_due_diligence_runs(id) on delete cascade,

  party_name            text not null,
  role                  text not null,   -- grantor | grantee
  capacity              text not null default 'unknown',  -- individual | trustee | spouse | entity | unknown

  canonical_party_id    uuid,   -- nullable; set once title_canonical_parties resolves this name

  created_at            timestamptz not null default now()
);

alter table title_instrument_parties enable row level security;

create policy "Users see own title instrument parties"
  on title_instrument_parties for all
  using (exists (
    select 1 from trrc_due_diligence_runs r
    where r.id = run_id and r.user_id = auth.uid()
  ));

create index if not exists title_instrument_parties_run_id_idx on title_instrument_parties(run_id);
create index if not exists title_instrument_parties_instrument_id_idx on title_instrument_parties(instrument_id);
create index if not exists title_instrument_parties_canonical_party_idx on title_instrument_parties(canonical_party_id);

-- ── 3. Instrument tracts (what land/interest the instrument covers) ────────
-- One row per tract per instrument — one deed can cover multiple tracts,
-- each with its own acreage/interest figures.
create table if not exists title_instrument_tracts (
  id                          uuid primary key default gen_random_uuid(),
  instrument_id               uuid not null references title_instruments(id) on delete cascade,
  run_id                       uuid not null references trrc_due_diligence_runs(id) on delete cascade,

  county                        text,
  legal_description              text,
  abstract_number                 text,
  survey_name                      text,
  block_number                      text,
  section_name                       text,
  gross_acres                         numeric,

  interest_type                        text,   -- mineral | royalty | nonparticipating_royalty | executive | leasehold | overriding_royalty | depth_limited | formation_limited
  interest_conveyed_fraction            numeric,
  interest_reserved_fraction             numeric,
  royalty_fraction                        numeric,
  depth_or_formation_limit                 text,

  canonical_tract_id                       uuid,   -- nullable; set once title_canonical_tracts resolves this tract

  created_at                                timestamptz not null default now()
);

alter table title_instrument_tracts enable row level security;

create policy "Users see own title instrument tracts"
  on title_instrument_tracts for all
  using (exists (
    select 1 from trrc_due_diligence_runs r
    where r.id = run_id and r.user_id = auth.uid()
  ));

create index if not exists title_instrument_tracts_run_id_idx on title_instrument_tracts(run_id);
create index if not exists title_instrument_tracts_instrument_id_idx on title_instrument_tracts(instrument_id);
create index if not exists title_instrument_tracts_canonical_tract_idx on title_instrument_tracts(canonical_tract_id);

-- ── 4. Canonical tracts (persisted identity, not transient per-run memory) ─
create table if not exists title_canonical_tracts (
  id                     uuid primary key default gen_random_uuid(),
  run_id                 uuid not null references trrc_due_diligence_runs(id) on delete cascade,

  county                  text,
  abstract_number           text,
  survey_name                text,
  block_number                 text,
  section_name                   text,
  legal_description                text,

  confidence                        numeric not null,
  resolution_method                  text not null,
  resolution_trace                    text[] not null default '{}',
  needs_user_selection                 boolean not null default false,
  match_status                          text not null default 'proposed',  -- proposed | confirmed | rejected

  created_at                             timestamptz not null default now()
);

alter table title_canonical_tracts enable row level security;

create policy "Users see own title canonical tracts"
  on title_canonical_tracts for all
  using (exists (
    select 1 from trrc_due_diligence_runs r
    where r.id = run_id and r.user_id = auth.uid()
  ));

create index if not exists title_canonical_tracts_run_id_idx on title_canonical_tracts(run_id);

-- ── 5. Canonical parties (persisted identity, not transient per-run memory) ─
create table if not exists title_canonical_parties (
  id                     uuid primary key default gen_random_uuid(),
  run_id                 uuid not null references trrc_due_diligence_runs(id) on delete cascade,

  display_name            text not null,
  normalized_name           text not null,

  confidence                 numeric not null,
  resolution_method           text not null,
  resolution_trace             text[] not null default '{}',
  needs_user_selection          boolean not null default false,
  match_status                   text not null default 'proposed',  -- proposed | confirmed | rejected

  created_at                      timestamptz not null default now()
);

alter table title_canonical_parties enable row level security;

create policy "Users see own title canonical parties"
  on title_canonical_parties for all
  using (exists (
    select 1 from trrc_due_diligence_runs r
    where r.id = run_id and r.user_id = auth.uid()
  ));

create index if not exists title_canonical_parties_run_id_idx on title_canonical_parties(run_id);

-- ── 6. Party aliases (name variants observed for one canonical party) ──────
create table if not exists title_party_aliases (
  id                     uuid primary key default gen_random_uuid(),
  canonical_party_id      uuid not null references title_canonical_parties(id) on delete cascade,
  run_id                   uuid not null references trrc_due_diligence_runs(id) on delete cascade,

  alias_name                text not null,
  source_instrument_party_id uuid references title_instrument_parties(id) on delete set null,

  created_at                  timestamptz not null default now()
);

alter table title_party_aliases enable row level security;

create policy "Users see own title party aliases"
  on title_party_aliases for all
  using (exists (
    select 1 from trrc_due_diligence_runs r
    where r.id = run_id and r.user_id = auth.uid()
  ));

create index if not exists title_party_aliases_run_id_idx on title_party_aliases(run_id);
create index if not exists title_party_aliases_canonical_party_idx on title_party_aliases(canonical_party_id);

-- ── 7. Claims (one asserted fact — an instrument conveying interest in one
--       canonical tract; parties are read via title_instrument_parties, not
--       duplicated here as free text) ───────────────────────────────────────
create table if not exists title_claims (
  id                     uuid primary key default gen_random_uuid(),
  run_id                 uuid not null references trrc_due_diligence_runs(id) on delete cascade,

  instrument_id            uuid not null references title_instruments(id) on delete cascade,
  instrument_tract_id        uuid not null references title_instrument_tracts(id) on delete cascade,
  canonical_asset_id           uuid references title_canonical_tracts(id) on delete set null,

  human_review_status           text not null default 'unreviewed',  -- unreviewed | confirmed | corrected | rejected

  created_at                     timestamptz not null default now()
);

alter table title_claims enable row level security;

create policy "Users see own title claims"
  on title_claims for all
  using (exists (
    select 1 from trrc_due_diligence_runs r
    where r.id = run_id and r.user_id = auth.uid()
  ));

create index if not exists title_claims_run_id_idx on title_claims(run_id);
create index if not exists title_claims_canonical_asset_idx on title_claims(canonical_asset_id);
create index if not exists title_claims_instrument_idx on title_claims(instrument_id);

-- ── 8. Bulk import tracking (staging/progress for large user-supplied files) ─
-- A 150MB+ file is never loaded into memory whole and never re-inserted on
-- rerun — see title/bulk-import.ts. source_file_hash makes a rerun of the
-- same file a no-op past the point it already reached.
create table if not exists title_bulk_imports (
  id                       uuid primary key default gen_random_uuid(),
  run_id                   uuid not null references trrc_due_diligence_runs(id) on delete cascade,

  file_name                 text not null,
  source_file_hash            text not null,
  file_kind                     text not null default 'unknown',  -- instrument_history | current_owner_list | unknown — see bulk-import.ts: an owner-list file seeds canonical parties/tracts only, never fabricated instrument history

  status                          text not null default 'pending',  -- pending | inspecting | importing | completed | failed
  total_rows                        integer,
  processed_rows                     integer not null default 0,
  accepted_rows                       integer not null default 0,
  rejected_rows                        integer not null default 0,

  error_message                         text,

  created_at                             timestamptz not null default now(),
  updated_at                              timestamptz not null default now(),

  unique (run_id, source_file_hash)
);

alter table title_bulk_imports enable row level security;

create policy "Users see own title bulk imports"
  on title_bulk_imports for all
  using (exists (
    select 1 from trrc_due_diligence_runs r
    where r.id = run_id and r.user_id = auth.uid()
  ));

create index if not exists title_bulk_imports_run_id_idx on title_bulk_imports(run_id);

-- ── 9. Evidence ledger ───────────────────────────────────────────────────────
-- Identical shape to geology_evidence (023).
create table if not exists title_evidence (
  id                    uuid primary key default gen_random_uuid(),
  run_id                uuid not null references trrc_due_diligence_runs(id) on delete cascade,

  field_name            text not null,
  classification        text not null,        -- observed | calculated | inferred

  source                text not null,
  source_url_or_doc_id  text,
  retrieved_at          timestamptz not null default now(),

  raw_value             text,
  normalized_value      text,
  confidence            numeric,

  transformation_method text,

  created_at            timestamptz not null default now()
);

alter table title_evidence enable row level security;

create policy "Users see own title evidence"
  on title_evidence for all
  using (exists (
    select 1 from trrc_due_diligence_runs r
    where r.id = run_id and r.user_id = auth.uid()
  ));

create index if not exists title_evidence_run_id_idx on title_evidence(run_id);
create index if not exists title_evidence_field_name_idx on title_evidence(field_name);

-- ── 10. Assessment (one row per run) ────────────────────────────────────────
create table if not exists title_assessments (
  id                       uuid primary key default gen_random_uuid(),
  run_id                   uuid not null references trrc_due_diligence_runs(id) on delete cascade,

  -- No "intact"/"clean" option — Phase 1 never walks or reconciles a chain.
  classification           text not null,   -- NO_SURFACE_DISCONTINUITIES_DETECTED | POTENTIAL_GAPS_DETECTED | POTENTIAL_CONFLICTS_DETECTED | INSUFFICIENT_DATA
  confidence               text not null,   -- HIGH | MODERATE | LOW | INSUFFICIENT_DATA
  confidence_dimensions    jsonb default '{}',

  diligence_implication    text not null,

  instrument_count          integer not null default 0,
  distinct_party_count       integer not null default 0,
  earliest_instrument_date    text,
  latest_instrument_date       text,
  unresolved_finding_count      integer not null default 0,

  label                          text not null default 'AI-assisted ownership-chain reconstruction, subject to professional verification',

  generated_at                    timestamptz not null default now(),
  created_at                       timestamptz not null default now(),

  unique (run_id)
);

alter table title_assessments enable row level security;

create policy "Users see own title assessments"
  on title_assessments for all
  using (exists (
    select 1 from trrc_due_diligence_runs r
    where r.id = run_id and r.user_id = auth.uid()
  ));

create index if not exists title_assessments_run_id_idx on title_assessments(run_id);

-- ── 11. Findings (supporting / contradicting / risk / gap) ─────────────────
create table if not exists title_findings (
  id                uuid primary key default gen_random_uuid(),
  run_id            uuid not null references trrc_due_diligence_runs(id) on delete cascade,

  category          text not null,   -- supporting | contradicting | risk | gap
  classification    text not null,   -- observed | calculated | inferred
  finding_type       text,           -- POTENTIAL_ACREAGE_VARIANCE | POTENTIAL_DESCRIPTION_VARIANCE | POSSIBLE_DUPLICATE_INSTRUMENT | POTENTIAL_CHAIN_DISCONTINUITY — soft, non-accusatory naming; null for non-gap findings
  title             text not null,
  description       text not null,

  evidence_ids      uuid[] default '{}',

  display_order      integer default 0,
  created_at         timestamptz not null default now()
);

alter table title_findings enable row level security;

create policy "Users see own title findings"
  on title_findings for all
  using (exists (
    select 1 from trrc_due_diligence_runs r
    where r.id = run_id and r.user_id = auth.uid()
  ));

create index if not exists title_findings_run_id_idx on title_findings(run_id);
create index if not exists title_findings_category_idx on title_findings(category);
