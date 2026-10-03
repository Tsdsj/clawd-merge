import test from "node:test";
import assert from "node:assert/strict";
import { createD1 } from "./d1-mock.mjs";
import {
  collectReport,
  compareReports,
  cleanupStatements,
  renderMarkdown,
} from "../ops/report.mjs";
const from = Date.parse("2026-10-01T00:00:00+08:00"),
  to = from + 86400000,
  asOf = to + 86400000;
const options = { from, to, asOf, source: "fixture" };
const query = (db) => async (sql) => ({ rows: db.raw.prepare(sql).all() });
function player(db, id) {
  db.raw
    .prepare(
      "INSERT INTO players(id,name,name_key,token_hash,created_at) VALUES(?,?,?,?,?)",
    )
    .run(id, "PRIVATE-NAME", id, `SECRET-${id}`, from);
}
function daily(db, id, p, start, accepted = null) {
  db.raw
    .prepare("INSERT INTO challenge_sessions VALUES(?,?,?,?,?,?,?,?,?)")
    .run(
      id,
      `request-${id}`,
      "2026-10-01",
      "daily-1",
      p,
      1,
      start,
      to + 600000,
      accepted === null ? 0 : 1,
    );
  if (accepted !== null)
    db.raw
      .prepare(
        "INSERT INTO challenge_scores VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        `attempt-${id}`,
        "2026-10-01",
        "daily-1",
        p,
        0,
        100,
        1,
        0,
        8000,
        "limit",
        accepted - start,
        accepted,
        0,
        0,
        null,
      );
}
test("empty migrated DB reports observed zero, unavailable metrics remain unknown", async () => {
  const db = createD1();
  try {
    const r = await collectReport(query(db), options);
    assert.equal(r.classic.accepted, 0);
    assert.equal(r.daily.issued, 0);
    assert.equal(r.daily.cohortAcceptedRatio, null);
    assert.equal(r.unknown.uploadSuccessRate, null);
    assert.equal(r.unknown.retention, null);
    assert.equal(r.storage.tables.score_receipts, 0);
    assert.match(renderMarkdown(r), /未知/);
  } finally {
    db.raw.close();
  }
});
test("M1 database without daily migration reports daily unavailable rather than zero", async () => {
  const db = createD1(":memory:", { upTo: 3 });
  try {
    const r = await collectReport(query(db), options);
    assert.equal(r.daily, null);
    assert.match(r.warnings.join(" "), /每日挑战/);
  } finally {
    db.raw.close();
  }
});
test("accepted records and start cohort count once; zero scores count, dates use Shanghai, late results explicit", async () => {
  const db = createD1();
  try {
    player(db, "a");
    player(db, "b");
    daily(db, "d1", "a", from + 1000, from + 9000);
    daily(db, "d2", "a", from + 2000, to + 5000);
    daily(db, "d3", "b", from + 3000);
    daily(db, "outside", "b", to + 1000, to + 2000);
    db.raw
      .prepare(
        "INSERT INTO scores(player_id,score,max_level,drops,duration_ms,created_at) VALUES(?,?,?,?,?,?)",
      )
      .run("a", 0, 1, 1, 1000, from + 1000);
    const r = await collectReport(query(db), options);
    assert.equal(r.daily.issued, 3);
    assert.equal(r.daily.accepted, 1);
    assert.equal(r.daily.zeroScores, 1);
    assert.equal(r.daily.cohortAccepted, 2);
    assert.equal(r.daily.cohortAcceptedRatio, 2 / 3);
    assert.equal(r.daily.startPlayers, 2);
    assert.equal(r.observed.acceptedPlayers, 1);
    assert.equal(r.observed.repeatAcceptedPlayers, 1);
    assert.equal(r.classic.accepted, 1);
    assert.equal(r.daily.byDate[0].day, "2026-10-01");
    const serialized = JSON.stringify(r);
    assert.equal(serialized.includes("PRIVATE-NAME"), false);
    assert.equal(serialized.includes("SECRET-"), false);
    const replay = await collectReport(query(db), options);
    assert.equal(replay.daily.issued, 3);
    assert.equal(replay.daily.accepted, 1);
  } finally {
    db.raw.close();
  }
});
test("cleanup preview is read-only, bounded deletes retain active state, receipts, challenge ledger and quota", async () => {
  const db = createD1();
  try {
    player(db, "a");
    daily(db, "daily", "a", from, from + 8000);
    for (const [key, time] of [
      ["expired", from],
      ["active", asOf],
    ]) {
      db.raw
        .prepare("INSERT INTO oauth_states(state_hash,merge_player_id,return_to,created_at) VALUES(?,?,?,?)")
        .run(key, null, "https://example.test", time);
      db.raw
        .prepare("INSERT INTO login_codes(code_hash,player_id,created_at) VALUES(?,?,?)")
        .run(key, "a", time);
      db.raw.prepare("INSERT INTO rate_limits VALUES(?,?,?)").run(key, time, 1);
    }
    db.raw
      .prepare("INSERT INTO sessions VALUES(?,?,?,?)")
      .run("old-unused", "a", from - 86400000, 0);
    db.raw
      .prepare("INSERT INTO sessions VALUES(?,?,?,?)")
      .run("active", "a", asOf, 0);
    db.raw
      .prepare("INSERT INTO score_receipts VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run("accepted", "a", "attempt", 100, 10, 1, 10000, from, 1, 100, 1);
    db.raw
      .prepare("INSERT INTO sessions VALUES(?,?,?,?)")
      .run("accepted", "a", from, 1);
    const r = await collectReport(query(db), options);
    assert.equal(r.cleanup.oauth_states, 1);
    assert.equal(
      db.raw.prepare("SELECT COUNT(*) n FROM oauth_states").get().n,
      2,
    );
    for (const s of cleanupStatements(r)) db.raw.exec(s.sql);
    assert.equal(
      db.raw.prepare("SELECT COUNT(*) n FROM oauth_states").get().n,
      1,
    );
    assert.equal(
      db.raw.prepare("SELECT COUNT(*) n FROM login_codes").get().n,
      1,
    );
    assert.equal(
      db.raw.prepare("SELECT COUNT(*) n FROM rate_limits").get().n,
      1,
    );
    assert.equal(db.raw.prepare("SELECT COUNT(*) n FROM sessions").get().n, 1);
    assert.equal(
      db.raw.prepare("SELECT COUNT(*) n FROM score_receipts").get().n,
      1,
    );
    assert.equal(
      db.raw.prepare("SELECT COUNT(*) n FROM challenge_scores").get().n,
      1,
    );
    assert.equal(
      db.raw.prepare("SELECT COUNT(*) n FROM challenge_sessions").get().n,
      1,
    );
    assert.ok(cleanupStatements(r).every((s) => s.sql.includes("LIMIT 500")));
  } finally {
    db.raw.close();
  }
});
test("snapshot comparison rejects mismatched sources and reports row deltas without claiming growth rate from one sample", async () => {
  const db = createD1();
  try {
    const a = await collectReport(query(db), options);
    assert.equal(compareReports(a, null), null);
    player(db, "a");
    const b = await collectReport(query(db), { ...options, asOf: asOf + 1000 });
    assert.equal(compareReports(b, a).tables.players, 1);
    assert.throws(() => compareReports(b, { ...a, source: "other" }));
    assert.ok(b.queryPlans.classic.some((s) => s.includes("idx_players_best")));
    assert.ok(b.queryPlans.daily.some((s) => s.includes("idx_challenge_rank")));
  } finally {
    db.raw.close();
  }
});

test("cleanup applies at most 500 expired rows and never purges a live credential", async () => {
  const db = createD1();
  try {
    const ins = db.raw.prepare("INSERT INTO login_codes(code_hash,player_id,created_at) VALUES(?,?,?)");
    for (let i = 0; i < 503; i++) ins.run(`expired-${i}`, "p", from);
    ins.run("live", "p", asOf);
    const report = await collectReport(query(db), options);
    db.raw.exec(
      cleanupStatements(report).find((s) => s.table === "login_codes").sql,
    );
    assert.equal(
      db.raw.prepare("SELECT COUNT(*) n FROM login_codes").get().n,
      4,
    );
    assert.equal(
      db.raw
        .prepare("SELECT COUNT(*) n FROM login_codes WHERE code_hash='live'")
        .get().n,
      1,
    );
  } finally {
    db.raw.close();
  }
});
test("report query failure is an error, not a report full of zeros", async () => {
  await assert.rejects(
    () =>
      collectReport(async () => {
        throw new Error("database unavailable");
      }, options),
    /database unavailable/,
  );
  for (const bad of [
    { ...options, to: from },
    { ...options, to: asOf + 1 },
    { ...options, from: NaN },
  ])
    await assert.rejects(
      () => collectReport(async () => ({ rows: [] }), bad),
      /invalid_report_window/,
    );
});

test("CLI opens SQLite read-only, produces review-only files and refuses overwrite", async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "clawd-ops-test-")),
    file = join(dir, "fixture.sqlite"),
    out = join(dir, "report");
  try {
    const db = createD1(file);
    db.raw.close();
    const before = readFileSync(file);
    const args = [
      "leaderboard/ops/run.mjs",
      "--sqlite",
      file,
      "--out",
      out,
      "--source",
      "test",
      "--from",
      "2026-10-01",
      "--to",
      "2026-10-02",
      "--as-of",
      "2026-10-03T00:00:00+08:00",
    ];
    const run = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(readFileSync(file), before);
    const r = JSON.parse(readFileSync(out + ".json", "utf8"));
    assert.equal(r.daily.issued, 0);
    assert.equal(r.storage.localLogicalBytes > 0, true);
    assert.match(readFileSync(out + ".cleanup.sql", "utf8"), /REVIEW ONLY/);
    const again = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(again.status, 1);
    assert.match(again.stderr, /输出已存在/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A04 auth maintenance is preview-only, redacts expired receipts and retains live sessions/recovery codes',async()=>{
 const db=createD1();try{
  player(db,'a');const now=asOf;
  db.raw.prepare("INSERT INTO tokens(token_hash,player_id,created_at,auth_method,auth_version,authenticated_at,expires_at) VALUES ('expired-auth','a',1,'password',0,1,?)").run(now-1);
  db.raw.prepare("INSERT INTO tokens(token_hash,player_id,created_at,auth_method,auth_version,authenticated_at,expires_at) VALUES ('live-auth','a',1,'password',0,1,?)").run(now+600000);
  db.raw.prepare("INSERT INTO recovery_codes VALUES('a',?,1,1)").run('a'.repeat(64));
  const insert=db.raw.prepare("INSERT INTO auth_operations(request_id,actor_scope,action,retry_secret_hash,status,created_at,expires_at,response_ciphertext,nonce,key_version,login_handle) VALUES (?,'private-actor','register',?,'complete',1,?,'private-ciphertext','nonce','v1','private-handle')");
  insert.run('expired-op','b'.repeat(64),now-1);insert.run('live-op','c'.repeat(64),now+600000);
  const report=await collectReport(query(db),options);assert.equal(report.cleanup.auth_operations_redact,1);assert.equal(report.cleanup.tokens,1);
  assert.equal(db.raw.prepare("SELECT response_ciphertext FROM auth_operations WHERE request_id='expired-op'").get().response_ciphertext,'private-ciphertext');
  const generated=cleanupStatements(report);for(const statement of generated)db.raw.exec(statement.sql);
  assert.ok(db.raw.prepare("SELECT token_hash FROM tokens WHERE token_hash='live-auth'").get());assert.equal(db.raw.prepare("SELECT token_hash FROM tokens WHERE token_hash='expired-auth'").get(),undefined);
  const expired=db.raw.prepare("SELECT * FROM auth_operations WHERE request_id='expired-op'").get();assert.equal(expired.status,'stale');assert.equal(expired.response_ciphertext,null);assert.equal(expired.login_handle,null);
  assert.equal(db.raw.prepare("SELECT response_ciphertext FROM auth_operations WHERE request_id='live-op'").get().response_ciphertext,'private-ciphertext');assert.equal(db.raw.prepare('SELECT count(*) n FROM recovery_codes').get().n,1);
  const serialized=JSON.stringify(report);for(const value of ['private-actor','private-ciphertext','private-handle'])assert.ok(!serialized.includes(value));
 }finally{db.raw.close();}
});

