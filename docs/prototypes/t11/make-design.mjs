// Deterministic design sheet using the existing code-native pixel art and palette.
// Run from repository root: node docs/prototypes/t11/make-design.mjs
import { writeFileSync, readFileSync } from "node:fs";
import { defOf, PALETTE } from "../../../src/crabs.js";
const base = [
  ...readFileSync(new URL("../../../src/crabs.js", import.meta.url), "utf8")
    .match(/const BASE = \[([\s\S]*?)\];/)[1]
    .matchAll(/'([^']+)'/g),
].map((m) => m[1]);
const c = {
  bg: "#1a1b2e",
  board: "#151a2e",
  line: "#41415b",
  text: "#f3e9e2",
  sub: "#bdb4cc",
  orange: "#d97757",
  peach: "#f0bd9f",
};
let out = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="960" viewBox="0 0 1280 960"><rect width="1280" height="960" fill="#101321"/><style>text{font-family:'PingFang SC','Microsoft YaHei',sans-serif} .pixel{shape-rendering:crispEdges}</style>`;
const esc = (text) =>
  String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;");
const rect = (x, y, w, h, fill, stroke = "none", r = 7) =>
  (out += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}"/>`);
const text = (
  x,
  y,
  copy,
  size = 14,
  color = c.text,
  weight = 400,
  anchor = "start",
) =>
  (out += `<text x="${x}" y="${y}" fill="${color}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}">${esc(copy)}</text>`);
const line = (x, y, w) =>
  (out += `<path d="M${x} ${y}h${w}" stroke="${c.line}"/>`);
function crab(level, x, y, cell) {
  const cells = new Map(),
    put = (x, y, ch) => {
      if (ch === "x") cells.delete(`${x},${y}`);
      else if (ch !== ".") cells.set(`${x},${y}`, { x, y, ch });
    };
  base.forEach((row, y) => [...row].forEach((ch, x) => put(x, y, ch)));
  for (const layer of defOf(level).layers)
    layer.art.forEach((row, y) =>
      [...row].forEach((ch, x) => put(x + layer.x, y + layer.y, ch)),
    );
  out += `<g class="pixel" transform="translate(${x} ${y}) scale(${cell})">`;
  for (const { x, y, ch } of cells.values())
    out += `<rect x="${x}" y="${y}" width="1" height="1" fill="${ch === "#" ? defOf(level).color : PALETTE[ch]}"/>`;
  out += "</g>";
}

function btn(x, y, label, ghost = false) {
  rect(x, y, 326, 46, ghost ? c.bg : c.orange, ghost ? c.line : "none");
  text(x + 163, y + 29, label, 14, ghost ? c.text : "#16131b", 700, "middle");
}
function frame(x, kicker, title) {
  text(x + 2, 30, kicker, 12, c.peach);
  text(x + 2, 62, title, 23, c.text, 700);
  rect(x, 85, 374, 785, c.bg, c.line, 12);
  text(x + 24, 130, "合成大Clawd", 23, c.orange, 800);
  text(x + 350, 130, "每日挑战", 11, c.sub, 400, "end");
  line(x + 24, 153, 326);
}
frame(34, "01 / 结算", "让分享成为自然的下一步");
let x = 34;
text(x + 24, 192, "10 月 03 日 · 正式挑战", 12, c.peach);
text(x + 24, 231, "这一局，合得不错", 23, c.text, 700);
crab(9, x + 137, 275, 5);
text(x + 187, 460, "3,465", 62, c.text, 800, "middle");
text(
  x + 187,
  498,
  "100 / 100 投 · 最高合成 Ninja Clawd",
  12,
  c.sub,
  400,
  "middle",
);
rect(x + 24, 532, 326, 53, "#302b3b");
text(x + 38, 564, "成绩已提交 · 今日个人最好 3,465 分", 12);
btn(x + 24, 608, "分享这一局");
btn(x + 24, 666, "再挑战", true);
btn(x + 24, 724, "查看今日榜", true);
text(x + 187, 818, "分享不会消耗正式机会", 12, c.sub, 400, "middle");
frame(453, "02 / 卡片预览", "分数突出，状态说清楚");
x = 453;
text(x + 24, 192, "分享这一局", 23, c.text, 700);
text(x + 24, 222, "同一道题，你能合到多少分？", 13, c.sub);
rect(x + 24, 244, 326, 439, "#171c2e", "#6c5051", 8);
text(x + 44, 280, "合成大Clawd", 17, c.peach, 700);
rect(x + 238, 263, 93, 24, "#171c2e", "#7e574d", 4);
text(x + 284, 280, "正式 · 已提交", 10, c.text, 400, "middle");
text(x + 44, 319, "每日挑战 / 2026.10.03", 12, c.sub);
text(x + 44, 352, "橙色钳子", 15, c.text, 600);
text(x + 44, 428, "3,465", 64, c.text, 800);
crab(9, x + 53, 451, 3.2);
text(x + 151, 480, "Ninja Clawd", 16, c.text, 700);
text(x + 151, 505, "最高合成 · Lv.9", 12, c.sub);
line(x + 44, 533, 286);
text(x + 44, 558, "100 次投放", 12, c.sub);
text(x + 330, 558, "规则 daily-1", 12, c.sub, 400, "end");
line(x + 44, 575, 286);
text(x + 44, 611, "同一道题，等你来挑战。", 17, c.text, 650);
text(x + 44, 642, "tsdsj.github.io/clawd-merge/", 11, c.sub);
text(x + 44, 661, "#challenge=2026-10-03&rules=daily-1", 11, c.sub);
text(x + 44, 676, "&target=3465", 11, c.sub);
btn(x + 24, 709, "分享图片与链接");
btn(x + 24, 767, "保存图片 / 复制挑战链接", true);
text(x + 187, 840, "待提交与练习始终保留各自状态", 11, c.sub, 400, "middle");
frame(872, "03 / 好友入口", "先看邀请，再决定开局");
x = 872;
text(x + 24, 192, "收到一个同题挑战", 12, c.peach);
text(x + 24, 232, "10 月 03 日，来试一局", 23, c.text, 700);
text(x + 24, 264, "今日题目已由服务器确认", 13, c.sub);
line(x + 24, 294, 326);
text(x + 24, 329, "朋友的目标分", 13, c.sub);
text(x + 24, 400, "3,465", 52, c.text, 800);
text(x + 24, 432, "分享者填写 · 未经核验", 12, c.peach);
line(x + 24, 455, 326);
text(x + 24, 487, "相同投放序列，共 100 投。", 14);
text(x + 24, 515, "正式挑战使用你自己的身份和今日机会。", 13, c.sub);
rect(x + 24, 541, 326, 58, "#302b3b");
text(x + 38, 565, "你的原局已保留", 13);
text(x + 38, 584, "2,864 分 / 剩余 37 投", 12, c.sub);
btn(x + 24, 622, "查看今日正式挑战");
btn(x + 24, 680, "练这道题 · 不参与排名", true);
text(x + 187, 758, "暂不挑战，返回我的游戏", 13, c.peach, 400, "middle");
text(
  x + 187,
  811,
  "打开不扣次数 · 开始新局前确认替换",
  11,
  c.sub,
  400,
  "middle",
);
text(
  34,
  913,
  "T11 设计稿 · 日期与成绩为示例 · 旧题只练习 · 目标分未经核验 · 真实分享由用户主动发起",
  15,
  c.sub,
);
out += "</svg>";
writeFileSync(new URL("./design.svg", import.meta.url), out);
