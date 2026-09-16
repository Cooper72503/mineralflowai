-- Immutable, account-scoped snapshots; refreshing creates a new record.
create table public.trrc_portfolio_records (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade,
 input_json jsonb not null check (jsonb_typeof(input_json) = 'object'),
 record_json jsonb not null check (jsonb_typeof(record_json) = 'object'),
 created_at timestamptz not null default now()
);
create index trrc_portfolio_records_owner_created on public.trrc_portfolio_records(user_id,created_at desc);
alter table public.trrc_portfolio_records enable row level security;
revoke all on public.trrc_portfolio_records from anon, authenticated;
grant select, insert on public.trrc_portfolio_records to authenticated;
create policy portfolio_owner_read on public.trrc_portfolio_records for select to authenticated using (user_id = auth.uid());
create policy portfolio_owner_insert on public.trrc_portfolio_records for insert to authenticated with check (user_id = auth.uid());
