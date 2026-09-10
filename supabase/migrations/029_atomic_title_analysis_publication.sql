-- Publish all title analysis artifacts atomically. RLS continues to apply.
create or replace function public.publish_title_analysis(
  p_job_id uuid, p_expected_latest uuid, p_analysis jsonb,
  p_findings jsonb, p_assessment jsonb
) returns uuid language plpgsql security invoker set search_path = public as $$
declare
  j title_research_jobs%rowtype;
  a title_analyses%rowtype;
  f title_findings%rowtype;
  s title_assessments%rowtype;
  item jsonb;
begin
  select * into j from title_research_jobs where id = p_job_id for update;
  if not found then raise exception 'Title job unavailable'; end if;
  if j.status = 'cancelled' then raise exception 'Title job cancelled'; end if;
  if j.latest_analysis_id is distinct from p_expected_latest then
    raise exception 'Title analysis changed concurrently; reload and retry';
  end if;
  a := jsonb_populate_record(null::title_analyses, p_analysis);
  if a.job_id is distinct from j.id or a.user_id is distinct from j.user_id
     or a.id is null or a.analysis_json->>'analysisId' is distinct from a.id::text
     or a.analysis_json->>'jobId' is distinct from j.id::text then
    raise exception 'Title publication identity mismatch';
  end if;
  if a.version is distinct from (select coalesce(max(version),0)+1 from title_analyses where job_id=j.id) then
    raise exception 'Title version changed concurrently; reload and retry';
  end if;
  if jsonb_typeof(p_findings) is distinct from 'array' then raise exception 'Invalid findings'; end if;
  insert into title_analyses(id,job_id,user_id,version,schema_version,status_classification,analysis_json,input_fingerprint)
    values(a.id,j.id,j.user_id,a.version,a.schema_version,a.status_classification,a.analysis_json,a.input_fingerprint);
  for item in select value from jsonb_array_elements(p_findings) loop
    f := jsonb_populate_record(null::title_findings,item);
    if f.job_id is distinct from j.id or f.analysis_id is distinct from a.id or f.run_id is not null then
      raise exception 'Title finding identity mismatch';
    end if;
    insert into title_findings(job_id,analysis_id,category,classification,finding_type,title,description,
      severity,affected_tract_id,affected_interest_type,citations_json,next_action,display_order)
      values(j.id,a.id,f.category,f.classification,f.finding_type,f.title,f.description,
        f.severity,f.affected_tract_id,f.affected_interest_type,f.citations_json,f.next_action,f.display_order);
  end loop;
  s := jsonb_populate_record(null::title_assessments,p_assessment);
  if s.job_id is distinct from j.id or s.run_id is not null then raise exception 'Title assessment identity mismatch'; end if;
  delete from title_assessments where job_id=j.id;
  insert into title_assessments(job_id,classification,confidence,confidence_dimensions,diligence_implication,
    instrument_count,distinct_party_count,earliest_instrument_date,latest_instrument_date,unresolved_finding_count,generated_at)
    values(j.id,s.classification,s.confidence,s.confidence_dimensions,s.diligence_implication,
      s.instrument_count,s.distinct_party_count,s.earliest_instrument_date,s.latest_instrument_date,s.unresolved_finding_count,s.generated_at);
  update title_research_jobs set latest_analysis_id=a.id,status='complete',progress_percent=100,
    completed_at=now(),stage_detail='Analysis v'||a.version where id=j.id;
  return a.id;
end;
$$;
revoke all on function public.publish_title_analysis(uuid,uuid,jsonb,jsonb,jsonb) from public;
grant execute on function public.publish_title_analysis(uuid,uuid,jsonb,jsonb,jsonb) to authenticated, service_role;
