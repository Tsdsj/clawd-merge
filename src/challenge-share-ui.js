import {
  parseChallengeLink,
  invitationDefinition,
  renderShareCard,
  shareImage,
} from "./challenge-share.js";

export function createChallengeShareUI({ pause, getToday, enter, summary }) {
  const dialog = document.createElement("dialog");
  dialog.className = "daily-dialog challenge-share-dialog";
  const title = document.createElement("h2"),
    copy = document.createElement("p"),
    content = document.createElement("div"),
    actions = document.createElement("div"),
    status = document.createElement("p");
  title.id = "challenge-share-title";
  dialog.setAttribute("aria-labelledby", title.id);
  status.setAttribute("role", "status");
  const close = document.createElement("button");
  close.className = "link-btn";
  close.textContent = "返回游戏";
  close.onclick = () => dialog.close();
  dialog.append(title, copy, content, actions, status, close);
  document.body.append(dialog);
  let revision = 0,
    objectUrl = null,
    invitation = parseChallengeLink(location.hash);
  const release = () => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  };
  function reset(heading, description) {
    revision++;
    release();
    title.textContent = heading;
    copy.textContent = description;
    content.replaceChildren();
    actions.replaceChildren();
    status.textContent = "";
    pause(true);
    if (!dialog.open) dialog.showModal();
    dialog.scrollTop = 0;
    return revision;
  }
  dialog.addEventListener("close", () => {
    if (dialog.open) return;
    revision++;
    release();
    pause(false);
  });
  // Keyboard events inside this native dialog must not trigger game shortcuts.
  dialog.addEventListener("keydown", (e) => e.stopPropagation());
  dialog.addEventListener("keyup", (e) => e.stopPropagation());
  const button = (label, handler, ghost = false) => {
    const b = document.createElement("button");
    b.className = `btn daily-primary${ghost ? " ghost" : ""}`;
    b.textContent = label;
    b.onclick = handler;
    actions.append(b);
    return b;
  };
  const message = (text) => {
    const p = document.createElement("p");
    p.textContent = text;
    content.append(p);
    return p;
  };
  async function result(model) {
    const v = reset("分享这一局", "同一道题，你能合到多少分？");
    const note = message("正在生成图片…"),
      link = document.createElement("textarea");
    link.readOnly = true;
    link.value = model.url;
    link.setAttribute("aria-label", "同题挑战链接");
    link.className = "share-link";
    const details = document.createElement("details"),
      label = document.createElement("summary");
    label.textContent = "查看与手动复制链接";
    details.append(label, link);
    content.append(details);
    button(
      "复制挑战链接",
      async () => {
        try {
          await navigator.clipboard.writeText(model.url);
          if (v === revision) status.textContent = "挑战链接已复制。";
        } catch {
          if (v !== revision) return;
          details.open = true;
          link.focus();
          link.select();
          status.textContent = "无法自动复制，请复制已选中的链接。";
        }
      },
      true,
    );
    try {
      const image = await renderShareCard(model);
      if (v !== revision || !dialog.open) return;
      note.remove();
      image.canvas.className = "share-canvas";
      image.canvas.setAttribute("role", "img");
      image.canvas.setAttribute(
        "aria-label",
        `${model.name}，${model.score} 分，${model.status}，${model.challengeId}`,
      );
      content.prepend(image.canvas);
      const p = document.createElement("p");
      p.className = "daily-sub";
      p.textContent = "图片在本机生成。目标分由分享者提供，不代表官方排名。";
      content.insertBefore(p, details);
      objectUrl = URL.createObjectURL(image.blob);
      const url = objectUrl;
      let capable = false;
      try {
        capable = Boolean(
          image.file &&
          navigator.canShare?.({ files: [image.file] }) &&
          navigator.share,
        );
      } catch {}
      if (capable) {
        const b = button("分享图片与链接", async () => {
          b.disabled = true;
          const outcome = await shareImage(navigator, image.file, model.url);
          if (v !== revision) return;
          b.disabled = false;
          status.textContent = {
            shared: "已交给系统分享。",
            cancelled: "",
            failed: "系统分享未完成，可以保存图片或复制链接。",
            unsupported: "此设备暂不支持直接分享图片，可以保存图片或复制链接。",
          }[outcome];
        });
        actions.prepend(b);
      } else
        status.textContent = "此设备不支持直接分享图片。可保存图片并复制链接。";
      button(
        "保存图片",
        () => {
          const a = document.createElement("a");
          a.href = url;
          a.download = `clawd-${model.challengeId}-${model.score}.png`;
          a.click();
          status.textContent =
            "已请求保存；若未出现下载，可使用下方图片预览长按保存。";
        },
        true,
      );
      const preview = document.createElement("details"),
        summaryEl = document.createElement("summary"),
        img = document.createElement("img");
      summaryEl.textContent = "无法下载？展开图片，长按或右键保存";
      img.src = url;
      img.alt = "成绩卡，可长按或右键保存";
      img.className = "share-canvas";
      preview.append(summaryEl, img);
      content.append(preview);
    } catch {
      if (v !== revision) return;
      note.textContent = "图片暂时生成失败。仍可复制链接，或重新生成。";
      button("重新生成图片", () => void result(model), true);
    }
  }
  async function showInvitation() {
    if (invitation.kind === "none") return;
    const v = reset("收到一个同题挑战", "正在核验题目日期和规则…");
    if (invitation.kind === "invite" && invitation.target !== null) {
      const target = message(
        `朋友的目标分：${invitation.target.toLocaleString("zh-CN")}`,
      );
      target.className = "share-target";
      message("分享者填写 · 未经核验").className = "daily-sub";
    }
    message(summary());
    let resolved = invitation;
    if (invitation.kind === "invite") {
      try {
        const today = await getToday();
        if (v !== revision) return;
        resolved = invitationDefinition(invitation, today);
      } catch {
        resolved = { kind: "offline" };
      }
    }
    if (v !== revision || !dialog.open) return;
    const descriptions = {
      invalid: "链接中的日期、规则或目标分格式有误。原局没有改变。",
      unsupported: "当前版本不支持这道题的规则，不会用新规则替换。",
      future: "这是尚未开放的题目，请返回游戏查看今日挑战。",
      offline: "暂时无法核验题目。请重试，或返回原来的游戏。",
      today: "今日题目已由服务器确认。正式挑战使用你自己的身份和机会。",
      practice: "这是往期题目，只能练习，不参与今日排名。",
    };
    title.textContent = ["today", "practice"].includes(resolved.kind)
      ? `${invitation.challengeId} · 同题挑战`
      : "收到一个同题挑战";
    copy.textContent = descriptions[resolved.kind] || "链接暂时无法使用。";
    if (["today", "practice"].includes(resolved.kind)) {
      const go = async (formal) => {
        dialog.close();
        const ok = await enter(resolved.definition, formal);
        if (!ok) {
          reset(
            "暂时无法进入挑战",
            "请先处理当前窗口或保存问题，再通过“好友邀请”重新打开。本次没有扣除次数或替换原局。",
          );
        }
      };
      if (resolved.kind === "today")
        button("查看今日正式挑战", () => void go(true));
      button(
        "练这道题 · 不参与排名",
        () => void go(false),
        resolved.kind === "today",
      );
      message("查看邀请不扣次数。开始新局前会确认是否替换原局。").className =
        "daily-sub";
    }
    if (resolved.kind === "offline")
      button("重新核验题目", () => void showInvitation());
  }
  const links = [...document.querySelectorAll("[data-challenge-invite]")];
  function reflect() {
    for (const b of links) {
      b.classList.toggle("hidden", invitation.kind === "none");
      b.onclick = () => void showInvitation();
    }
  }
  reflect();
  window.addEventListener("hashchange", () => {
    invitation = parseChallengeLink(location.hash);
    reflect();
    if (invitation.kind !== "none") void showInvitation();
  });
  window.addEventListener("pagehide", release);
  return { result, openInvitation: showInvitation };
}
