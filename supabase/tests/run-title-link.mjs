/** Usage: node supabase/tests/run-title-link.mjs /absolute/path/to/pglite/dist/index.js
 * Isolated migration test; deliberately does not claim production RLS coverage.
 */
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const {PGlite}=await import(process.argv[2]?pathToFileURL(process.argv[2]).href:'@electric-sql/pglite');
const db=new PGlite();
try {
  await db.exec(`create table title_research_jobs(id uuid primary key,user_id uuid);
    create table title_job_wells(job_id uuid,user_id uuid,api10 text);
    create table trrc_due_diligence_runs(id uuid primary key,user_id uuid,normalized_input text,resolved_primary_api text);`);
  await db.exec(readFileSync(new URL('../migrations/033_run_title_link.sql',import.meta.url),'utf8'));
  await db.exec(readFileSync(new URL('./run_title_link.sql',import.meta.url),'utf8'));
  console.log('PASS: title link migration, account/API rejection and link retention. Production RLS not exercised.');
} finally { await db.close(); }
