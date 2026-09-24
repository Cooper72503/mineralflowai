-- One courthouse title scope per package. A package of wells on one lease is
-- one chain of title; 036 opened a separate title job per API, so a 20-well
-- lease searched the same tracts twenty times. APIs already covered by exactly
-- one live title scope keep it; every other API in the package shares one new job.
create or replace function public.enqueue_api_package(p_key uuid,p_entries jsonb,p_options jsonb default '{}'::jsonb)
returns uuid language plpgsql security definer set search_path=public as $$
declare
 v_user uuid:=auth.uid(); v_existing public.trrc_packages; v_id uuid;
 v_request jsonb:=jsonb_build_object('entries',p_entries,'options',p_options);
 v_members jsonb:='[]'; e jsonb; v_run jsonb; v_job jsonb; v_titles uuid[]; v_title uuid;
 v_warning text; v_digits text; v_new_wells jsonb:='[]'; v_new_apis text[]:='{}'; v_new_title uuid;
 v_plan jsonb:='[]'; p jsonb;
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
 -- Serialize title-scope discovery for this owner across package submissions.
 perform pg_advisory_xact_lock(hashtextextended(v_user::text,1));

 -- Pass 1: validate every entry and find its existing title scope, if any.
 for e in select value from jsonb_array_elements(p_entries) loop
  if nullif(btrim(e->>'input'),'') is null or length(e->>'input')>500 then raise exception 'Invalid entry'; end if;
  if e->>'api10' is null then
   v_plan:=v_plan||jsonb_build_array(jsonb_build_object('entry',e,'kind','invalid'));
   continue;
  end if;
  v_digits:=regexp_replace(e->>'input','[^0-9]','','g');
  if length(v_digits)=8 then v_digits:='42'||v_digits; end if;
  if e->>'api10' !~ '^42[0-9]{8}$' or length(v_digits) not in(10,12,14) or left(v_digits,10)<>e->>'api10' then raise exception 'API does not match original input'; end if;
  select array_agg(distinct j.id) into v_titles from public.title_research_jobs j
   join public.title_job_wells w on w.job_id=j.id and w.user_id=j.user_id
   where j.user_id=v_user and w.api10=e->>'api10' and j.status not in('cancelled','failed');
  if coalesce(cardinality(v_titles),0)=1 then
   v_plan:=v_plan||jsonb_build_array(jsonb_build_object('entry',e,'kind','existing','title',v_titles[1]));
  elsif coalesce(cardinality(v_titles),0)>1 then
   v_plan:=v_plan||jsonb_build_array(jsonb_build_object('entry',e,'kind','ambiguous'));
  else
   v_plan:=v_plan||jsonb_build_array(jsonb_build_object('entry',e,'kind','new'));
   if not (e->>'api10' = any(v_new_apis)) then
    v_new_apis:=v_new_apis||(e->>'api10');
    v_new_wells:=v_new_wells||jsonb_build_array(jsonb_build_object('original_input',e->>'input','api10',e->>'api10','api14',e->>'api14','state_code','42',
     'county_code',substring(e->>'api10',3,3),'county_name',e->>'countyName','sidetrack_suffix',e->>'sidetrackSuffix','completion_suffix',e->>'completionSuffix'));
   end if;
  end if;
 end loop;

 -- One new title job for every API in the package without a live scope.
 if jsonb_array_length(v_new_wells)>0 then
  v_job:=public.create_title_research_job(jsonb_build_object('input_text',array_to_string(v_new_apis,E'\n'),'interest_scope',jsonb_build_array('minerals'),'as_of_date',current_date::text),v_new_wells);
  v_new_title:=(v_job->>'id')::uuid;
 end if;

 -- Pass 2: one diligence run per valid entry, linked to its title scope.
 for p in select value from jsonb_array_elements(v_plan) loop
  e:=p->'entry';
  if p->>'kind'='invalid' then
   v_members:=v_members||jsonb_build_array(jsonb_build_object('input',e->>'input','runId',null,'error',coalesce(e->>'error','Invalid Texas API')));
   continue;
  end if;
  v_warning:=case when p->>'kind'='ambiguous' then 'Multiple live title research scopes match this API; select the intended scope.' end;
  v_title:=case p->>'kind' when 'existing' then (p->>'title')::uuid when 'new' then v_new_title end;
  v_run:=public.create_due_diligence_run(jsonb_build_object('original_input',e->>'input','normalized_input',e->>'api10','detected_input_type','api_number','selected_input_type','api_number','status','pending','resolved_primary_api',e->>'api10','title_research_job_id',v_title,'title_setup_warning',v_warning),'[]');
  v_members:=v_members||jsonb_build_array(jsonb_build_object('input',e->>'input','runId',v_run->>'id','error',v_warning));
 end loop;
 insert into public.trrc_packages(user_id,request_key,request_json,members_json) values(v_user,p_key,v_request,v_members) returning id into v_id;
 return v_id;
end;
$$;
revoke all on function public.enqueue_api_package(uuid,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.enqueue_api_package(uuid,jsonb,jsonb) to authenticated;
