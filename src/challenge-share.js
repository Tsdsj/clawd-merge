import { CHALLENGE_RULES_VERSION } from "./rules.js";
import { challengeReceiptFields } from "./challenge-result.js";
import { drawCrabIcon, defOf } from "./crabs.js";
const PUBLIC_GAME = "https://tsdsj.github.io/clawd-merge/";
const validDate = (v) =>
  typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  Number.isFinite(Date.parse(`${v}T00:00:00Z`)) &&
  new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const scoreValid = (v) => Number.isSafeInteger(v) && v >= 0 && v <= 10000000;
export function parseChallengeLink(hash) {
  if (typeof hash !== "string") return { kind: "invalid" };
  if (
    new URLSearchParams(hash.slice(1)).has("login") ||
    new URLSearchParams(hash.slice(1)).has("login_error")
  )
    return { kind: "none" };
  if (!hash || (!hash.includes("challenge") && !hash.includes("rules=")))
    return { kind: "none" };
  if (typeof hash !== "string" || hash.length > 256 || !hash.startsWith("#"))
    return { kind: "invalid" };
  const p = new URLSearchParams(hash.slice(1));
  if (
    [...p.keys()].some(
      (k) =>
        !["challenge", "rules", "target"].includes(k) ||
        p.getAll(k).length !== 1,
    ) ||
    !validDate(p.get("challenge")) ||
    !p.get("rules")
  )
    return { kind: "invalid" };
  const t = p.get("target");
  if (t !== null && (!/^(0|[1-9]\d{0,7})$/.test(t) || !scoreValid(Number(t))))
    return { kind: "invalid" };
  if (p.get("rules") !== CHALLENGE_RULES_VERSION)
    return { kind: "unsupported" };
  return {
    kind: "invite",
    challengeId: p.get("challenge"),
    rulesVersion: p.get("rules"),
    target: t === null ? null : Number(t),
  };
}
export function challengeLink({ challengeId, rulesVersion, score }) {
  if (
    !validDate(challengeId) ||
    rulesVersion !== CHALLENGE_RULES_VERSION ||
    !scoreValid(score)
  )
    throw new Error("invalid_share_result");
  return `${PUBLIC_GAME}#${new URLSearchParams({ challenge: challengeId, rules: rulesVersion, target: String(score) })}`;
}
export function invitationDefinition(invite, today) {
  if (invite.kind !== "invite") return invite;
  if (!today) return { kind: "offline" };
  if (invite.challengeId > today.challengeId) return { kind: "future" };
  if (invite.rulesVersion !== CHALLENGE_RULES_VERSION)
    return { kind: "unsupported" };
  return {
    kind: invite.challengeId === today.challengeId ? "today" : "practice",
    definition: {
      challengeId: invite.challengeId,
      rulesVersion: invite.rulesVersion,
      count: 100,
    },
  };
}
export function shareResult(record, entry = null) {
  const g = record?.game,
    d = g?.challenge;
  if (
    !d ||
    d.phase !== "finished" ||
    !scoreValid(g.score) ||
    !Number.isInteger(g.maxLevel) ||
    g.maxLevel < 1 ||
    g.maxLevel > 11 ||
    !Number.isInteger(g.drops) ||
    g.drops < 0 ||
    g.drops > 100
  )
    throw new Error("unfinished_share_result");
  let accepted = false;
  const receipt =
    record.upload?.state === "accepted"
      ? record.upload.receipt
      : entry?.roundId === record.roundId && entry.state === "accepted"
        ? entry.receipt
        : null;
  if (receipt && record.mode === "formal") {
    try {
      challengeReceiptFields(receipt, {
        sessionId: record.online.sessionId,
        challengeId: d.challengeId,
        rulesVersion: d.rulesVersion,
        score: g.score,
      });
      accepted = true;
    } catch {
      /* Never borrow another round's receipt. */
    }
  }
  const result = {
    challengeId: d.challengeId,
    rulesVersion: d.rulesVersion,
    score: g.score,
    drops: g.drops,
    maxLevel: g.maxLevel,
    name:
      record.mode === "formal"
        ? String(record.online?.playerName || "挑战玩家").slice(0, 128)
        : "练习玩家",
    status:
      record.mode !== "formal"
        ? "练习 · 不参与排名"
        : accepted
          ? "正式 · 已提交"
          : record.upload?.state === "removed" ||
              ["rejected", "corrupt"].includes(entry?.state)
            ? "正式 · 未确认"
            : "正式 · 待提交",
  };
  return { ...result, url: challengeLink(result) };
}
export async function shareImage(nav, file, url) {
  try {
    if (!file || !nav.canShare?.({ files: [file] }) || !nav.share)
      return "unsupported";
    await nav.share({
      files: [file],
      title: "合成大Clawd · 每日挑战",
      text: "同一道题，你能合到多少分？",
      url,
    });
    return "shared";
  } catch (e) {
    return e.name === "AbortError" ? "cancelled" : "failed";
  }
}
export async function renderShareCard(result) {
  // No remote images: the same canvas is previewed and exported.
  if (document.fonts) {
    let timer;
    await Promise.race([
      document.fonts.ready,
      new Promise((resolve) => {
        timer = setTimeout(resolve, 1500);
      }),
    ]).finally(() => clearTimeout(timer));
  }
  const canvas = document.createElement("canvas");
  canvas.width = 900;
  canvas.height = 1200;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas_unavailable");
  const font = 'system-ui, -apple-system, "PingFang SC", sans-serif';
  const text = (v, x, y, size = 30, color = "#f3e9e2", weight = 400) => {
    ctx.fillStyle = color;
    ctx.font = `${weight} ${size}px ${font}`;
    ctx.fillText(v, x, y);
  };
  const line = (y) => {
    ctx.strokeStyle = "#48455e";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(60, y);
    ctx.lineTo(840, y);
    ctx.stroke();
  };
  ctx.fillStyle = "#171c2e";
  ctx.fillRect(0, 0, 900, 1200);
  ctx.strokeStyle = "#6c5051";
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, 896, 1196);
  text("合成大Clawd", 60, 98, 42, "#f0bd9f", 750);
  text(result.status, 60, 158, 26, "#f0bd9f");
  text(`每日挑战 / ${result.challengeId}`, 60, 233, 29, "#c1b7cc");
  ctx.font = `600 34px ${font}`;
  const chars = Array.from(result.name.replace(/[\u0000-\u001f\u007f]/g, ""));
  let lines = [""];
  for (const ch of chars) {
    const i = lines.length - 1;
    if (ctx.measureText(lines[i] + ch).width > 770) {
      if (lines.length === 2) {
        lines[i] = lines[i].slice(0, -1) + "…";
        break;
      }
      lines.push(ch);
    } else lines[i] += ch;
  }
  lines.forEach((v, i) => text(v, 60, 295 + i * 44, 34, "#f3e9e2", 600));
  text(
    result.score.toLocaleString("zh-CN"),
    60,
    477,
    result.score >= 1000000 ? 114 : 150,
    "#f3e9e2",
    800,
  );
  const icon = document.createElement("canvas");
  drawCrabIcon(icon, result.maxLevel, 220, 170, 1);
  ctx.drawImage(icon, 60, 528, 220, 170);
  text(defOf(result.maxLevel).name, 325, 591, 38, "#f3e9e2", 650);
  text(`最高合成 · Lv.${result.maxLevel}`, 325, 644, 29, "#c1b7cc");
  line(748);
  text(`${result.drops} / 100 次投放`, 60, 802, 30, "#c1b7cc");
  text(`规则 ${result.rulesVersion}`, 555, 802, 30, "#c1b7cc");
  line(838);
  text("同一道题，等你来挑战。", 60, 918, 42, "#f3e9e2", 650);
  text("目标分由分享者提供，不代表官方排名", 60, 976, 26, "#c1b7cc");
  text("https://tsdsj.github.io/clawd-merge/", 60, 1044, 26, "#c1b7cc");
  text(
    `#challenge=${result.challengeId}&rules=${result.rulesVersion}`,
    60,
    1091,
    25,
    "#c1b7cc",
  );
  text(`&target=${result.score}`, 60, 1134, 25, "#c1b7cc");
  const blob = await new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("image_export_failed"))),
      "image/png",
    ),
  );
  return {
    canvas,
    blob,
    file:
      typeof File === "function"
        ? new File([blob], `clawd-${result.challengeId}-${result.score}.png`, {
            type: "image/png",
          })
        : null,
  };
}
