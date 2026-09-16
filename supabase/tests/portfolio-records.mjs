/** Isolated PostgreSQL policy test. Usage: node supabase/tests/portfolio-records.mjs /path/to/pglite/dist/index.js */
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const {PGlite}=await import(process.argv[2]?pathToFileURL(process.argv[2]).href:'@electric-sql/pglite');
const db=new PGlite();
try {
 await db.exec(`create role authenticated; create role anon; create schema auth;
 create table auth.users(id uuid primary key);
 create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth to authenticated;
 insert into auth.users values ('00000000-0000-4000-8000-000000000001'),('00000000-0000-4000-8000-000000000002');`);
 await db.exec(readFileSync(new URL('../migrations/034_portfolio_evidence_records.sql',import.meta.url),'utf8'));
 await db.exec(`set role authenticated; set request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
 insert into trrc_portfolio_records(user_id,input_json,record_json) values(auth.uid(),'{}','{}');`);
 assert.equal((await db.query('select count(*)::int as n from trrc_portfolio_records')).rows[0].n,1);
 await assert.rejects(db.exec("insert into trrc_portfolio_records(user_id,input_json,record_json) values('00000000-0000-4000-8000-000000000002','{}','{}')"),/row-level security/);
 await assert.rejects(db.exec("update trrc_portfolio_records set record_json='{}'"),/permission denied/);
 await assert.rejects(db.exec("delete from trrc_portfolio_records"),/permission denied/);
 await db.exec("set request.jwt.claim.sub='00000000-0000-4000-8000-000000000002'");
 assert.equal((await db.query('select count(*)::int as n from trrc_portfolio_records')).rows[0].n,0);
 await db.exec('reset role; set role anon');
 await assert.rejects(db.exec('select * from trrc_portfolio_records'),/permission denied/);
 console.log('PASS: owner insert/read, cross-account insert/read rejection, immutable snapshots and anonymous rejection in isolated PostgreSQL. Production auth not exercised.');
} finally {await db.close();}
