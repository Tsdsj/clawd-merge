import test from "node:test";
import assert from "node:assert/strict";
import { createD1 } from "./d1-mock.mjs";
import { openDatabase } from "../../server/sqlite.mjs";
import {
  mkdtempSync,
  rmSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const DAYS30 = 30 * 86400000;
function seed(db) {
  db.raw
    .exec(`INSERT INTO players(id,name,name_key,tag,token_hash,created_at,best_score,best_level,best_at,games) VALUES ('guest','老玩家','老玩家#1234','1234','guest-token',1,250,6,2,7);
 INSERT INTO players(id,name,name_key,linuxdo_id,token_hash,created_at) VALUES ('external','旧身份','ld:42',42,'external-token',1);
 INSERT INTO tokens VALUES ('guest-token','guest',1),('external-token','external',1);
 INSERT INTO sessions VALUES ('classic-session','guest',10,0);
 INSERT INTO scores VALUES (1,'guest',250,6,10,20000,30);
 INSERT INTO score_receipts VALUES ('classic-session','guest','attempt',250,10,6,20000,30,1,250,1);
 INSERT INTO challenge_definitions VALUES ('day','rules',1,100,200,100,1);
 INSERT INTO challenge_allowances VALUES ('day','guest',2);
 INSERT INTO challenge_sessions VALUES ('daily-session','request','day','rules','guest',2,10,200,0);
 INSERT INTO challenge_bests VALUES ('day','guest',80,5,20);
 INSERT INTO challenge_scores VALUES ('accepted-daily','daily-attempt','day','rules','guest',80,10,5,0,0,'danger',10000,20,1,80,1);
 INSERT INTO oauth_states VALUES ('state','guest','https://game.example.test/',1);
 INSERT INTO login_codes VALUES ('code','external',1);`);
}
const plain = (row) => JSON.parse(JSON.stringify(row));
test("0004 -> 0005 keeps every legacy column, ID, token and both game modes", (t) => {
  const db = createD1(":memory:", { upTo: 4 });
  t.after(() => db.raw.close());
  seed(db);
  const tables = [
    "players",
    "tokens",
    "sessions",
    "scores",
    "score_receipts",
    "challenge_definitions",
    "challenge_allowances",
    "challenge_sessions",
    "challenge_bests",
    "challenge_scores",
    "oauth_states",
    "login_codes",
  ];
  const before = Object.fromEntries(
    tables.map((table) => [
      table,
      plain(db.raw.prepare(`SELECT * FROM ${table}`).all()),
    ]),
  );
  const start = Date.now();
  db.migrate();
  assert.ok(
    db.raw
      .prepare("PRAGMA table_info(players)")
      .all()
      .some((x) => x.name === "auth_version"),
    "new schema must extend players",
  );
  for (const table of tables) {
    const rows = plain(db.raw.prepare(`SELECT * FROM ${table}`).all());
    assert.equal(rows.length, before[table].length, table);
    for (let i = 0; i < rows.length; i++)
      for (const [key, value] of Object.entries(before[table][i]))
        assert.deepEqual(rows[i][key], value, table + "." + key);
  }
  const guest = db.raw
    .prepare("SELECT * FROM tokens WHERE player_id='guest'")
    .get();
  const ld = db.raw
    .prepare("SELECT * FROM tokens WHERE player_id='external'")
    .get();
  assert.equal(guest.expires_at, null);
  assert.equal(guest.auth_method, "guest");
  assert.equal(ld.auth_method, "linuxdo");
  assert.ok(ld.expires_at >= start + DAYS30 - 1000);
  assert.ok(ld.expires_at <= Date.now() + DAYS30);
  assert.equal(
    db.raw.prepare("SELECT count(*) n FROM password_credentials").get().n,
    0,
  );
});
test("safe aliases are stable, unique, transactional and never reuse deleted allocations", (t) => {
  const db = createD1();
  t.after(() => db.raw.close());
  const insert = db.raw.prepare(
    "INSERT INTO players(id,name,name_key,token_hash,created_at) VALUES (?,?,?,?,1)",
  );
  insert.run("a", "某人", "a", "a");
  insert.run("b", "某人", "b", "b");
  const cols = db.raw.prepare("PRAGMA table_info(players)").all();
  assert.ok(
    cols.some((x) => x.name === "public_alias"),
    "alias allocation must exist",
  );
  const a = db.raw
    .prepare("SELECT public_alias FROM players WHERE id='a'")
    .get().public_alias;
  const b = db.raw
    .prepare("SELECT public_alias FROM players WHERE id='b'")
    .get().public_alias;
  assert.match(a, /^玩家·\d+$/u);
  assert.notEqual(a, b);
  db.raw.exec("UPDATE players SET name='改名' WHERE id='a'");
  assert.equal(
    db.raw.prepare("SELECT public_alias FROM players WHERE id='a'").get()
      .public_alias,
    a,
  );
  db.raw.exec("DELETE FROM players WHERE id='b'");
  insert.run("c", "某人", "c", "c");
  assert.notEqual(
    db.raw.prepare("SELECT public_alias FROM players WHERE id='c'").get()
      .public_alias,
    b,
  );
});
test("production migrator upgrades exported 0004 history once and preserves tokens across reopen", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "clawd-a03-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "isolated.sqlite");
  const old = createD1(path, { upTo: 4 });
  seed(old);
  old.raw.exec("CREATE TABLE d1_migrations(name TEXT PRIMARY KEY)");
  for (const f of readdirSync(
    new URL("../migrations/", import.meta.url),
  ).filter((x) => /^000[1-4]_/.test(x)))
    old.raw.prepare("INSERT INTO d1_migrations VALUES (?)").run(f);
  old.raw.close();
  let db = openDatabase(path);
  assert.equal(
    db.raw.prepare("SELECT count(*) n FROM app_migrations").get().n,
    readdirSync(new URL('../migrations/',import.meta.url)).filter(x=>x.endsWith('.sql')).length,
  );
  const before = plain(
    db.raw.prepare("SELECT * FROM tokens ORDER BY token_hash").all(),
  );
  db.close();
  db = openDatabase(path);
  assert.deepEqual(
    plain(db.raw.prepare("SELECT * FROM tokens ORDER BY token_hash").all()),
    before,
  );
  db.close();
});

