import test from "node:test";
import assert from "node:assert/strict";
const policyModule = import("../src/name-policy.js").catch(() => null);
async function api() {
  const m = await policyModule;
  assert.ok(m?.checkName, "A03 shared name policy must exist");
  return m;
}

for (const name of [
  "小螃蟹",
  "王伟",
  "张伟",
  "李白",
  "北京玩家",
  "上海小猫",
  "曹操",
  "幸运儿",
  "游戏机",
  "妈妈的花",
  "大麻花",
  "Scunthorpe",
  "Dickson",
  "gender",
  "duck",
  "chicken",
  "shirt",
]) {
  test(`ordinary name remains allowed: ${name}`, async () => {
    const m = await api();
    assert.equal(m.checkName(name).ok, true);
  });
}
test("NFKC, edge spaces, ASCII case and astral Han have stable canonical keys", async () => {
  const m = await api();
  assert.equal(m.checkName("  Ａｌｉｃｅ  ").name, "Alice");
  assert.equal(m.loginHandleKey("ＡＬＩＣＥ#４８２１"), "alice#4821");
  assert.equal(m.checkName("𠮷野").ok, true);
});
for (const name of [
  "x",
  "十三个汉字超过长度的测试名字",
  "A B",
  "小\u200b猫",
  "小\u202e猫",
  "小\ud800猫",
  "\n小猫",
  "🙂🙂",
]) {
  test(
    "reject malformed or invisible new name " + JSON.stringify(name),
    async () => {
      const m = await api();
      assert.equal(m.checkName(name).error, "bad_name");
    },
  );
}
for (const name of [
  "ａｄｍｉｎ",
  "a_d-m·in",
  "官方",
  "官-方",
  "傻逼",
  "傻-逼",
  "賭博",
  "販毒",
  "fuck",
  "f_u_c_k",
  "小fuck",
  "官方认证客服",
]) {
  test(`reject reserved, curated or explicit variant name: ${name}`, async () => {
    const m = await api();
    assert.equal(m.checkName(name).ok, false);
  });
}
test("project blocklist cannot be overridden by exact exceptions", async () => {
  const m = await api();
  assert.equal(m.checkName("大麻花").ok, true);
  assert.equal(m.checkName("大麻花", { blockedWords: "大麻" }).ok, false);
  assert.equal(m.checkName("大麻花玩家").ok, false);
});
test("login handle normalization never re-applies a changed name policy", async () => {
  const m = await api();
  assert.equal(m.checkName("赌博").ok, false);
  assert.equal(m.loginHandleKey("赌博#4821"), "赌博#4821");
  assert.equal(m.loginHandleKey("只有名字"), null);
});
test("corrupt or missing policy closes new naming but keeps display readable", async () => {
  const m = await api();
  const bundled = await import("../data/name-policy-v1.js");
  const damaged = structuredClone(bundled.data);
  damaged.version += "-broken";
  const unavailable = await m.compileNamePolicy(damaged, bundled.sha256);
  assert.equal(unavailable, null);
  assert.equal(
    m.checkName("小螃蟹", { policy: unavailable }).error,
    "name_policy_unavailable",
  );
  assert.equal(
    m.displayName(
      { name: "任何旧名", public_alias: "玩家·000042" },
      { policy: unavailable },
    ),
    "玩家·000042",
  );
});
test("public display masks blocked legacy/external names without changing raw name or login", async () => {
  const m = await api();
  const player = { name: "傻逼", public_alias: "玩家·000042" };
  assert.equal(m.displayName(player), "玩家·000042");
  assert.equal(player.name, "傻逼");
  assert.equal(
    m.displayName({
      name: "ExistingLongExternalName",
      public_alias: "玩家·000043",
    }),
    "ExistingLongExternalName",
  );
});
