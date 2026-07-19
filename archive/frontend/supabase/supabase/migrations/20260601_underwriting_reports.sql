-- ─── Underwriting Reports ────────────────────────────────────────────────────
-- Persists full DDReport JSON + deal-stage tracking per user.
-- Run in Supabase SQL Editor or via `supabase db push`.

create table if not exists public.underwriting_reports (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,

  -- Report identity (mirrors DDReport.subject fields for fast list queries)
  report_id        text not null,          -- DDReport.report_id
  lease_name       text,
  operator_name    text,
  county           text,
  state            text,
  api_numbers      text[],
  rrc_lease_number text,

  -- Quick-access economics (avoid full JSON parse for list view)
  recommendation   text,                  -- "pursue" | "review" | "pass"
  current_rate_bbl numeric,
  twelve_month_avg_bbl numeric,
  npv10_usd        numeric,
  offer_range_low  numeric,
  offer_range_high numeric,
  offer_range_mid  numeric,
  risk_score       numeric,
  data_completeness_score integer,
  overall_confidence text,
  scan_mode        text,                  -- "quick" | "full"

  -- Deal pipeline stage
  deal_stage       text not null default 'underwriting'
                   check (deal_stage in (
                     'underwriting',
                     'loi_sent',
                     'counter',
                     'under_contract',
                     'closed_won',
                     'passed'
                   )),

  -- Sharing
  share_token      text unique default encode(gen_random_bytes(16), 'hex'),
  share_enabled    boolean not null default false,

  -- Notes (simple text note per deal)
  notes            text,

  -- Full report JSON
  report_json      jsonb not null,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Row-level security: users can only touch their own rows
alter table public.underwriting_reports enable row level security;

create policy "Users manage own underwriting reports"
  on public.underwriting_reports
  for all
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Public read by share token (no auth required)
create policy "Public read by share token"
  on public.underwriting_reports
  for select
  using (share_enabled = true);

-- Index for list queries
create index if not exists underwriting_reports_user_id_idx
  on public.underwriting_reports (user_id, created_at desc);

create index if not exists underwriting_reports_share_token_idx
  on public.underwriting_reports (share_token)
  where share_enabled = true;

-- Auto-update updated_at
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

create trigger underwriting_reports_updated_at
  before update on public.underwriting_reports
  for each row execute function public.set_updated_at();
