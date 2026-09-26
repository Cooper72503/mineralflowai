-- Recorded EIA price decks. The retrieval worker writes one row per
-- successful EIA pull; a report falls back to the latest row only when the
-- live EIA call fails at report time, and says so. Rows are EIA's own
-- published values with their period and retrieval time, never estimates.
create table public.eia_price_snapshots (
 id uuid primary key default gen_random_uuid(),
 period text not null,                 -- EIA's latest monthly period, e.g. 2026-08
 wti_spot_usd_bbl numeric not null check (wti_spot_usd_bbl > 0),
 henry_hub_usd_mmbtu numeric not null check (henry_hub_usd_mmbtu > 0),
 wti_trailing_12_usd_bbl numeric not null check (wti_trailing_12_usd_bbl > 0),
 henry_hub_trailing_12_usd_mmbtu numeric not null check (henry_hub_trailing_12_usd_mmbtu > 0),
 series jsonb not null,                -- EIA routes and series ids queried
 retrieved_at timestamptz not null default now()
);
create index eia_price_snapshots_latest on public.eia_price_snapshots (retrieved_at desc);
alter table public.eia_price_snapshots enable row level security;
revoke all on public.eia_price_snapshots from anon, authenticated;
grant select on public.eia_price_snapshots to authenticated;
grant select, insert on public.eia_price_snapshots to service_role;
create policy eia_snapshots_read on public.eia_price_snapshots for select to authenticated using (true);
