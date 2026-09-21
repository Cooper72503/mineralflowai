-- Persistent API packages. Intake is one transaction; existing workers own retrieval.
create table public.trrc_packages (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id),
 request_key uuid not null,
 request_json jsonb not null,
 members_json jsonb not null,
 status text not null default 'queued' check(status in ('queued','generating','evidence_ready','failed')),
 record_id uuid references public.trrc_portfolio_records(id),
 gold_records_json jsonb,
 claim_token uuid,
 lease_until timestamptz,
 attempts integer not null default 0,
 error_summary text,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(user_id,request_key)
);
alter table public.trrc_packages enable row level security;
revoke all on public.trrc_packages from anon,authenticated;
grant select on public.trrc_packages to authenticated;
grant select,update on public.trrc_packages to service_role;
create policy package_owner_read on public.trrc_packages for select to authenticated using(user_id=auth.uid());
create index trrc_packages_work on public.trrc_packages(status,created_at);

-- Definer is needed because clients cannot mutate queued packages outside this
-- validated transaction. Ownership always comes from auth.uid(), never JSON.
create or replace function public.enqueue_api_package(p_key uuid,p_entries jsonb,p_options jsonb default '{}'::jsonb)
returns uuid language plpgsql security definer set search_path=public as $$
declare
 v_user uuid:=auth.uid(); v_existing public.trrc_packages; v_id uuid;
 v_request jsonb:=jsonb_build_object('entries',p_entries,'options',p_options);
 v_members jsonb:='[]'; e jsonb; v_run jsonb; v_job jsonb; v_titles uuid[]; v_title uuid;
 v_warning text; v_digits text;
begin
 if v_user is null then raise exception 'Authentication required'; end if;
 if p_key is null or jsonb_typeof(p_entries) is distinct from 'array' or jsonb_typeof(p_options) is distinct from 'object' then raise exception 'Invalid package input'; end if;
 if jsonb_array_length(p_entries) not between 1 and 50 then raise exception 'Package requires 1-50 entries'; end if;
 perform pg_advisory_xact_lock(hashtextextended(v_user::text||p_key::text,0));
 select * into v_existing from public.trrc_packages where user_id=v_user and request_key=p_key;
 if found then
  if v_existing.request_json<>v_request then raise exception 'Request key already used for different inputs'; end if;
  return v_existing.id;
 end if;
 perform pg_advisory_xact_lock(hashtextextended(v_user::text,1));
 for e in select value from jsonb_array_elements(p_entries) loop
  if nullif(btrim(e->>'input'),'') is null or length(e->>'input')>500 then raise exception 'Invalid entry'; end if;
  if e->>'api10' is null then
   v_members:=v_members||jsonb_build_array(jsonb_build_object('input',e->>'input','runId',null,'error',coalesce(e->>'error','Invalid Texas API')));
   continue;
  end if;
  v_digits:=regexp_replace(e->>'input','[^0-9]','','g');
  if length(v_digits)=8 then v_digits:='42'||v_digits; end if;
  if e->>'api10' !~ '^42[0-9]{8}$' or length(v_digits) not in(10,12,14) or left(v_digits,10)<>e->>'api10' then raise exception 'API does not match original input'; end if;
  -- Serialize title-scope discovery for this owner/API across package submissions.
  select array_agg(distinct j.id) into v_titles from public.title_research_jobs j
   join public.title_job_wells w on w.job_id=j.id and w.user_id=j.user_id
   where j.user_id=v_user and w.api10=e->>'api10' and j.status not in('cancelled','failed');
  v_title:=null;v_warning:=null;
  if coalesce(cardinality(v_titles),0)=1 then v_title:=v_titles[1];
  elsif coalesce(cardinality(v_titles),0)>1 then v_warning:='Multiple live title research scopes match this API; select the intended scope.';
  else
   v_job:=public.create_title_research_job(jsonb_build_object('input_text',e->>'input','interest_scope',jsonb_build_array('minerals'),'as_of_date',current_date::text),
    jsonb_build_array(jsonb_build_object('original_input',e->>'input','api10',e->>'api10','api14',e->>'api14','state_code','42','county_code',substring(e->>'api10',3,3),'county_name',e->>'countyName','sidetrack_suffix',e->>'sidetrackSuffix','completion_suffix',e->>'completionSuffix')));
   v_title:=(v_job->>'id')::uuid;
  end if;
  v_run:=public.create_due_diligence_run(jsonb_build_object('original_input',e->>'input','normalized_input',e->>'api10','detected_input_type','api_number','selected_input_type','api_number','status','pending','resolved_primary_api',e->>'api10','title_research_job_id',v_title,'title_setup_warning',v_warning),'[]');
  v_members:=v_members||jsonb_build_array(jsonb_build_object('input',e->>'input','runId',v_run->>'id','error',v_warning));
 end loop;
 insert into public.trrc_packages(user_id,request_key,request_json,members_json) values(v_user,p_key,v_request,v_members) returning id into v_id;
 return v_id;
end;
$$;
revoke all on function public.enqueue_api_package(uuid,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.enqueue_api_package(uuid,jsonb,jsonb) to authenticated;

-- Fenced publication: failed/stale workers cannot overwrite a newer claim.
create or replace function public.finish_api_package(p_id uuid,p_token uuid,p_input jsonb,p_record jsonb,p_gold jsonb,p_versions jsonb)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_package public.trrc_packages; v_record uuid; v jsonb;
begin
 select * into v_package from public.trrc_packages where id=p_id for update;
 if not found or v_package.status<>'generating' or v_package.claim_token is distinct from p_token or v_package.lease_until<now() then raise exception 'Package claim expired'; end if;
 if jsonb_typeof(p_versions) is distinct from 'array' then raise exception 'Missing evidence versions'; end if;
 for v in select value from jsonb_array_elements(p_versions) loop
  if v->>'kind'='run' then
   perform 1 from public.trrc_due_diligence_runs where id=(v->>'id')::uuid and user_id=v_package.user_id and updated_at=(v->>'updated_at')::timestamptz and status=v->>'status' for share;
  elsif v->>'kind'='title' then
   perform 1 from public.title_research_jobs where id=(v->>'id')::uuid and user_id=v_package.user_id and updated_at=(v->>'updated_at')::timestamptz and status=v->>'status' for share;
  else raise exception 'Invalid evidence version'; end if;
  if not found then raise exception 'Evidence changed during package generation'; end if;
 end loop;
 insert into public.trrc_portfolio_records(user_id,input_json,record_json) values(v_package.user_id,p_input,p_record) returning id into v_record;
 update public.trrc_packages set status='evidence_ready',record_id=v_record,gold_records_json=p_gold,claim_token=null,lease_until=null,error_summary=null,updated_at=now() where id=p_id;
 return v_record;
end;
$$;
revoke all on function public.finish_api_package(uuid,uuid,jsonb,jsonb,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.finish_api_package(uuid,uuid,jsonb,jsonb,jsonb,jsonb) to service_role;

create or replace function public.retry_api_package(p_id uuid)
returns boolean language plpgsql security definer set search_path=public as $$
begin
 if auth.uid() is null then raise exception 'Authentication required'; end if;
 update public.trrc_packages set status='queued',attempts=0,claim_token=null,lease_until=null,error_summary=null,updated_at=now()
 where id=p_id and user_id=auth.uid() and status='failed';
 return found;
end;
$$;
revoke all on function public.retry_api_package(uuid) from public, anon, authenticated;
grant execute on function public.retry_api_package(uuid) to authenticated;
