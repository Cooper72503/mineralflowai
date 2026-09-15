-- Publish jobs and their inputs in one transaction: polling workers cannot
-- observe a pending job without its well rows. Caller identity comes from auth.
create or replace function public.create_title_research_job(p_job jsonb, p_wells jsonb)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_id uuid;
  v_status text;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if jsonb_typeof(p_wells) is distinct from 'array' then
    raise exception 'Well inputs must be an array';
  end if;
  if jsonb_array_length(p_wells) = 0 or jsonb_array_length(p_wells) > 500 then
    raise exception 'Invalid well input count';
  end if;
  if exists (select 1 from jsonb_array_elements(p_wells) w
    where w->>'api10' is not null and w->>'api10' !~ '^42[0-9]{8}$') then
    raise exception 'Invalid Texas API';
  end if;
  v_status := case when exists (select 1 from jsonb_array_elements(p_wells) w
    where w->>'api10' is not null and w->>'validation_error' is null)
    then 'pending' else 'awaiting_tract_confirmation' end;
  insert into public.title_research_jobs
    (user_id,status,input_text,interest_scope,research_start_date,as_of_date,started_at,stage_detail)
  values (v_user,v_status,left(p_job->>'input_text',20000),
    array(select jsonb_array_elements_text(p_job->'interest_scope')),
    p_job->>'research_start_date',p_job->>'as_of_date',now(),
    case when v_status='pending' then 'Queued for well resolution'
      else 'No valid API numbers - add a tract or documents manually' end)
  returning id into v_id;
  insert into public.title_job_wells
    (job_id,user_id,original_input,api10,api14,sidetrack_suffix,completion_suffix,
     state_code,county_code,county_name,validation_error,resolution_status,resolution_error)
  select v_id,v_user,w->>'original_input',w->>'api10',w->>'api14',
    w->>'sidetrack_suffix',w->>'completion_suffix',w->>'state_code',
    w->>'county_code',w->>'county_name',w->>'validation_error',
    case when w->>'api10' is not null and w->>'validation_error' is null then 'unresolved' else 'error' end,
    w->>'validation_error'
  from jsonb_array_elements(p_wells) w;
  return jsonb_build_object('id',v_id,'status',v_status);
end;
$$;
revoke all on function public.create_title_research_job(jsonb,jsonb) from public;
grant execute on function public.create_title_research_job(jsonb,jsonb) to authenticated;
