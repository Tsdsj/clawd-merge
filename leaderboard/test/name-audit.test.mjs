import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createD1 } from "./d1-mock.mjs";
const root = new URL("../../", import.meta.url);
function temporary(t) {
  const dir = mkdtempSync(join(tmpdir(), "clawd-name-audit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const hash = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

test("name audit accepts pre-migration DB read-only and emits counts/rule IDs, never names or IDs", (t) => {
  const dir = temporary(t),
    path = join(dir, "fixture.sqlite");
  const db = createD1(path, { upTo: 4 });
  for (const [id, name] of [
    ["PRIVATE_PLAYER_ID", "傻逼"],
    ["OTHER_PRIVATE_ID", "王伟"],
  ])
    db.raw
      .prepare(
        "INSERT INTO players(id,name,name_key,token_hash,created_at) VALUES (?,?,?,?,1)",
      )
      .run(id, name, id, id);
  db.raw.close();
  const before = hash(path);
  const r = spawnSync(
    process.execPath,
    [
      new URL("../ops/name-audit.mjs", import.meta.url).pathname,
      "--sqlite",
      path,
    ],
    { encoding: "utf8", env: { ...process.env, BLOCKED_WORDS: "" } },
  );
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.scanned, 2);
  assert.equal(report.masked, 1);
  assert.equal(report.allowed, 1);
  assert.equal(report.missingAliases, 1);
  for (const secret of [
    "PRIVATE_PLAYER_ID",
    "OTHER_PRIVATE_ID",
    "傻逼",
    "王伟",
    path,
  ])
    assert.ok(!r.stdout.includes(secret));
  assert.equal(hash(path), before);
});

for (const mode of ["missing", "corrupt"])
  test(`${mode} deployed word data rejects new names but keeps existing play/auth available`, (t) => {
    const dir = temporary(t);
    mkdirSync(join(dir, "leaderboard/src"), { recursive: true });
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "package.json"), '{"type":"module"}');
    for (const file of ["index.js", "challenges.js", "name-policy.js"])
      copyFileSync(
        new URL("leaderboard/src/" + file, root),
        join(dir, "leaderboard/src", file),
      );
    copyFileSync(new URL("src/rules.js", root), join(dir, "src/rules.js"));
    if (mode === "corrupt") {
      mkdirSync(join(dir, "leaderboard/data"));
      const data = readFileSync(
        new URL("leaderboard/data/name-policy-v1.js", root),
        "utf8",
      ).replace("2026-10-04.1", "tampered");
      writeFileSync(join(dir, "leaderboard/data/name-policy-v1.js"), data);
    }
    const code = `import worker from './leaderboard/src/index.js';import {createD1} from ${JSON.stringify(new URL("./d1-mock.mjs", import.meta.url).href)};import {createHash} from 'node:crypto';
 const DB=createD1();const env={DB,ALLOWED_ORIGINS:'*'};const token='isolated-old-token';const h=createHash('sha256').update(token).digest('hex');
 DB.raw.prepare('INSERT INTO players(id,name,name_key,token_hash,created_at) VALUES (?,?,?,?,1)').run('a','PRIVATE_OLD_NAME','a',h);DB.raw.prepare('INSERT INTO tokens(token_hash,player_id,created_at) VALUES (?,?,1)').run(h,'a');
 const call=async(path,body)=>{const r=await worker.fetch(new Request('https://game.example.test'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:body?JSON.stringify(body):undefined}),env);return {status:r.status,data:await r.json()};};
 const result={register:await call('/api/register',{name:'普通玩家'}),me:await call('/api/me'),session:await call('/api/session',{})};result.score=await call('/api/score',{sessionId:result.session.data.sessionId,score:1,drops:1,maxLevel:1});console.log(JSON.stringify(result));DB.raw.close();`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    const result = JSON.parse(r.stdout);
    assert.equal(result.register.status, 503);
    assert.equal(result.register.data.error, "name_policy_unavailable");
    assert.equal(result.me.status, 200);
    assert.match(result.me.data.player.name, /^玩家·\d+$/u);
    assert.equal(result.session.status, 200);
    assert.equal(result.score.status, 200);
    assert.ok(!r.stdout.includes("PRIVATE_OLD_NAME"));
  });
