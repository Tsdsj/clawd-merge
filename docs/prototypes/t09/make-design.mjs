// Deterministic design sheet using the existing code-native pixel art and palette.
// Run from repository root: node docs/prototypes/t09/make-design.mjs
import { writeFileSync, readFileSync } from 'node:fs';
import { defOf, PALETTE } from '../../../src/crabs.js';
const base = [
  ...readFileSync(new URL('../../../src/crabs.js', import.meta.url), 'utf8')
    .match(/const BASE = \[([\s\S]*?)\];/)[1]
    .matchAll(/'([^']+)'/g),
].map((m) => m[1]);
const c = {
  bg: '#1a1b2e',
  board: '#151a2e',
  line: '#41415b',
  text: '#f3e9e2',
  sub: '#bdb4cc',
  orange: '#d97757',
  peach: '#f0bd9f',
};
let out = `<svg xmlns="http://www.w3.org/2000/svg" width="1290" height="1000" viewBox="0 0 1290 1000"><rect width="1290" height="1000" fill="#101321"/><style>text{font-family:'PingFang SC','Microsoft YaHei',sans-serif} .pixel{shape-rendering:crispEdges}</style>`;
const esc = (text) => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;');
const rect = (x, y, w, h, fill, stroke = 'none', r = 7) =>
  (out += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}"/>`);
const text = (x, y, copy, size = 14, color = c.text, weight = 400, anchor = 'start') =>
  (out += `<text x="${x}" y="${y}" fill="${color}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}">${esc(copy)}</text>`);
const line = (x, y, w) => (out += `<path d="M${x} ${y}h${w}" stroke="${c.line}"/>`);
function crab(level, x, y, cell) {
  const cells = new Map(),
    put = (x, y, ch) => {
      if (ch === 'x') cells.delete(`${x},${y}`);
      else if (ch !== '.') cells.set(`${x},${y}`, { x, y, ch });
    };
  base.forEach((row, y) => [...row].forEach((ch, x) => put(x, y, ch)));
  for (const layer of defOf(level).layers)
    layer.art.forEach((row, y) => [...row].forEach((ch, x) => put(x + layer.x, y + layer.y, ch)));
  out += `<g class="pixel" transform="translate(${x} ${y}) scale(${cell})">`;
  for (const { x, y, ch } of cells.values())
    out += `<rect x="${x}" y="${y}" width="1" height="1" fill="${ch === '#' ? defOf(level).color : PALETTE[ch]}"/>`;
  out += '</g>';
}
function button(x, y, label, ghost = false) {
  rect(x, y, 346, 48, ghost ? c.bg : c.orange, ghost ? c.orange : 'none');
  text(x + 173, y + 30, label, 15, ghost ? c.peach : c.text, 700, 'middle');
}
function shell(x, step, name) {
  text(x + 8, 32, step, 12, c.peach, 600);
  text(x + 8, 59, name, 21, c.text, 700);
  rect(x, 82, 390, 826, c.bg, c.line, 12);
  text(x + 22, 132, '合成大Clawd', 26, c.orange, 800);
  rect(x + 330, 102, 38, 38, '#222438', c.line);
  text(x + 349, 128, '?', 20, c.sub, 500, 'middle');
  rect(x + 22, 163, 346, 48, '#111626', c.line);
  rect(x + 195, 167, 169, 40, '#3b3040', '#7e574d', 5);
  text(x + 108, 193, '经典模式', 14, c.sub, 600, 'middle');
  text(x + 280, 193, '每日挑战', 14, c.peach, 600, 'middle');
  text(x + 22, 239, '游客 · 橙色钳子 #4821', 12, c.sub);
  text(x + 368, 239, '挑战规则', 12, c.peach, 400, 'end');
}
const x1 = 25,
  x2 = 450,
  x3 = 875;
