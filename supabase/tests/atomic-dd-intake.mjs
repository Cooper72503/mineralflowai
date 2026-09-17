/** Isolated real PostgreSQL transactions/RLS; not a production auth-session test. */
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const {PGlite}=await import(process.argv[2]?pathToFileURL(process.argv[2]).href:'@electric-sql/pglite');
const db=new PGlite();
const owner='00000000-0000-4000-8000-000000000001';
const other='00000000-0000-4000-8000-000000000002';
const title='00000000-0000-4000-8000-000000000003';
try {
 await db.exec(`create role authenticated; create role anon; create schema auth;
 create table auth.users(id uuid primary key);
 create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth to authenticated;
 insert into auth.users values ('${owner}'),('${other}');`);
 for(const name of ['019_trrc_due_diligence.sql','021_runs_operator_name.sql','022_runs_purchase_price.sql'])
  await db.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
 await db.exec(`create table title_research_jobs(id uuid primary key,user_id uuid);
 create table title_job_wells(job_id uuid,user_id uuid,api10 text);
 insert into title_research_jobs values('${title}','${owner}');
 insert into title_job_wells values('${title}','${owner}','4216502733');`);
 for(const name of ['033_run_title_link.sql','035_atomic_due_diligence_intake.sql'])
  await db.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
 await db.exec(`grant select,insert,update on trrc_due_diligence_runs,trrc_resolved_entities to authenticated;
 grant select on title_research_jobs,title_job_wells to authenticated;
 set role authenticated; set request.jwt.claim.sub='${owner}';`);
 const run={original_input:'4216502733',normalized_input:'4216502733',resolved_primary_api:'4216502733',status:'pending',title_research_job_id:title};
 const entity={entity_type:'wellbore',canonical_identifier:'4216502733'};
 const call=(r=run,e=[entity])=>db.query('select create_due_diligence_run($1::jsonb,$2::jsonb) as result',[JSON.stringify(r),JSON.stringify(e)]);
 const {id}= (await call()).rows[0].result;
 assert.equal((await db.query('select title_research_job_id from trrc_due_diligence_runs where id=$1',[id])).rows[0].title_research_job_id,title);
 assert.equal((await db.query('select count(*)::int n from trrc_resolved_entities where run_id=$1',[id])).rows[0].n,1);
 // Force the second insert to fail after the run insert. Entire call must roll back.
 await assert.rejects(call(run,[{}]),/null value/);
 assert.equal((await db.query('select count(*)::int n from trrc_due_diligence_runs')).rows[0].n,1);
 await assert.rejects(call({...run,normalized_input:'4216500004'}),/Title link must/);
 await assert.rejects(call({...run,status:'complete'}),/Invalid initial/);
 await assert.rejects(call(run,{}),/Entity inputs/);
 // Caller-supplied account ownership is ignored; auth.uid is authoritative.
 await call({...run,user_id:other,title_setup_warning:'Multiple title scopes'},[]);
 assert.equal((await db.query('select count(*)::int n from trrc_due_diligence_runs where user_id=$1',[owner])).rows[0].n,2);
 await db.exec(`set request.jwt.claim.sub='${other}'`);
 assert.equal((await db.query('select count(*)::int n from trrc_due_diligence_runs')).rows[0].n,0);
 await assert.rejects(call(),/Title link must/);
 await db.exec("set request.jwt.claim.sub=''");
 await assert.rejects(call(),/Authentication required/);
 await db.exec('reset role; set role anon');
 await assert.rejects(call(),/permission denied/);
 console.log('PASS: atomic entity rollback, linked scope, ownership isolation, input validation, authenticated identity and anonymous denial. Production sessions not exercised.');
} finally {await db.close();}
