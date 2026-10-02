// Isolated interface prototype: no Game, storage, API, sound or vibration writes.
import { drawCrabIcon } from "../../../src/crabs.js";
const $ = (id) => document.getElementById(id),
  defaults = () => ({
    motion: "system",
    shake: true,
    particles: true,
    haptics: false,
  });
let preferences = defaults(),
  saved = defaults(),
  systemReduced = false,
  storage = "ok",
  supported = true,
  undo = null,
  timer;
const panel = $("panel");
function effective() {
  const reduced =
    preferences.motion === "reduced" ||
    (preferences.motion === "system" && systemReduced);
  return {
    reduced,
    shake: preferences.shake && !reduced,
    particles: preferences.particles && !reduced,
    haptics: preferences.haptics && supported,
  };
}
function render() {
  const e = effective();
  document
    .querySelectorAll("[name=motion]")
    .forEach((r) => (r.checked = r.value === preferences.motion));
  $("system").checked = systemReduced;
  $("effective-copy").textContent =
    preferences.motion === "system"
      ? `当前系统：${systemReduced ? "减弱动态" : "标准动态"} · 已跟随`
      : preferences.motion === "reduced"
        ? "当前：减弱动态 · 不随系统变化"
        : "当前：标准动态 · 不随系统变化";
  $("motion-description").textContent = e.reduced
    ? "关闭震屏、装饰粒子、弹跳与强烈庆祝效果。危险提示和分数仍保留。"
    : "保留标准动效；你可以单独关闭震屏或装饰粒子。";
  for (const k of ["shake", "particles"]) {
    $(k).checked = e[k];
    $(k).disabled = e.reduced;
  }
  $("locked-note").hidden = !e.reduced;
  $("haptics").checked = preferences.haptics;
  $("haptics").disabled = !supported;
  $("haptics-description").textContent = supported
    ? "默认关闭；支持的触控设备可提供轻触反馈。"
    : "此设备未提供震动能力。已保存的偏好保留，但不会触发震动。";
  $("preview-label").textContent = e.reduced
    ? "减弱动态"
    : !e.shake && !e.particles
      ? "震屏 / 粒子均关闭"
      : "标准动态";
  $("storage-note").classList.toggle("error", storage !== "ok");
  $("storage-copy").textContent =
    storage === "read-error"
      ? "无法读取已保存设置，暂用默认值。选择在本页有效，原记录不会被自动覆盖。"
      : storage === "write-error"
        ? "未能保存。设置已在本页生效，刷新后可能恢复旧设置。"
        : "已保存到本机 · 即时生效";
  $("retry").hidden = storage === "ok";
  $("retry").textContent = storage === "read-error" ? "重试读取" : "重试保存";
  $("undo").hidden = !undo;
  const daily = $("game-mode").value === "daily";
  $("mode-label").textContent = daily
    ? "每日挑战 · 正式第 1 次 · 剩余 37 投"
    : "经典模式 · 1,282 分";
  $("rules-title").textContent = daily ? "每日挑战规则" : "经典玩法";
  $("rules-copy").textContent = daily
    ? "同一道题、相同投放序列，每局 100 投。正式机会每日 3 次，练习不限。最后一投后最多结算 8 秒。"
    : "相同的 Clawd 相碰会合成升级。左右瞄准、点击投放；危险线持续超时则结束。";
  $("footer-status").textContent = daily
    ? "游戏已暂停；正式截止不延长"
    : "游戏已暂停；关闭恢复原状态";
}
function persist() {
  if (storage === "ok") saved = { ...preferences };
  else if (storage === "read-error") storage = "write-error";
}
function change() {
  undo = null;
  persist();
  render();
}
function tab(settings) {
  $("settings").hidden = !settings;
  $("rules").hidden = settings;
  $("rules-tab").setAttribute("aria-pressed", String(!settings));
  $("settings-tab").setAttribute("aria-pressed", String(settings));
  document.querySelector(".panel-content").scrollTop = 0;
}
function open(settings) {
  tab(settings);
  render();
  panel.showModal();
  $("outside-status").textContent = "演示棋盘已暂停；原局保留";
  (settings ? $("settings-tab") : $("rules-tab")).focus();
}
$("open-settings").onclick = () => open(true);
$("help").onclick = () => open(false);
$("rules-tab").onclick = () => tab(false);
$("settings-tab").onclick = $("rules-settings").onclick = () => tab(true);
$("done").onclick = $("close").onclick = () => panel.close();
panel.addEventListener("close", () => {
  $("outside-status").textContent = "演示棋盘恢复原状态；设置选择保留";
});
for (const r of document.querySelectorAll("[name=motion]"))
  r.onchange = () => {
    preferences.motion = r.value;
    change();
  };
for (const k of ["shake", "particles", "haptics"])
  $(k).onchange = () => {
    preferences[k] = $(k).checked;
    change();
  };
$("reset").onclick = () => {
  undo = { ...preferences };
  preferences = defaults();
  persist();
  render();
};
$("undo").onclick = () => {
  preferences = undo;
  undo = null;
  persist();
  render();
  $("reset").focus();
};
$("retry").onclick = () => {
  if (storage === "read-error") preferences = { ...saved };
  else saved = { ...preferences };
  storage = "ok";
  render();
  $("done").focus();
};
$("system").onchange = (e) => {
  systemReduced = e.target.checked;
  render();
};
$("game-mode").onchange = render;
$("wire").onchange = (e) =>
  document.body.classList.toggle("wire", e.target.checked);
$("scenario").onchange = (e) => {
  preferences = defaults();
  saved = defaults();
  systemReduced = false;
  supported = true;
  storage = "ok";
  undo = null;
  const s = e.target.value;
  if (["system-reduced", "manual-standard"].includes(s)) systemReduced = true;
  if (s === "manual-reduced") preferences.motion = "reduced";
  if (s === "manual-standard") preferences.motion = "standard";
  if (s === "custom") preferences.shake = false;
  if (s === "unsupported") supported = false;
  if (s === "write-error") storage = "write-error";
  if (s === "read-error") storage = "read-error";
  render();
  if (!panel.open) open(true);
  else tab(true);
};
$("preview-button").onclick = () => {
  const e = effective(),
    stage = $("preview-stage");
  clearTimeout(timer);
  stage.className = "";
  void stage.offsetWidth;
  stage.className = matchMedia("(prefers-reduced-motion: reduce)").matches
    ? ""
    : `preview-animate ${e.shake ? "shake" : ""} ${e.particles ? "dust" : ""} ${!e.reduced ? "pop" : ""}`;
  $("preview-feedback").textContent =
    `${e.reduced ? "已预览静态合成提示" : "已预览一次合成"}。震动偏好${preferences.haptics ? "开启" : "关闭"}，此演示不会调用设备震动。`;
  timer = setTimeout(() => {
    stage.className = "";
  }, 650);
};
drawCrabIcon($("board-crab"), 7, 110, 90, 2);
drawCrabIcon($("preview-crab"), 7, 70, 55, 2);
render();

$("simulate-system").onclick = () => {
  systemReduced = !systemReduced;
  render();
};
$("simulate-reload").onclick = () => {
  preferences = storage === "read-error" ? defaults() : { ...saved };
  undo = null;
  render();
};