test("0001 legacy player upgrades without changing identity, original bearer hash or classic record", (t) => {
  const db = createD1(":memory:", { upTo: 1 });
  t.after(() => db.raw.close());
  db.raw.exec(
    "INSERT INTO players VALUES ('legacy','老名字','老名字','old-hash',300,7,10,8,1); INSERT INTO sessions VALUES ('old-game','legacy',4,0); INSERT INTO scores VALUES (1,'legacy',300,7,20,40000,10);",
  );
  db.migrate();
  const p = db.raw.prepare("SELECT * FROM players WHERE id='legacy'").get();
  assert.equal(p.token_hash, "old-hash");
  assert.equal(p.best_score, 300);
  assert.equal(p.games, 8);
  assert.match(p.tag, /^\d{4}$/);
  assert.equal(p.auth_version, 0);
  assert.equal(
    db.raw
      .prepare("SELECT player_id FROM tokens WHERE token_hash='old-hash'")
      .get().player_id,
    "legacy",
  );
  assert.equal(
    db.raw.prepare("SELECT player_id FROM sessions WHERE id='old-game'").get()
      .player_id,
    "legacy",
  );
});

test("credential ownership, normalized handle uniqueness and reservation exclusion are enforced by SQLite", (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  for (const id of ["a", "b", "c"])
    db.raw
      .prepare(
        "INSERT INTO players(id,name,name_key,token_hash,created_at) VALUES(?,?,?,?,1)",
      )
      .run(id, "玩家", id, id);
  const credential = db.raw.prepare(
    "INSERT INTO password_credentials VALUES (?,?,?,?,?,?,?,?)",
  );
  const put = (id, handle, key) =>
    credential.run(
      id,
      handle,
      key,
      "scrypt",
      "s".repeat(22),
      "d".repeat(43),
      1,
      1,
    );
  put("a", "Alice#4821", "alice#4821");
  assert.throws(() => put("b", "ALICE#4821", "alice#4821"), /UNIQUE/);
  assert.throws(() => put("a", "other#4821", "other#4821"), /UNIQUE/);
  assert.throws(() => put("missing", "miss#4821", "miss#4821"), /FOREIGN KEY/);
  const op = db.raw.prepare(
    "INSERT INTO auth_operations(request_id,actor_scope,action,retry_secret_hash,created_at,expires_at) VALUES(?,?,?,?,?,?)",
  );
  op.run("op", "guest:b", "register", "a".repeat(64), 1, 100);
  const reserve = db.raw.prepare(
    "INSERT INTO login_handle_reservations VALUES(?,?,?,?)",
  );
  assert.throws(
    () => reserve.run("op", "ALICE#4821", "alice#4821", 100),
    /login_handle_conflict/,
  );
  reserve.run("op", "Bee#4821", "bee#4821", 100);
  assert.throws(
    () => put("b", "Bee#4821", "bee#4821"),
    /login_handle_reserved/,
  );
  assert.throws(
    () =>
      db.raw
        .prepare(
          "UPDATE password_credentials SET login_handle_key='bee#4821' WHERE player_id='a'",
        )
        .run(),
    /login_handle_reserved/,
  );
  assert.throws(
    () =>
      db.raw
        .prepare(
          "UPDATE login_handle_reservations SET login_handle_key='alice#4821' WHERE operation_id='op'",
        )
        .run(),
    /login_handle_conflict/,
  );
  db.raw.exec("BEGIN IMMEDIATE");
  db.raw.exec("DELETE FROM login_handle_reservations WHERE operation_id='op'");
  put("b", "Bee#4821", "bee#4821");
  db.raw.exec("ROLLBACK");
  assert.ok(
    db.raw
      .prepare(
        "SELECT * FROM login_handle_reservations WHERE operation_id='op'",
      )
      .get(),
  );
  assert.equal(
    db.raw
      .prepare("SELECT * FROM password_credentials WHERE player_id='b'")
      .get(),
    undefined,
  );
  db.raw.exec(
    "UPDATE players SET name='新昵称',name_key='new#1234',tag='1234' WHERE id='a'",
  );
  assert.equal(
    db.raw
      .prepare(
        "SELECT login_handle FROM password_credentials WHERE player_id='a'",
      )
      .get().login_handle,
    "Alice#4821",
  );
});