test('A05 maintenance previews then removes expired encrypted OAuth flows and redacts browser binding metadata',async()=>{
 const db=createD1();try{
  for(const [id,expires]of [['expired-oauth',asOf-1],['live-oauth',asOf+600000]]){
   db.raw.prepare("INSERT INTO auth_operations(request_id,actor_scope,action,retry_secret_hash,created_at,expires_at,oauth_action,oauth_purpose,client_nonce_hash,recovery_method) VALUES(?,'fixture-scope','exchange_login',?,1,?,'reauth','recover_password',?,'linuxdo')").run(id,'b'.repeat(64),expires,'private-client-hash');
   db.raw.prepare('INSERT INTO oauth_account_flows(state_hash,operation_id,return_to,expires_at,start_cipher,start_nonce) VALUES(?,?,?,?,?,?)').run((id.startsWith('expired')?'a':'b').repeat(64),id,'https://private.example.invalid/',expires,'private-encrypted-context','private-nonce');
  }
  const r=await collectReport(query(db),options);assert.equal(r.cleanup.oauth_account_flows,1);assert.equal(db.raw.prepare('SELECT count(*) n FROM oauth_account_flows').get().n,2);
  const publicReport=JSON.stringify(r);for(const value of ['private-client-hash','private-encrypted-context','private.example.invalid'])assert.ok(!publicReport.includes(value));
  for(const s of cleanupStatements(r))db.raw.exec(s.sql);
  assert.equal(db.raw.prepare('SELECT count(*) n FROM oauth_account_flows').get().n,1);
  const expired=db.raw.prepare("SELECT client_nonce_hash,oauth_action,oauth_purpose,recovery_method FROM auth_operations WHERE request_id='expired-oauth'").get();assert.ok(Object.values(expired).every(v=>v===null));
  assert.equal(db.raw.prepare("SELECT client_nonce_hash FROM auth_operations WHERE request_id='live-oauth'").get().client_nonce_hash,'private-client-hash');
 }finally{db.raw.close();}
});