shell(x1, '01 / 入口', '读清规则，再开始');
text(x1 + 22, 294, '大家玩同一道题', 12, c.peach);
text(x1 + 22, 342, '10 月 02 日', 30, c.text, 700);
crab(7, x1 + 282, 307, 4);
text(x1 + 22, 383, '北京时间 00:00 换题 · 今日题目已就绪', 12, c.sub);
line(x1 + 22, 413, 346);
text(x1 + 22, 444, '每局投放', 12, c.sub);
text(x1 + 215, 444, '今日正式机会', 12, c.sub);
text(x1 + 22, 483, '100', 30, c.text, 700);
text(x1 + 86, 483, '次', 12, c.sub);
text(x1 + 215, 483, '3', 30, c.text, 700);
text(x1 + 248, 483, '/ 3 次', 12, c.sub);
line(x1 + 22, 507, 346);
text(x1 + 22, 541, '今日最好', 12, c.sub);
text(x1 + 368, 541, '还没有正式成绩', 12, c.text, 400, 'end');
button(x1 + 22, 574, '开始正式挑战');
button(x1 + 22, 638, '先练一局 · 不限次数', true);
text(x1 + 195, 713, '领取凭证后扣 1 次；刷新续玩不再扣次。', 11, c.sub, 400, 'middle');
line(x1 + 22, 747, 346);
text(x1 + 22, 788, '经典局已保留 · 1,282 分', 12, c.sub);
text(x1 + 368, 788, '继续经典', 12, c.peach, 400, 'end');
text(x1 + 195, 868, '经典与挑战分别保存，切换不误丢进度', 11, c.sub, 400, 'middle');
shell(x2, '02 / 对局', '资格与剩余投放始终可见');
rect(x2 + 22, 263, 103, 28, '#342b36', '#8c6354', 5);
text(x2 + 74, 282, '正式 · 第 1 次', 11, c.peach, 400, 'middle');
text(x2 + 143, 282, '10 月 02 日', 12, c.sub);
text(x2 + 22, 326, '本局分数', 12, c.sub);
text(x2 + 181, 326, '剩余投放', 12, c.sub);
text(x2 + 330, 326, '下一个', 12, c.sub);
text(x2 + 22, 363, '2,864', 29, c.text, 700);
text(x2 + 181, 363, '37', 29, c.peach, 700);
text(x2 + 228, 363, '/ 100', 12, c.sub);
crab(3, x2 + 332, 344, 1.7);
rect(x2 + 66, 391, 258, 413, c.board, '#5e5773');
out += `<path d="M${x2 + 66} 480h258" stroke="#b56b68" stroke-dasharray="5 5"/>`;
crab(2, x2 + 185, 423, 2);
crab(7, x2 + 100, 739, 5);
crab(4, x2 + 226, 766, 3);
crab(5, x2 + 175, 683, 4);
crab(3, x2 + 88, 666, 3);
crab(6, x2 + 231, 621, 4);
for (const [dx, label] of [
  [22, '钳子 ×1'],
  [141, '暂停'],
  [260, '新开一局'],
]) {
  rect(x2 + dx, 822, 108, 40, c.bg, c.orange);
  text(x2 + dx + 54, 848, label, 12, c.peach, 400, 'middle');
}
text(x2 + 195, 888, '当前挑战已保存；经典局仍保留', 11, c.sub, 400, 'middle');
shell(x3, '03 / 结果', '正式、练习与经典成绩分开');
rect(x3 + 132, 287, 126, 28, '#342b36', '#8c6354', 5);
text(x3 + 195, 306, '正式挑战完成', 11, c.peach, 400, 'middle');
text(x3 + 195, 345, '10 月 02 日 · 每日挑战', 12, c.sub, 400, 'middle');
text(x3 + 195, 422, '9,764', 54, c.peach, 750, 'middle');
text(x3 + 195, 465, '100 / 100 投 · 最高合成：魔法Clawd', 12, c.sub, 400, 'middle');
rect(x3 + 22, 498, 346, 99, '#252b3c', '#587368');
text(x3 + 39, 533, '已计入今日成绩', 14, '#c0e1c6', 650);
text(x3 + 39, 566, '今日个人最好 9,764 · 当前排名 #12', 12, c.sub);
button(x3 + 22, 627, '再挑战一次 · 还剩 2 次');
button(x3 + 22, 691, '练习这道题', true);
text(x3 + 195, 782, '查看今日榜', 13, c.peach, 400, 'middle');
text(x3 + 195, 831, '返回每日入口', 13, c.peach, 400, 'middle');
text(25, 948, 'T09 设计参考 · 沿用 M1 配色与现有像素资产 · 全部为示例状态，未接入服务端', 14, c.sub);
text(25, 977, '静态图不表达：开局确认、暂停、8 秒结算、离线恢复及跨日；请在可点击原型中查看。', 13, c.sub);
out += '</svg>';
writeFileSync(new URL('./design.svg', import.meta.url), out);
