-- ─────────────────────────────────────────────────────────────────────────────
-- Title Chain Research Jobs — API number -> well -> candidate tracts ->
-- documents -> instruments -> ownership graph -> report.
--
-- Extends migration 027's normalized entities (title_instruments,
-- title_instrument_parties, title_instrument_tracts, title_claims,
-- title_canonical_tracts, title_canonical_parties, title_findings,
-- title_evidence, title_assessments) instead of creating competing models:
-- every 027 table gains a nullable job_id so an instrument can belong either
-- to a legacy due-diligence run (run_id) or to a research job (job_id).
-- run_id becomes nullable with a CHECK that at least one owner is set, and
-- every RLS policy is widened to "owner of the run OR owner of the job".
--
-- New tables own the concepts 027 never modeled: the persistent research
-- job, the per-API well resolution, retrieved/uploaded documents with
-- content hashes, an extraction cache keyed by document hash, well->tract
-- associations with evidence + review status, a search-coverage log, a
-- review queue, and versioned analysis results.
--
-- Status vocabulary for title_assessments.classification is preserved
-- verbatim (NO_SURFACE_DISCONTINUITIES_DETECTED | POTENTIAL_GAPS_DETECTED |
-- POTENTIAL_CONFLICTS_DETECTED | INSUFFICIENT_DATA). Text enums, not
-- Postgres enums — TypeScript owns enforcement (same convention as 023/027).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Research jobs ──────────────────────────────────────────────────────────
create table if not exists title_research_jobs (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references auth.users(id) on delete cascade,

  -- pending | resolving_wells | searching_records | awaiting_tract_confirmation
  -- | awaiting_documents | ingesting | analyzing | complete | failed | cancelled
  status                 text not null default 'pending',
  stage_detail           text,
  progress_percent       integer not null default 0,
  error_summary          text,
  attempt_count          integer not null default 0,

  input_text             text not null,
  interest_scope         text[] not null default '{minerals}',   -- surface | minerals | leasehold | royalty
  research_start_date    text,      -- ISO date the user asked research to begin from (null = earliest evidenced)
  as_of_date             text,      -- ISO date; research is "as of" this date
  state_code             text not null default 'TX',

  coverage_json          jsonb not null default '[]'::jsonb,   -- source coverage summary written by worker/analysis
  limitations_json       jsonb not null default '[]'::jsonb,   -- outstanding limitations (provider unavailable, OCR failed, ...)

  latest_analysis_id     uuid,      -- set after analysis; FK added below
  schema_version         text not null default '1.0.0',

  started_at             timestamptz,
  completed_at           timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

alter table title_research_jobs enable row level security;

create policy "Users see own title research jobs"
  on title_research_jobs for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists title_research_jobs_user_id_idx on title_research_jobs(user_id);
create index if not exists title_research_jobs_status_idx on title_research_jobs(status);

create trigger title_research_jobs_updated_at
  before update on title_research_jobs
  for each row execute function update_updated_at_column();

-- ── 2. Job wells (one row per submitted API number, valid or not) ────────────
create table if not exists title_job_wells (
  id                     uuid primary key default gen_random_uuid(),
  job_id                 uuid not null references title_research_jobs(id) on delete cascade,
  user_id                uuid not null references auth.users(id) on delete cascade,

  original_input         text not null,
  api10                  text,        -- null when the input failed validation
  api14                  text,
  sidetrack_suffix       text,        -- preserved 2-digit sidetrack code from a 12/14-digit input, else null
  completion_suffix      text,
  state_code             text,
  county_code            text,
  county_name            text,
  validation_error       text,        -- per-input error; never fails the batch

  -- unresolved | resolved | not_found | error
  resolution_status      text not null default 'unresolved',
  resolution_error       text,

  well_name              text,
  well_number            text,
  operator_name          text,
  operator_number        text,
  district               text,
  lease_number           text,
  lease_name             text,
  field_name             text,
  latitude               numeric,
  longitude              numeric,
  well_path_json         jsonb,       -- available well-path geometry (surface/bottomhole/lateral), null if unavailable
  survey_name            text,
  abstract_number        text,
  block_number           text,
  section_name           text,
  permit_refs_json       jsonb not null default '[]'::jsonb,
  completion_refs_json   jsonb not null default '[]'::jsonb,
  source_urls_json       jsonb not null default '[]'::jsonb,   -- [{source, url, retrieved_at, status}]
  retrieved_at           timestamptz,

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  unique (job_id, api10, sidetrack_suffix, completion_suffix)
);

alter table title_job_wells enable row level security;

create policy "Users see own title job wells"
  on title_job_wells for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists title_job_wells_job_id_idx on title_job_wells(job_id);
create index if not exists title_job_wells_api10_idx on title_job_wells(api10);

create trigger title_job_wells_updated_at
  before update on title_job_wells
  for each row execute function update_updated_at_column();

-- ── 3. Documents (originals: TRRC images, county instruments, user uploads) ──
create table if not exists title_documents (
  id                     uuid primary key default gen_random_uuid(),
  job_id                 uuid not null references title_research_jobs(id) on delete cascade,
  user_id                uuid not null references auth.users(id) on delete cascade,
  well_id                uuid references title_job_wells(id) on delete set null,

  -- trrc_coda | trrc_permit | county_record_image | county_record_index | user_upload | pasted_text
  source                 text not null,
  source_identifier      text,
  source_url             text,
  retrieved_at           timestamptz not null default now(),

  -- w1_application | location_plat | completion_report | lease | unit_agreement | deed | other | unknown
  document_category      text not null default 'unknown',
  file_name              text,
  mime_type              text,
  byte_size              integer,
  storage_path           text,        -- null for pasted text (text is stored inline)
  content_hash           text not null,   -- sha256 hex of the original bytes (or of the pasted text)
  page_count             integer,

  has_text_layer         boolean,
  ocr_status             text not null default 'not_needed',   -- not_needed | pending | done | failed
  extracted_text         text,
  extraction_status      text not null default 'pending',      -- pending | done | failed | skipped
  extraction_error       text,

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  unique (job_id, content_hash)
);

alter table title_documents enable row level security;

create policy "Users see own title documents"
  on title_documents for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists title_documents_job_id_idx on title_documents(job_id);
create index if not exists title_documents_content_hash_idx on title_documents(content_hash);

create trigger title_documents_updated_at
  before update on title_documents
  for each row execute function update_updated_at_column();

-- ── 4. Extraction cache keyed by content hash ────────────────────────────────
-- Identical bytes produce identical extraction; a document uploaded twice
-- (or across two jobs) is never sent to the model twice. Scoped to user_id
-- so tenant isolation holds even though the hash is content-derived.
create table if not exists title_document_extractions (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references auth.users(id) on delete cascade,
  content_hash           text not null,
  schema_version         text not null,
  extractor              text not null,      -- deterministic | claude
  model                  text,
  extraction_json        jsonb not null,
  created_at             timestamptz not null default now(),

  unique (user_id, content_hash, schema_version, extractor)
);

alter table title_document_extractions enable row level security;

create policy "Users see own title document extractions"
  on title_document_extractions for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists title_document_extractions_hash_idx on title_document_extractions(content_hash);

-- ── 5. Well -> tract associations (evidence, type, confidence, review) ───────
create table if not exists title_well_tract_associations (
  id                     uuid primary key default gen_random_uuid(),
  job_id                 uuid not null references title_research_jobs(id) on delete cascade,
  user_id                uuid not null references auth.users(id) on delete cascade,
  well_id                uuid not null references title_job_wells(id) on delete cascade,
  canonical_tract_id     uuid not null references title_canonical_tracts(id) on delete cascade,

  -- surface_location | bottomhole_location | well_path | permit_acreage | lease_unit_boundary | legal_tract | user_supplied
  association_type       text not null,
  confidence             numeric not null,
  evidence_json          jsonb not null default '[]'::jsonb,   -- [{document_id, page, excerpt, source, url}]
  review_status          text not null default 'proposed',      -- proposed | confirmed | rejected
  reviewed_at            timestamptz,

  created_at             timestamptz not null default now(),

  unique (well_id, canonical_tract_id, association_type)
);

alter table title_well_tract_associations enable row level security;

create policy "Users see own title well tract associations"
  on title_well_tract_associations for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists title_well_tract_associations_job_idx on title_well_tract_associations(job_id);

-- ── 6. Search log (what was searched, where, with what result) ───────────────
create table if not exists title_search_log (
  id                     uuid primary key default gen_random_uuid(),
  job_id                 uuid not null references title_research_jobs(id) on delete cascade,
  user_id                uuid not null references auth.users(id) on delete cascade,

  provider               text not null,     -- trrc_ewa | trrc_gis | trrc_coda | county:<provider id> | none
  county                 text,
  query_type             text not null,     -- api | party_name | legal_description | instrument_ref | lease_name | operator
  query_value            text not null,
  date_from              text,
  date_to                text,
  status                 text not null,     -- success | empty | failed | provider_unavailable | skipped_bounded
  result_count           integer not null default 0,
  error_message          text,
  source_url             text,
  depth                  integer not null default 0,
  searched_at            timestamptz not null default now(),

  unique (job_id, provider, query_type, query_value)
);

alter table title_search_log enable row level security;

create policy "Users see own title search log"
  on title_search_log for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists title_search_log_job_idx on title_search_log(job_id);

-- ── 7. Review queue ──────────────────────────────────────────────────────────
create table if not exists title_review_items (
  id                     uuid primary key default gen_random_uuid(),
  job_id                 uuid not null references title_research_jobs(id) on delete cascade,
  user_id                uuid not null references auth.users(id) on delete cascade,

  kind                   text not null,     -- tract_match | identity_match | extraction_ambiguity | provider_unavailable | ocr_failed | missing_tract
  title                  text not null,
  detail                 text,
  payload_json           jsonb not null default '{}'::jsonb,
  status                 text not null default 'open',    -- open | resolved | dismissed
  resolution_json        jsonb,
  resolved_at            timestamptz,
  created_at             timestamptz not null default now()
);

alter table title_review_items enable row level security;

create policy "Users see own title review items"
  on title_review_items for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists title_review_items_job_idx on title_review_items(job_id);

-- ── 8. Versioned analysis results ───────────────────────────────────────────
create table if not exists title_analyses (
  id                     uuid primary key default gen_random_uuid(),
  job_id                 uuid not null references title_research_jobs(id) on delete cascade,
  user_id                uuid not null references auth.users(id) on delete cascade,
  version                integer not null,
  schema_version         text not null,
  status_classification  text not null,     -- 027 vocabulary
  analysis_json          jsonb not null,    -- the single validated TitleChainAnalysis the table AND the JSON download are rendered from
  input_fingerprint      text not null,     -- hash of instrument/claim ids + review state; identical fingerprint => idempotent re-run
  created_at             timestamptz not null default now(),

  unique (job_id, version)
);

alter table title_analyses enable row level security;

create policy "Users see own title analyses"
  on title_analyses for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists title_analyses_job_idx on title_analyses(job_id);

alter table title_research_jobs
  drop constraint if exists title_research_jobs_latest_analysis_fk;
alter table title_research_jobs
  add constraint title_research_jobs_latest_analysis_fk
  foreign key (latest_analysis_id) references title_analyses(id) on delete set null;

-- ── 9. Extend 027 entities: job ownership + richer instrument fields ─────────
-- run_id becomes nullable; job_id added; either may own the row.
do $$
declare
  t text;
begin
  foreach t in array array[
    'title_instruments', 'title_instrument_parties', 'title_instrument_tracts',
    'title_canonical_tracts', 'title_canonical_parties', 'title_party_aliases',
    'title_claims', 'title_evidence', 'title_assessments', 'title_findings'
  ] loop
    execute format('alter table %I alter column run_id drop not null', t);
    execute format('alter table %I add column if not exists job_id uuid references title_research_jobs(id) on delete cascade', t);
    execute format('create index if not exists %I on %I(job_id)', t || '_job_id_idx', t);
    execute format('alter table %I drop constraint if exists %I', t, t || '_owner_chk');
    execute format('alter table %I add constraint %I check (run_id is not null or job_id is not null)', t, t || '_owner_chk');
  end loop;
end $$;

-- Instruments: separate execution / effective / recording dates, instrument
-- number vs. book/page, county, referenced instruments, signature and
-- acknowledgment observations, the originating document, and the full
-- validated extraction (verbatim text preserved alongside normalized fields).
alter table title_instruments
  add column if not exists document_id uuid references title_documents(id) on delete set null,
  add column if not exists execution_date text,
  add column if not exists effective_date text,
  add column if not exists instrument_number text,
  add column if not exists county text,
  add column if not exists referenced_instruments_json jsonb not null default '[]'::jsonb,
  add column if not exists signature_observations_json jsonb not null default '[]'::jsonb,
  add column if not exists acknowledgment_observations_json jsonb not null default '[]'::jsonb,
  add column if not exists extraction_json jsonb,
  add column if not exists dedupe_key text;

create index if not exists title_instruments_dedupe_key_idx on title_instruments(dedupe_key);
create index if not exists title_instruments_document_id_idx on title_instruments(document_id);

-- Parties: verbatim name and representative-capacity detail.
alter table title_instrument_parties
  add column if not exists party_name_verbatim text,
  add column if not exists capacity_detail text,   -- e.g. "Independent Executor of the Estate of ..."
  add column if not exists source_page integer,
  add column if not exists source_excerpt text;

-- Tracts: exact fractions (numerator/denominator + stated basis), reservations,
-- exceptions, verbatim legal description, citations.
alter table title_instrument_tracts
  add column if not exists fraction_numerator bigint,
  add column if not exists fraction_denominator bigint,
  add column if not exists fraction_basis text,          -- of_entire_estate | of_grantor_interest | unknown
  add column if not exists fraction_verbatim text,
  add column if not exists reservation_text text,
  add column if not exists exceptions_text text,
  add column if not exists legal_description_verbatim text,
  add column if not exists source_page integer,
  add column if not exists source_excerpt text;

-- Claims: what the instrument does to the interest, with exact fraction.
alter table title_claims
  add column if not exists effect text,                  -- conveyance | reservation | lease_grant | assignment | release | encumbrance | succession | other
  add column if not exists interest_type text,
  add column if not exists fraction_numerator bigint,
  add column if not exists fraction_denominator bigint,
  add column if not exists fraction_basis text,
  add column if not exists notes text;

-- Findings: severity, affected scope, citations, next action.
alter table title_findings
  add column if not exists severity text,                -- critical | high | medium | low | info
  add column if not exists affected_tract_id uuid,
  add column if not exists affected_interest_type text,
  add column if not exists citations_json jsonb not null default '[]'::jsonb,
  add column if not exists next_action text,
  add column if not exists analysis_id uuid references title_analyses(id) on delete cascade;

-- Canonical tracts: which well(s) and how the tract was proposed.
alter table title_canonical_tracts
  add column if not exists tract_label text,
  add column if not exists gross_acres numeric,
  add column if not exists source_json jsonb not null default '[]'::jsonb;

-- ── 10. Widen 027 RLS policies to run-owner OR job-owner ─────────────────────
do $$
declare
  t text;
  p text;
begin
  for t, p in
    select * from (values
      ('title_instruments',         'Users see own title instruments'),
      ('title_instrument_parties',  'Users see own title instrument parties'),
      ('title_instrument_tracts',   'Users see own title instrument tracts'),
      ('title_canonical_tracts',    'Users see own title canonical tracts'),
      ('title_canonical_parties',   'Users see own title canonical parties'),
      ('title_party_aliases',       'Users see own title party aliases'),
      ('title_claims',              'Users see own title claims'),
      ('title_evidence',            'Users see own title evidence'),
      ('title_assessments',         'Users see own title assessments'),
      ('title_findings',            'Users see own title findings')
    ) as v(tbl, pol)
  loop
    execute format('drop policy if exists %I on %I', p, t);
    execute format($f$
      create policy %I on %I for all
      using (
        (run_id is not null and exists (select 1 from trrc_due_diligence_runs r where r.id = run_id and r.user_id = auth.uid()))
        or
        (job_id is not null and exists (select 1 from title_research_jobs j where j.id = job_id and j.user_id = auth.uid()))
      )
      with check (
        (run_id is not null and exists (select 1 from trrc_due_diligence_runs r where r.id = run_id and r.user_id = auth.uid()))
        or
        (job_id is not null and exists (select 1 from title_research_jobs j where j.id = job_id and j.user_id = auth.uid()))
      )
    $f$, p, t);
  end loop;
end $$;

-- ── 11. Private storage bucket for original documents ───────────────────────
-- Objects are stored under "<user_id>/<job_id>/<content_hash>.<ext>"; the
-- first path segment is the owning user's id, so RLS can scope every
-- operation to the caller's own folder. The worker writes with the
-- service role (bypasses RLS) and never with a user token.
insert into storage.buckets (id, name, public)
values ('title-documents', 'title-documents', false)
on conflict (id) do nothing;

drop policy if exists "title documents owner select" on storage.objects;
create policy "title documents owner select"
  on storage.objects for select to authenticated
  using (bucket_id = 'title-documents' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "title documents owner insert" on storage.objects;
create policy "title documents owner insert"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'title-documents' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "title documents owner delete" on storage.objects;
create policy "title documents owner delete"
  on storage.objects for delete to authenticated
  using (bucket_id = 'title-documents' and (storage.foldername(name))[1] = auth.uid()::text);
