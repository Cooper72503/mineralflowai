-- Isolated PostgreSQL fixture; execute after migration 033 against minimal test tables.
insert into title_research_jobs(id,user_id) values
('00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000001'),
('00000000-0000-0000-0000-000000000012','00000000-0000-0000-0000-000000000002');
insert into title_job_wells(job_id,user_id,api10) values
('00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000001','4216502733'),
('00000000-0000-0000-0000-000000000012','00000000-0000-0000-0000-000000000002','4216502733');
insert into trrc_due_diligence_runs(id,user_id,normalized_input,title_research_job_id) values
('00000000-0000-0000-0000-000000000021','00000000-0000-0000-0000-000000000001','4216502733','00000000-0000-0000-0000-000000000011');
do $$ begin
 begin
   update trrc_due_diligence_runs set title_research_job_id='00000000-0000-0000-0000-000000000012';
   raise exception 'TEST FAILED: cross-account link accepted';
 exception when raise_exception then
   if sqlerrm not like 'Title link must%' then raise; end if;
 end;
 begin
   update trrc_due_diligence_runs set normalized_input='4216500004';
   raise exception 'TEST FAILED: wrong-API link accepted';
 exception when raise_exception then
   if sqlerrm not like 'Title link must%' then raise; end if;
 end;
 -- Failed retrieval may clear confirmed identity without destroying the requested-API link.
 update trrc_due_diligence_runs set resolved_primary_api=null;
 if (select title_research_job_id from trrc_due_diligence_runs) <> '00000000-0000-0000-0000-000000000011'::uuid then
   raise exception 'TEST FAILED: link not preserved';
 end if;
end $$;
