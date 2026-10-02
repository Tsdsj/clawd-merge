// Design demonstration only. No storage, API, clipboard, file download or Web Share calls.
import { drawCrabIcon } from "../../../src/crabs.js";
const $ = (id) => document.getElementById(id);
const show = (id, visible) => {
  $(id).hidden = !visible;
};
const say = (copy) => {
  $("feedback").textContent = copy;
};
let state = "result";
function render(next) {
  state = next;
  $("scenario").value = next;
  say("");
  const receiving = [
    "invite",
    "old",
    "offline",
    "invalid",
    "version",
    "loading",
  ].includes(next);
  show("result", next === "result");
  show("share", next !== "result" && !receiving);
  show("invite", receiving);
  $("badge").textContent =
    next === "practice"
      ? "练习 · 不参与排名"
      : next === "pending"
        ? "正式 · 待提交"
        : "正式 · 已提交";
  $("player").textContent =
    next === "long" ? "今天也要合出最大一只Clawd的橙色钳子朋友" : "橙色钳子";
  show("card", !["error", "generating"].includes(next));
  show("image-loading", next === "generating");
  show("finish-image", next === "generating");
  show("image-error", next === "error");
  show("retry-image", next === "error");
  show("native-share", !["fallback", "error", "generating"].includes(next));
  show("save", !["error", "generating"].includes(next));
  $("share-note").textContent =
    next === "pending"
      ? "成绩仍在等待提交，卡片保留“待提交”标记；分享不影响补传。"
      : next === "practice"
        ? "练习成绩可以分享，但不参与正式排名。"
        : next === "fallback"
          ? "此设备不支持直接分享图片。可以保存图片，再复制链接。"
          : "图片在本机生成。目标分由分享者提供，不代表官方排名。";
  const texts = {
    loading: [
      "正在核验这道题",
      "确认题目日期和规则中…",
      "核验完成前不开放正式开局。查看邀请不会扣除机会，也不会替换原局。",
    ],
    invite: [
      "10 月 03 日，来试一局",
      "今日题目已由服务器确认",
      "相同投放序列，共 100 投。正式挑战使用你自己的身份和今日机会。",
    ],
    old: [
      "再试 10 月 02 日这道题",
      "这是往期题目 · 仅供练习",
      "按原题目和规则复现投放序列，不占用今日机会，也不进入今日榜。",
    ],
    offline: [
      "暂时无法核验题目",
      "连接失败 · 原局仍然保留",
      "不要按设备日期认定为今日正式题。重试成功后再选择正式或练习。",
    ],
    invalid: [
      "这个挑战链接无法识别",
      "题目日期或目标分格式有误",
      "没有开始对局，也没有改动你的存档。可以回到自己的游戏。",
    ],
    version: [
      "这道题的规则暂不支持",
      "链接使用了当前版本未知的规则",
      "不会用新规则替代旧规则生成另一道题。请回到游戏，尝试今日挑战。",
    ],
  };
  if (receiving) {
    const t = texts[next];
    $("invite-title").textContent = t[0];
    $("invite-status").textContent = t[1];
    $("invite-description").textContent = t[2];
  }
  document.querySelector(".target").hidden = ["invalid", "version"].includes(
    next,
  );
  show("finish-check", next === "loading");
  show("formal", next === "invite");
  show("practice-invite", ["invite", "old"].includes(next));
  show("retry-invite", next === "offline");
  drawCrabIcon($("result-crab"), 9, 132, 112, devicePixelRatio);
  drawCrabIcon($("card-crab"), 9, 88, 78, devicePixelRatio);
}
$("scenario").onchange = (e) => render(e.target.value);
$("wire").onchange = (e) =>
  document.body.classList.toggle("wire", e.target.checked);
$("open-share").onclick = () => render("share");
$("back").onclick = () => render("result");
$("open-invite").onclick = () => render("invite");
$("native-share").onclick = () => {
  $("dialog-title").textContent = "系统分享（演示）";
  $("dialog-copy").textContent =
    "正式接入后，这里由系统选择分享目标；用户取消会回到预览，不提示分享成功。此原型不会打开外部应用。";
  $("cancel-dialog").textContent = "取消分享";
  $("confirm-dialog").hidden = true;
  $("dialog").showModal();
};
$("save").onclick = () =>
  say("演示：生成 PNG 并保存；若浏览器只能预览图片，提供长按保存说明。");
$("copy").onclick = () =>
  say(
    "演示：复制同题链接；剪贴板不可用时展示可选中的链接供手动复制。原型未改动剪贴板。",
  );
$("finish-image").onclick = () => render("share");
$("finish-check").onclick = () => render("invite");
$("retry-image").onclick = () => {
  render("share");
  say("演示：图片已重新生成。");
};
$("retry-invite").onclick = () => {
  render("invite");
  say("演示：题目核验成功，尚未领取正式凭证。");
};
$("formal").onclick = () =>
  say(
    "演示：进入已确认的每日入口，显示你自己的身份和剩余次数；点击正式开局并确认后才领取凭证。",
  );
$("practice-invite").onclick = () => {
  $("dialog-title").textContent = "替换当前挑战存档？";
  $("dialog-copy").textContent =
    "当前挑战还有 37 投。开始这道题的练习会替换它；若原局为正式，已用机会不退回。经典局保留。";
  $("cancel-dialog").textContent = "保留原局";
  $("confirm-dialog").hidden = false;
  $("dialog").showModal();
};
$("cancel-dialog").onclick = () => $("dialog").close();
$("confirm-dialog").onclick = () => {
  $("dialog").close();
  say(
    `演示：进入 ${state === "old" ? "10 月 02 日" : "10 月 03 日"} 原题练习，真实存档没有变化。`,
  );
};
$("home").onclick = () =>
  say("演示：关闭邀请，回到原来的游戏；未扣机会、未替换存档。");
$("again").onclick = () => say("沿用 T09 / T10 的再次挑战与机会确认流程。");
$("board").onclick = () =>
  say("沿用 T10 的今日榜与个人名次。分享卡不固定展示会变化的名次。");
render("result");
