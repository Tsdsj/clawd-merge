// Deterministic design sheet using the existing code-native pixel art and palette.
// Run from repository root: node docs/prototypes/m3-01/make-design.mjs
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
let out = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="1040" viewBox="0 0 1280 1040"><rect width="1280" height="1040" fill="#101321"/><style>text{font-family:'PingFang SC','Microsoft YaHei',sans-serif} .pixel{shape-rendering:crispEdges}</style>`;
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

function button(x, y, w, label, ghost = false) {
  rect(x, y, w, 44, ghost ? c.bg : c.orange, ghost ? c.line : "none", 6);
  text(x + w / 2, y + 28, label, 13, ghost ? c.text : "#17131a", 700, "middle");
}
function frame(x, step, title) {
  text(x + 2, 30, step, 12, c.peach);
  text(x + 2, 61, title, 23, c.text, 700);
  rect(x, 84, 374, 865, "#24273c", "#aa725b", 10);
  text(x + 22, 128, "玩法与设置", 23, c.peach, 700);
  text(x + 342, 128, "×", 23, c.sub);
  rect(x + 22, 153, 330, 44, "#171c2e", c.line);
}
function tabs(x, settings) {
  rect(x + (settings ? 189 : 26), 157, 159, 36, "#403443", "#805c57", 5);
  text(x + 105, 181, "玩法", 13, settings ? c.sub : c.peach, 600, "middle");
  text(x + 268, 181, "舒适设置", 13, settings ? c.peach : c.sub, 600, "middle");
}
function toggle(x, y, on, disabled = false) {
  rect(
    x,
    y,
    42,
    24,
    on ? c.orange : "#4b4859",
    disabled ? "#575465" : "#8b8294",
    12,
  );
  rect(
    x + (on ? 23 : 4),
    y + 4,
    16,
    16,
    disabled ? "#8b8494" : on ? c.bg : c.text,
    "none",
    8,
  );
}
function settings(x, reduced = false, error = false) {
  tabs(x, true);
  text(x + 22, 229, "本机设置 · 经典与每日共用", 11, c.sub);
  text(x + 22, 267, "动态效果", 15, c.text, 700);
  for (const [i, label] of ["跟随系统", "减弱", "标准"].entries()) {
    rect(
      x + 22 + i * 113,
      282,
      104,
      42,
      i === 0 ? "#493440" : c.bg,
      i === 0 ? c.orange : c.line,
      6,
    );
    text(
      x + 74 + i * 113,
      309,
      label,
      13,
      i === 0 ? c.peach : c.text,
      600,
      "middle",
    );
  }
  text(
    x + 22,
    354,
    reduced ? "当前系统：减弱动态 · 已跟随" : "当前系统：标准动态 · 已跟随",
    13,
    c.peach,
  );
  text(
    x + 22,
    380,
    reduced
      ? "关闭强化动效，危险提示和分数仍保留。"
      : "可单独关闭震屏或装饰粒子。",
    12,
    c.sub,
  );
  line(x + 22, 403, 330);
  text(x + 22, 434, "合成震屏", 14, c.text, 650);
  text(x + 22, 456, "大合成时轻微晃动棋盘。", 11, c.sub);
  toggle(x + 309, 426, !reduced, reduced);
  line(x + 22, 478, 330);
  text(x + 22, 509, "装饰粒子", 14, c.text, 650);
  text(x + 22, 531, "合成时的小碎屑与庆祝粒子。", 11, c.sub);
  toggle(x + 309, 501, !reduced, reduced);
  line(x + 22, 551, 330);
  text(x + 22, 582, "触控震动", 14, c.text, 650);
  text(x + 22, 604, "默认关闭；设备支持时轻触反馈。", 11, c.sub);
  toggle(x + 309, 574, false);
  rect(x + 22, 625, 330, 125, c.bg, c.line, 7);
  text(x + 36, 651, "效果预览", 12, c.text, 600);
  text(x + 334, 651, reduced ? "减弱动态" : "标准动态", 11, c.sub, 400, "end");
  crab(7, x + 97, 670, 2.4);
  text(x + 193, 698, "合成 +30", 15, c.peach, 700);
  text(
    x + 187,
    733,
    "点击预览 · 不计分、不发声、不震动",
    10,
    c.sub,
    400,
    "middle",
  );
  if (error) {
    rect(x + 22, 768, 330, 76, "#49313a", "#b4775f", 5);
    text(x + 34, 791, "未能保存，设置已在本页生效。", 12, c.peach);
    text(x + 34, 813, "刷新后可能恢复旧设置。", 11, c.sub);
    text(x + 330, 831, "重试保存", 11, c.peach, 500, "end");
  } else {
    text(x + 22, 784, "危险提示始终保留；音效由原按钮控制。", 11, c.sub);
    text(x + 22, 817, "已保存到本机 · 即时生效", 12, c.sub);
  }
  text(x + 22, 867, "恢复舒适设置默认值", 12, c.peach);
  line(x + 22, 885, 330);
  text(x + 22, 916, "游戏已暂停", 10, c.sub);
  button(x + 185, 897, 167, "完成，返回游戏");
}
const a = 34,
  b = 453,
  d = 872;
frame(a, "01 / 复用入口", "从现有 ? 进入，不加一排按钮");
tabs(a, false);
text(a + 22, 246, "每日挑战规则", 21, c.text, 700);
text(a + 22, 288, "同一道题，同一串 Clawd。", 14);
text(a + 22, 324, "每局 100 投，正式机会每日 3 次。", 14);
text(a + 22, 354, "练习不限次数，不参与排名。", 14);
line(a + 22, 386, 330);
text(a + 22, 421, "最后一投后最多结算 8 秒，", 14);
text(a + 22, 449, "落稳可提前结束。", 14);
text(a + 22, 493, "暂停不会延长正式提交截止。", 13, c.peach);
crab(7, a + 151, 558, 3.4);
button(a + 22, 674, 330, "调整动效与震动");
text(a + 22, 749, "经典入口显示经典玩法；", 12, c.sub);
text(a + 22, 773, "两种模式共享同一套舒适设置。", 12, c.sub);
line(a + 22, 885, 330);
text(a + 22, 910, "游戏已暂停", 10, c.sub);
text(a + 22, 929, "正式截止不延长", 10, c.sub);
button(a + 185, 897, 167, "完成，返回游戏");
frame(b, "02 / 默认状态", "跟随系统，开关清晰");
settings(b);
frame(d, "03 / 减弱与异常", "关掉刺激，不丢掉选择");
settings(d, true, true);
text(
  34,
  994,
  "M3-01 · 设置即时生效；保存失败只影响刷新后的记忆 · 恢复默认可撤销 · 不改变碰撞、概率或计分",
  14,
  c.sub,
);
out += "</svg>";
writeFileSync(new URL("./design.svg", import.meta.url), out);