test("one recovery code per player, scoped grants and encrypted-completion shape constrain future auth writes", (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  db.raw.exec(
    "INSERT INTO players(id,name,name_key,token_hash,created_at) VALUES ('a','玩家','a','token-a',1); INSERT INTO tokens(token_hash,player_id,created_at) VALUES ('token-a','a',1);",
  );
  const recovery = db.raw.prepare(
    "INSERT INTO recovery_codes(player_id,code_hash,created_at) VALUES(?,?,1)",
  );
  recovery.run("a", "a".repeat(64));
  assert.throws(() => recovery.run("a", "b".repeat(64)), /UNIQUE/);
  const grant = db.raw.prepare("INSERT INTO reauth_grants VALUES(?,?,?,?,?,?)");
  grant.run("c".repeat(64), "a", "token-a", 0, "bind_linuxdo", 100);
  db.raw.exec(
    "INSERT INTO players(id,name,name_key,token_hash,created_at) VALUES ('b','玩家','b','token-b',1); INSERT INTO tokens(token_hash,player_id,created_at) VALUES ('token-b','b',1);",
  );
  assert.throws(
    () => grant.run("e".repeat(64), "a", "token-b", 0, "bind_linuxdo", 100),
    /FOREIGN KEY/,
  );
  assert.throws(
    () => grant.run("d".repeat(64), "a", "token-a", 0, "anything", 100),
    /CHECK/,
  );
  db.raw.exec("DELETE FROM tokens WHERE token_hash='token-a'");
  assert.equal(
    db.raw.prepare("SELECT count(*) n FROM reauth_grants").get().n,
    0,
  );
  assert.throws(
    () =>
      db.raw
        .prepare(
          "INSERT INTO auth_operations(request_id,actor_scope,action,retry_secret_hash,status,created_at,expires_at) VALUES ('op','a','register',?,'complete',1,2)",
        )
        .run("e".repeat(64)),
    /CHECK/,
  );
});

test("a failed 0005 rolls back every new column/table and leaves the 0004 data intact", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "clawd-migration-rollback-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "fixture.sqlite"),
    copy = join(dir, "migrations");
  mkdirSync(copy);
  const old = createD1(path, { upTo: 4 });
  seed(old);
  old.raw.exec("CREATE TABLE d1_migrations(name TEXT PRIMARY KEY)");
  const files = readdirSync(new URL("../migrations/", import.meta.url))
    .filter((x) => x.endsWith(".sql"))
    .sort();
  for (const file of files) {
    if (/^000[1-4]_/.test(file))
      old.raw.prepare("INSERT INTO d1_migrations VALUES (?)").run(file);
    const sql = readFileSync(
      new URL("../migrations/" + file, import.meta.url),
      "utf8",
    );
    writeFileSync(
      join(copy, file),
      sql +
        (file.startsWith("0005_")
          ? "\nSELECT * FROM deliberate_missing_migration_fixture;"
          : ""),
    );
  }
  old.raw.close();
  assert.throws(
    () => openDatabase(path, { migrations: pathToFileURL(copy + "/") }),
    /deliberate_missing_migration_fixture/,
  );
  const db = new DatabaseSync(path, { readOnly: true });
  t.after(() => db.close());
  assert.equal(db.prepare("SELECT count(*) n FROM app_migrations").get().n, 4);
  assert.equal(
    db
      .prepare("PRAGMA table_info(players)")
      .all()
      .some((x) => x.name === "auth_version"),
    false,
  );
  assert.equal(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE name='password_credentials'",
      )
      .get(),
    undefined,
  );
  assert.equal(
    db.prepare("SELECT best_score FROM players WHERE id='guest'").get()
      .best_score,
    250,
  );
  assert.equal(db.prepare("SELECT count(*) n FROM tokens").get().n, 2);
});
