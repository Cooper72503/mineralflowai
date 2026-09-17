-- Workers can claim pending runs immediately. Publish their inputs atomically.
alter table public.trrc_due_diligence_runs add column if not exists title_setup_warning text;

create or replace function public.create_due_diligence_run(p_run jsonb, p_entities jsonb)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_id uuid;
  v_status text := p_run->>'status';
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if jsonb_typeof(p_run) is distinct from 'object'
    or nullif(btrim(p_run->>'original_input'), '') is null
    or length(p_run->>'original_input') > 500 then
    raise exception 'Invalid run input';
  end if;
  if v_status is null or v_status not in ('pending','awaiting_selection') then
    raise exception 'Invalid initial run status';
  end if;
  if jsonb_typeof(p_entities) is distinct from 'array' then
    raise exception 'Entity inputs must be an array';
  end if;
  if jsonb_array_length(p_entities) > 500 then raise exception 'Too many candidate entities'; end if;
  if p_run->>'resolved_primary_api' is not null and p_run->>'resolved_primary_api' !~ '^42[0-9]{8}$' then
    raise exception 'Invalid Texas API';
  end if;
  if p_run->>'purchase_price' is not null and
    (jsonb_typeof(p_run->'purchase_price') <> 'number' or (p_run->>'purchase_price')::numeric <= 0) then
    raise exception 'Invalid purchase price';
  end if;
  insert into public.trrc_due_diligence_runs
    (user_id,original_input,detected_input_type,selected_input_type,normalized_input,
     status,started_at,resolved_primary_api,resolved_district,resolved_lease_number,
     operator_name,purchase_price,title_research_job_id,title_setup_warning)
  values
    (v_user,p_run->>'original_input',p_run->>'detected_input_type',p_run->>'selected_input_type',p_run->>'normalized_input',
     v_status,now(),p_run->>'resolved_primary_api',p_run->>'resolved_district',p_run->>'resolved_lease_number',
     p_run->>'operator_name',(p_run->>'purchase_price')::numeric,(p_run->>'title_research_job_id')::uuid,p_run->>'title_setup_warning')
  returning id into v_id;
  insert into public.trrc_resolved_entities
    (id,run_id,entity_type,canonical_identifier,display_name,attributes_json,confidence,resolution_method,is_user_selected)
  select coalesce((e->>'id')::uuid,gen_random_uuid()),v_id,e->>'entity_type',e->>'canonical_identifier',
    e->>'display_name',coalesce(e->'attributes_json','{}'::jsonb),(e->>'confidence')::numeric,
    e->>'resolution_method',coalesce((e->>'is_user_selected')::boolean,false)
  from jsonb_array_elements(p_entities) e;
  return jsonb_build_object('id',v_id,'status',v_status);
end;
$$;
revoke all on function public.create_due_diligence_run(jsonb,jsonb) from public;
grant execute on function public.create_due_diligence_run(jsonb,jsonb) to authenticated;
