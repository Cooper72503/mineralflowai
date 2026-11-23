import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
const owner = "00000000-0000-4000-8000-000000000001",
  other = "00000000-0000-4000-8000-000000000002",
  key = "00000000-0000-4000-8000-000000000003";
try {
  await db.exec(`create role authenticated;create role anon;create role service_role bypassrls;create schema auth;
 create table auth.users(id uuid primary key);insert into auth.users values('${owner}'),('${other}');
 create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth to authenticated,service_role;`);
  await db.exec(
    readFileSync(
      new URL("../migrations/044_mineral_finder.sql", import.meta.url),
      "utf8",
    ),
  );
  const realResult = process.argv[3]
    ? JSON.parse(readFileSync(process.argv[3], "utf8"))
    : null;
  const request = {
    query: "Find historical wells in Gaines",
    criteria: realResult?.criteria ?? {
      county: "GAINES",
      beforeYear: 1995,
      radiusMiles: 3,
      limit: 25,
      statuses: ["plugged"],
      marginalBopd: null,
    },
  };
  await db.exec(`set role authenticated;set request.jwt.claim.sub='${owner}'`);
  const enqueue = async (k = key, r = request) =>
    (
      await db.query("select enqueue_mineral_finder($1,$2::jsonb) id", [
        k,
        JSON.stringify(r),
      ])
    ).rows[0].id;
  const id = await enqueue();
  assert.equal(await enqueue(), id);
  await assert.rejects(
    enqueue(key, { ...request, query: "changed" }),
    /different criteria/,
  );
  await assert.rejects(
    db.exec("update mineral_finder_jobs set status='complete'"),
    /permission denied/,
  );
  await assert.rejects(
    db.exec("select * from mineral_finder_snapshots"),
    /permission denied/,
  );
  await assert.rejects(
    db.exec("select * from claim_mineral_finder()"),
    /permission denied/,
  );
  await db.exec(`set request.jwt.claim.sub='${other}'`);
  assert.equal(
    (await db.query("select * from mineral_finder_jobs")).rows.length,
    0,
  );
  await db.exec(
    `reset role;set role service_role;set request.jwt.claim.sub=''`,
  );
  const claim = (await db.query("select * from claim_mineral_finder()"))
    .rows[0];
  assert.equal(claim.id, id);
  assert.equal(claim.attempts, 1);
  assert.equal(
    (await db.query("select * from claim_mineral_finder()")).rows.length,
    0,
  );
  const result = realResult ?? {
    version: "mineral-finder-v1",
    classification: "research_screening",
    prospects: [],
  };
  await assert.rejects(
    db.query("select finish_mineral_finder($1,$2,$3::jsonb)", [
      id,
      claim.claim_token,
      "{}",
    ]),
    /Invalid research/,
  );
  assert.equal(
    (
      await db.query("select finish_mineral_finder($1,$2,$3::jsonb) saved", [
        id,
        other,
        JSON.stringify(result),
      ])
    ).rows[0].saved,
    false,
  );
  await db.exec(
    `update mineral_finder_jobs set lease_until=now()-interval '1 minute' where id='${id}'`,
  );
  assert.equal(
    (
      await db.query("select finish_mineral_finder($1,$2,$3::jsonb) saved", [
        id,
        claim.claim_token,
        JSON.stringify(result),
      ])
    ).rows[0].saved,
    false,
  );
  const recovered = (await db.query("select * from claim_mineral_finder()"))
    .rows[0];
  assert.equal(recovered.attempts, 2);
  assert.notEqual(recovered.claim_token, claim.claim_token);
  assert.equal(
    (
      await db.query("select finish_mineral_finder($1,$2,$3::jsonb) saved", [
        id,
        recovered.claim_token,
        JSON.stringify(result),
      ])
    ).rows[0].saved,
    true,
  );
  await db.exec(
    `reset role;set role authenticated;set request.jwt.claim.sub='${owner}'`,
  );
  assert.equal(
    (await db.query("select status from mineral_finder_jobs")).rows[0].status,
    "complete",
  );
  assert.deepEqual(
    (await db.query("select result_json from mineral_finder_jobs")).rows[0]
      .result_json,
    result,
  );
  await enqueue("00000000-0000-4000-8000-000000000011");
  await enqueue("00000000-0000-4000-8000-000000000012");
  await assert.rejects(
    enqueue("00000000-0000-4000-8000-000000000013"),
    /already active/,
  );
  await db.exec(
    `reset role;set role service_role;set request.jwt.claim.sub=''`,
  );
  await assert.rejects(
    enqueue("00000000-0000-4000-8000-000000000014"),
    /permission denied|Authentication/,
  );
  console.log(
    "PASS: migration 044; RLS/account isolation, idempotency, conflicts, active-run bound, write restrictions, service-only claim, stale fencing and recovery, result validation and publication.",
  );
} finally {
  await db.close();
}
