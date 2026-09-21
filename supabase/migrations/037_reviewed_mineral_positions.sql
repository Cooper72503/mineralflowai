-- Immutable, explicitly selected mineral positions. This is not a WI model.
create table public.trrc_mineral_position_reviews (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id),
 job_id uuid not null references public.title_research_jobs(id),
 api10 text not null check(api10 ~ '^42[0-9]{8}$'),
 analysis_id uuid not null references public.title_analyses(id),
 position_json jsonb not null,
 created_at timestamptz not null default now()
);
alter table public.trrc_mineral_position_reviews enable row level security;
revoke all on public.trrc_mineral_position_reviews from anon,authenticated;
grant select on public.trrc_mineral_position_reviews to authenticated,service_role;
create policy mineral_position_owner_read on public.trrc_mineral_position_reviews for select to authenticated using(user_id=auth.uid());
alter table public.title_research_jobs add column if not exists reviewed_position_ids jsonb not null default '{}';

create or replace function public.save_reviewed_mineral_position(p_job uuid,p_api text,p_analysis uuid,p_position jsonb)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_user uuid:=auth.uid();v_job public.title_research_jobs;v_id uuid;
begin
 if v_user is null then raise exception 'Authentication required'; end if;
 select * into v_job from public.title_research_jobs where id=p_job and user_id=v_user for update;
 if not found then raise exception 'Title scope unavailable'; end if;
 if v_job.latest_analysis_id is distinct from p_analysis then raise exception 'Title analysis changed; review the current analysis'; end if;
 if not exists(select 1 from public.title_analyses where id=p_analysis and job_id=p_job and user_id=v_user) then raise exception 'Title analysis outside selected scope'; end if;
 if not exists(select 1 from public.title_job_wells where job_id=p_job and user_id=v_user and api10=p_api) then raise exception 'API outside selected title scope'; end if;
 if p_position->>'contract' is distinct from 'mineralflow-reviewed-mineral-position-1.0'
  or p_position->>'api' is distinct from p_api
  or p_position->>'analysisId' is distinct from p_analysis::text
  or p_position->>'reviewedBy' is distinct from v_user::text then raise exception 'Position identity or reviewer mismatch'; end if;
 insert into public.trrc_mineral_position_reviews(user_id,job_id,api10,analysis_id,position_json)
 values(v_user,p_job,p_api,p_analysis,p_position) returning id into v_id;
 update public.title_research_jobs set reviewed_position_ids=jsonb_set(reviewed_position_ids,array[p_api],to_jsonb(v_id::text)),updated_at=clock_timestamp() where id=p_job;
 return v_id;
end;
$$;
revoke all on function public.save_reviewed_mineral_position(uuid,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.save_reviewed_mineral_position(uuid,text,uuid,jsonb) to authenticated;
