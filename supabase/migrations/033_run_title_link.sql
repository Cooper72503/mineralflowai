-- A run follows its selected research scope rather than whichever job was updated last.
alter table public.trrc_due_diligence_runs
  add column if not exists title_research_job_id uuid references public.title_research_jobs(id);

create or replace function public.validate_run_title_link()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  if new.title_research_job_id is not null and not exists (
    select 1 from public.title_research_jobs j
    join public.title_job_wells w on w.job_id = j.id and w.user_id = j.user_id
    where j.id = new.title_research_job_id and j.user_id = new.user_id
      and w.api10 = new.normalized_input
  ) then
    raise exception 'Title link must belong to this account and match the run API';
  end if;
  return new;
end;
$$;
drop trigger if exists validate_run_title_link on public.trrc_due_diligence_runs;
create trigger validate_run_title_link
before insert or update of title_research_job_id, user_id, normalized_input
on public.trrc_due_diligence_runs for each row execute function public.validate_run_title_link();
