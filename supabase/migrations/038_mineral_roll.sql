-- County appraisal district mineral rolls: current owners and decimal
-- interests per RRC lease, as a sourced public-record dataset.
--
-- This is the ownership step of API -> lease -> lease records -> ownership
-- -> decision. The courthouse chain explains how title moved; the roll says
-- who is paid today and what share. Every row keeps the county, tax year and
-- the SHA-256 of the exact file it came from, so a report can cite
-- "Martin CAD mineral roll, tax year 2025" and anyone can reproduce it.
--
-- Decimals are revenue decimals of the whole lease as the appraisal district
-- carries them (from operator division orders, as of January 1). They are
-- evidence of current ownership, not a title opinion.

create table if not exists public.mineral_roll_imports (
  id                    uuid primary key default gen_random_uuid(),
  county                text not null,                 -- upper case, e.g. MARTIN
  tax_year              integer not null,
  appraisal_job_number  text,
  source_file_name      text not null,
  source_sha256         text not null,
  row_count             integer not null default 0,
  status                text not null default 'loading', -- loading | complete | failed
  -- How INTEREST TYPE codes were labeled, stated so the label is never
  -- presented as more certain than it is.
  interest_type_basis   text,
  imported_at           timestamptz not null default now(),
  unique (county, tax_year, source_sha256)
);

create table if not exists public.mineral_roll_interests (
  id                      bigserial primary key,
  import_id               uuid not null references public.mineral_roll_imports(id) on delete cascade,
  county                  text not null,
  tax_year                integer not null,
  rrc_lease_number        text,          -- digits of the roll's "RRC #" field
  cad_lease_number        text,
  lease_name              text,
  operator_name           text,
  legal_description       text,
  owner_number            text,
  owner_name              text not null,
  in_care_of              text,
  mailing_address         text,
  mailing_city_state_zip  text,
  interest_type_code      text,
  interest_type           text,          -- royalty | overriding_royalty | working_interest | unknown
  decimal_interest        numeric,
  acres                   numeric,
  market_value            numeric,       -- jurisdiction 1 market value, dollars
  mineral_account_number  text,
  privacy_code            text,
  source_row              integer not null
);

create index if not exists mineral_roll_interests_lease_idx on public.mineral_roll_interests (county, rrc_lease_number);
create index if not exists mineral_roll_interests_import_idx on public.mineral_roll_interests (import_id);

-- Public records, shared by every account: readable when signed in, written
-- only by the service role (the importer).
alter table public.mineral_roll_imports enable row level security;
alter table public.mineral_roll_interests enable row level security;
drop policy if exists "Signed-in users read mineral roll imports" on public.mineral_roll_imports;
create policy "Signed-in users read mineral roll imports" on public.mineral_roll_imports for select to authenticated using (true);
drop policy if exists "Signed-in users read mineral roll interests" on public.mineral_roll_interests;
create policy "Signed-in users read mineral roll interests" on public.mineral_roll_interests for select to authenticated using (true);
