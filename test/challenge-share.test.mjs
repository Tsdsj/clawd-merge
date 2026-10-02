import test from "node:test";
import assert from "node:assert/strict";
import {
  parseChallengeLink,
  challengeLink,
  invitationDefinition,
  shareResult,
  shareImage,
} from "../src/challenge-share.js";
const fields = {
  challengeId: "2026-10-03",
  rulesVersion: "daily-1",
  score: 3465,
};
test("share links whitelist public fields and cannot copy credentials or API overrides", () => {
  const url = challengeLink({
    ...fields,
    token: "secret",
    sessionId: "hidden",
    api: "https://evil.test",
    name: "private",
  });
  assert.equal(
    url,
    "https://tsdsj.github.io/clawd-merge/#challenge=2026-10-03&rules=daily-1&target=3465",
  );
  assert.deepEqual(parseChallengeLink(new URL(url).hash), {
    kind: "invite",
    challengeId: fields.challengeId,
    rulesVersion: "daily-1",
    target: 3465,
  });
  assert.equal(parseChallengeLink("#login=secret").kind, "none");
  assert.equal(
    parseChallengeLink("#login=secret&challenge=2026-10-03&rules=daily-1").kind,
    "none",
  );
  assert.equal(parseChallengeLink("").kind, "none");
});
test("invalid dates, duplicate keys, credentials, decimals, overflow and unknown versions never start another topic", () => {
  for (const hash of [
    "#challenge=2026-02-30&rules=daily-1",
    "#challenge=2026-10-03&challenge=2026-10-02&rules=daily-1",
    "#challenge=2026-10-03&rules=daily-1&target=-1",
    "#challenge=2026-10-03&rules=daily-1&target=1.5",
    "#challenge=2026-10-03&rules=daily-1&target=10000001",
    "#challenge=2026-10-03&rules=daily-1&token=secret",
    "#challenge=%ZZ&rules=daily-1",
    "#challenge=2026-10-03&rules=daily-1&target=",
    " #challenge=2026-10-03&rules=daily-1",
  ])
    assert.equal(parseChallengeLink(hash).kind, "invalid", hash);
  assert.equal(
    parseChallengeLink("#challenge=2026-10-03&rules=daily-999").kind,
    "unsupported",
  );
  assert.equal(
    parseChallengeLink("#challenge=2026-10-03&rules=daily-1").target,
    null,
  );
});
test("server-confirmed day determines today, old practice and future rejection", () => {
  const link = parseChallengeLink(
    "#challenge=2026-10-03&rules=daily-1&target=0",
  );
  assert.equal(invitationDefinition(link, null).kind, "offline");
  assert.equal(
    invitationDefinition(link, {
      challengeId: "2026-10-02",
      rulesVersion: "daily-1",
      count: 100,
    }).kind,
    "future",
  );
  assert.equal(
    invitationDefinition(link, {
      challengeId: "2026-10-03",
      rulesVersion: "daily-1",
      count: 100,
    }).kind,
    "today",
  );
  const old = invitationDefinition(link, {
    challengeId: "2026-10-04",
    rulesVersion: "daily-1",
    count: 100,
  });
  assert.equal(old.kind, "practice");
  assert.deepEqual(old.definition, {
    challengeId: "2026-10-03",
    rulesVersion: "daily-1",
    count: 100,
  });
});
const record = {
  mode: "formal",
  roundId: "round-a",
  online: { sessionId: "round-a", playerId: "player-a", playerName: "原玩家" },
  game: {
    score: 3465,
    drops: 100,
    maxLevel: 9,
    challenge: { ...fields, phase: "finished" },
  },
};
test("cards use original result identity and only the matching accepted receipt", () => {
  assert.equal(shareResult(record).status, "正式 · 待提交");
  const receipt = {
    sessionId: "round-a",
    challengeId: fields.challengeId,
    rulesVersion: "daily-1",
    improved: true,
    best: 3465,
    rank: 1,
  };
  assert.equal(
    shareResult({ ...record, upload: { state: "accepted", receipt } }).status,
    "正式 · 已提交",
  );
  assert.equal(
    shareResult(record, { roundId: "round-b", state: "accepted", receipt })
      .status,
    "正式 · 待提交",
  );
  assert.equal(
    shareResult({
      ...record,
      upload: {
        state: "accepted",
        receipt: { ...receipt, sessionId: "round-b" },
      },
    }).status,
    "正式 · 待提交",
  );
  const card = shareResult(record);
  assert.equal(card.name, "原玩家");
  assert.equal("online" in card, false);
  assert.equal("roundId" in card, false);
  assert.equal(
    shareResult({ ...record, mode: "practice", online: null }).status,
    "练习 · 不参与排名",
  );
  assert.equal(
    shareResult({ ...record, upload: { state: "removed" } }).status,
    "正式 · 未确认",
  );
  assert.throws(() =>
    shareResult({
      ...record,
      game: {
        ...record.game,
        challenge: { ...record.game.challenge, phase: "playing" },
      },
    }),
  );
});
test("native sharing distinguishes cancel, unsupported and failure without automatic sends", async () => {
  const file = { name: "card.png" };
  let sent = 0;
  assert.equal(
    await shareImage(
      { canShare: () => false, share: () => sent++ },
      file,
      "public",
    ),
    "unsupported",
  );
  assert.equal(sent, 0);
  assert.equal(
    await shareImage(
      {
        canShare: () => true,
        share: async () => {
          sent++;
          throw Object.assign(new Error(), { name: "AbortError" });
        },
      },
      file,
      "public",
    ),
    "cancelled",
  );
  assert.equal(
    await shareImage(
      {
        canShare: () => true,
        share: async () => {
          throw new Error("failed");
        },
      },
      file,
      "public",
    ),
    "failed",
  );
  assert.equal(
    await shareImage(
      {
        canShare: () => true,
        share: async (v) => {
          assert.equal(v.url, "public");
          assert.equal(v.files[0], file);
        },
      },
      file,
      "public",
    ),
    "shared",
  );
});
