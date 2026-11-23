-- Mineral Finder research jobs, public-source cache and normalized county inventory.
-- Does not grant title clearance, create reserves or execute purchases.
create table public.mineral_finder_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  request_key uuid not null,
  request_json jsonb not null check (jsonb_typeof(request_json) = 'object'),
  status text not null default 'queued' check (status in ('queued','running','complete','failed')),
  stage text not null default 'Queued for county research',
  result_json jsonb,
  error_summary text,
  claim_token uuid, lease_until timestamptz, attempts integer not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(user_id, request_key)
);
alter table public.mineral_finder_jobs enable row level security;
create policy finder_owner_read on public.mineral_finder_jobs for select to authenticated using(user_id = auth.uid());
revoke all on public.mineral_finder_jobs from anon, authenticated;
grant select on public.mineral_finder_jobs to authenticated;
grant all on public.mineral_finder_jobs to service_role;
create index finder_job_queue on public.mineral_finder_jobs(status, created_at);

create table public.mineral_finder_snapshots (
  cache_key text primary key, payload jsonb not null,
  fetched_at timestamptz not null, expires_at timestamptz not null
);
alter table public.mineral_finder_snapshots enable row level security;
revoke all on public.mineral_finder_snapshots from anon, authenticated;
grant all on public.mineral_finder_snapshots to service_role;

create table public.mineral_finder_wells (
  api10 text primary key check (api10 ~ '^42[0-9]{8}$'),
  county text not null check(county in ('GAINES','FISHER')),
  latitude double precision check(latitude between -90 and 90),
  longitude double precision check(longitude between -180 and 180),
  status text not null, well_json jsonb not null, snapshot_at timestamptz not null
);
create index finder_county_bbox on public.mineral_finder_wells(county,latitude,longitude);
alter table public.mineral_finder_wells enable row level security;
revoke all on public.mineral_finder_wells from anon, authenticated;
grant all on public.mineral_finder_wells to service_role;

create function public.enqueue_mineral_finder(p_key uuid, p_request jsonb) returns uuid
language plpgsql security definer set search_path = public,pg_temp as $$
declare uid uuid := auth.uid(); jid uuid; old_request jsonb;
begin
  if uid is null then raise exception 'Authentication required'; end if;
  if jsonb_typeof(p_request) <> 'object' or length(p_request::text)>6000
    or coalesce(p_request->'criteria'->>'county','') not in ('GAINES','FISHER') then raise exception 'Invalid finder request'; end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text,0));
  select id,request_json into jid,old_request from mineral_finder_jobs where user_id=uid and request_key=p_key;
  if jid is not null then
    if old_request <> p_request then raise exception 'Request key already used for different criteria'; end if;
    return jid;
  end if;
  if (select count(*) from mineral_finder_jobs where user_id=uid and status in ('queued','running'))>=2 then raise exception 'Two research runs are already active'; end if;
  insert into mineral_finder_jobs(user_id,request_key,request_json) values(uid,p_key,p_request) returning id into jid;
  return jid;
end $$;
revoke all on function public.enqueue_mineral_finder(uuid,jsonb) from public,anon;
grant execute on function public.enqueue_mineral_finder(uuid,jsonb) to authenticated;

create function public.claim_mineral_finder() returns setof public.mineral_finder_jobs
language plpgsql security definer set search_path = public,pg_temp as $$
declare jid uuid;
begin
  update mineral_finder_jobs set status='failed',stage='Research interrupted',error_summary='Worker recovery attempt limit reached',updated_at=now()
    where status='running' and lease_until<now() and attempts>=3;
  select id into jid from mineral_finder_jobs
    where (status='queued' or (status='running' and lease_until<now())) and attempts<3
    order by created_at for update skip locked limit 1;
  if jid is null then return; end if;
  return query update mineral_finder_jobs set status='running',claim_token=gen_random_uuid(),lease_until=now()+interval '20 minutes',
    attempts=attempts+1,stage='Starting county ingestion',error_summary=null,updated_at=now() where id=jid returning *;
end $$;
revoke all on function public.claim_mineral_finder() from public,anon,authenticated;
grant execute on function public.claim_mineral_finder() to service_role;

create function public.finish_mineral_finder(p_id uuid,p_token uuid,p_result jsonb) returns boolean
language plpgsql security definer set search_path = public,pg_temp as $$
begin
  if p_result->>'version' is distinct from 'mineral-finder-v1' or p_result->>'classification' is distinct from 'research_screening'
    or jsonb_typeof(p_result->'prospects') is distinct from 'array' then raise exception 'Invalid research result'; end if;
  update mineral_finder_jobs set status='complete',stage='Research screening complete; review limitations',result_json=p_result,
    claim_token=null,lease_until=null,updated_at=now() where id=p_id and claim_token=p_token and status='running' and lease_until>now();
  return found;
end $$;
revoke all on function public.finish_mineral_finder(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.finish_mineral_finder(uuid,uuid,jsonb) to service_role;
