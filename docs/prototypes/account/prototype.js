import { drawCrabIcon } from "../../../src/crabs.js";
const $ = (id) => document.getElementById(id);
const panel = $("panel");
const scenes = {
  entry: "加入排行榜",
  register: "注册 · 确认名字",
  reserve: "注册 · 确认完整账号",
  success: "注册成功 · 保存恢复码",
  login: "密码登录",
  guest: "游客账号",
  password: "密码账号",
  linuxdo: "Linux.do 账号",
  linked: "双登录方式账号",
  recover: "找回账号",
  reset: "验证后设置新密码",
  bind: "绑定前验证",
  bindConfirm: "绑定确认",
  conflict: "绑定冲突",
  rename: "修改公开昵称",
  change: "修改密码",
  rotate: "更换恢复码",
  wrong: "账号或密码错误",
  limited: "登录限流",
  timeout: "登录超时",
  loading: "请求中",
  uncertain: "注册结果未知",
  expired: "恢复凭据已过期",
  storage: "登录状态保存失败",
  intentStorage: "注册准备保存失败",
  blocked: "名称暂不可用",
  unavailable: "密码入口暂不可用",
  long: "长昵称与不同编号",
  guard: "切换账号前处理对局",
  oauth: "Linux.do 验证演示",
};
let screen = "entry",
  kind = "guest",
  originKind = "guest",
  handle = "小螃蟹#4821",
  nickname = "小螃蟹",
  flow = "register",
  timer,
  countdown,
  beforePause = false,
  currentPaused = false,
  pendingAction = "login",
  previousScreen = "entry",
  saveScreen = "success";
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const btn = (label, action, cls = "secondary full") =>
  `<button type="button" class="${cls}" data-action="${action}">${label}</button>`;
const note = (text, type = "") =>
  `<div class="notice ${type}" ${type === "error" ? 'role="alert"' : ""}>${text}</div>`;
const field = (label, id, type = "text", value = "", hint = "") =>
  `<label class="field" for="${id}">${label}<input id="${id}" name="${id}" type="${type}" value="${escape(value)}" autocomplete="${id === "account" ? "username" : "off"}" ${id === "account" ? 'autocapitalize="none" spellcheck="false"' : ""} required>${hint ? `<span class="hint">${hint}</span>` : ""}</label>`;
const password = (id = "pass", label = "密码", fresh = false) =>
  `<label class="field" for="${id}">${label}<span class="password"><input id="${id}" name="${id}" type="password" autocomplete="${fresh ? "new-password" : "current-password"}" required aria-describedby="${id}-hint"><button type="button" data-show="${id}" aria-label="显示${label}" aria-pressed="false">显示</button></span><span id="${id}-hint" class="hint">${fresh ? "15—128 个字符，空格和大小写都会保留。支持粘贴。" : "支持粘贴与密码管理器。"}</span></label>`;
const submit = (label) =>
  `<p id="error" class="inline-error" role="alert"></p><button type="submit" class="primary full">${label}</button>`;
const back = (target = "entry") => btn("返回", target, "link full");
const form = (id, body) =>
  `<form data-form="${id}">${body.includes('type="password"') && !body.includes('id="account"') ? `<input type="text" name="username" autocomplete="username" value="${escape(handle)}" hidden>` : ""}${body}</form>`;
const accountCard = () =>
  `<div class="credentials"><span class="hint">固定登录账号 · 改昵称不会改变它</span><strong class="value">${escape(handle)}</strong>${btn("复制完整账号", "copyHandle", "secondary full")}</div>`;
const recoveryCard = () =>
  `<div class="credentials"><span class="hint">一次性恢复码 · 演示文本，不可用于登录</span><strong class="value code">DEMO-ONLY-CLAWD-4821</strong>${btn("复制演示恢复码", "copyCode", "secondary full")}</div>`;
function show(next, open = true) {
  clearTimeout(timer);
  clearInterval(countdown);
  previousScreen = screen;
  screen = next;
  $("step").textContent = ["register", "reserve", "intentStorage"].includes(
    next,
  )
    ? "创建账号 / " + (next === "register" ? "1 · 选择名字" : "2 · 设置密码")
    : "你的 Clawd 身份";
  const titles = {
    register: "创建密码账号",
    reserve: "设置密码",
    intentStorage: "设置密码",
    success: "请保存账号信息",
    storage: "请保存账号信息",
    guest: "我的账号",
    password: "我的账号",
    linuxdo: "我的账号",
    linked: "我的账号",
    long: "我的账号",
    wrong: "登录已有账号",
    limited: "登录已有账号",
    timeout: "登录已有账号",
    loading: "登录已有账号",
    blocked: "创建密码账号",
    uncertain: "正在确认创建结果",
    expired: "请使用完整账号登录",
    bind: "验证当前账号",
    reset: "设置新密码",
  };
  $("title").textContent = titles[next] || scenes[next] || "账号管理";
  $("foot").textContent = "不会创建真实账号";
  let html = "";
  if (next === "entry")
    html = `<p>换设备，也能找回你的成绩。</p>${btn("登录已有账号", "login", "primary full")}${btn("创建密码账号", "register")}<div class="divider">也可以</div>${btn("使用 Linux.do 继续", "oauthLogin")}<div class="row">${btn("先用游客玩", "guestCreate", "link")}${btn("暂不加入，继续本地玩", "close", "link")}</div><p class="hint">账号保存排行榜成绩与历史，不同步棋盘。</p>`;
  if (next === "register" || next === "blocked")
    html = `<p>名字可以相同，系统会为你分配专属编号。</p>${next === "blocked" ? note("这个名字暂不可用，请换一个试试。", "error") : ""}${form("register", field("注册名", "name", "text", nickname, "2—12 个字符；名字和编号一起构成登录账号。") + submit("确认名字，获取编号"))}<p class="hint">${kind === "guest" ? "当前游客的成绩会保留在同一账号中。" : "保留当前玩家、成绩和历史。"}</p>${back()}`;
  if (next === "reserve" || next === "intentStorage")
    html = `<p>请记住完整账号，包括 # 后的四位编号。</p>${accountCard()}${next === "intentStorage" ? note("未能保存注册准备信息。请先复制完整账号，再确认本次临时继续；还没有提交密码。", "error") : ""}${form("reserve", password("pass", "设置密码", true) + password("confirm", "再次输入密码", true) + (next === "intentStorage" ? '<label class="check"><input type="checkbox" required>我已另行保存完整账号，了解本页关闭后需用它登录。</label>' : "") + submit("创建账号并保留成绩"))}${back("register")}`;
  if (
    next === "login" ||
    ["wrong", "limited", "timeout", "loading"].includes(next)
  ) {
    const error = {
      wrong: "账号或密码不正确，请检查完整账号与密码。",
      limited: "尝试过于频繁，请在 30 秒后再试。",
      timeout: "连接超时，尚未确认登录成功。你可以重试。",
      loading: "正在验证登录，请稍候…",
    }[next];
    html = `<p>输入完整账号，包含 # 后的四位编号。</p>${error ? note(error, next === "loading" ? "" : "error") : ""}${form("login", field("登录账号", "account", "text", handle, "例如：小螃蟹#4821") + password() + submit(next === "limited" ? "30 秒后重试" : next === "loading" ? "正在登录…" : "登录"))}<div class="row">${btn("忘记账号或密码", "recover", "link")}${btn("创建账号", "register", "link")}</div><div class="divider">其他登录方式</div>${btn("使用 Linux.do 登录", "oauthLogin")}${next === "loading" ? btn("取消等待", "cancel", "link full") : back()}`;
  }
  if (["guest", "password", "linuxdo", "linked", "long"].includes(next)) {
    kind = next === "long" ? "linked" : next;
    originKind = kind;
    const names = {
      guest: "游客 · 仅当前设备",
      password: "密码账号",
      linuxdo: "Linux.do 账号",
      linked: "密码 + Linux.do",
    };
    if (next === "long") {
      nickname = "在月亮背面散步的小螃蟹";
      handle = "小螃蟹#4821";
    }
    html = `<div class="identity"><div class="avatar" aria-hidden="true"><canvas id="avatar-crab"></canvas></div><div><strong>${escape(nickname)}<span class="hint">#${next === "long" ? "6073" : "4821"}</span></strong><small>${names[kind]}</small></div></div>${kind === "guest" ? note("游客没有密码。清除浏览器数据或换设备后，可能无法找回。") : ""}${["password", "linked"].includes(kind) ? accountCard() : ""}<div class="list"><div><span>经典最佳<strong class="sub">1,282 分 · 12 局</strong></span><span>每日挑战<strong class="sub">6 次完成</strong></span></div><div><span>公开昵称<span class="sub">${kind === "linuxdo" ? "跟随 Linux.do；设置本地账号后可自主修改" : "改名不改变固定登录账号"}</span></span>${kind === "linuxdo" ? "" : btn("修改", "rename", "secondary")}</div><div><span>密码登录<span class="sub">${["guest", "linuxdo"].includes(kind) ? "尚未设置" : "已设置"}</span></span>${btn(["guest", "linuxdo"].includes(kind) ? "设置" : "修改", ["guest", "linuxdo"].includes(kind) ? "setPassword" : "change", "secondary")}</div><div><span>Linux.do<span class="sub">${["linuxdo", "linked"].includes(kind) ? "已连接 · 不支持解绑" : "尚未绑定"}</span></span>${["linuxdo", "linked"].includes(kind) ? '<span class="pill">已连接</span>' : btn("绑定", kind === "guest" ? "guestBind" : "bind", "secondary")}</div>${kind !== "guest" ? `<div><span>一次性恢复码<span class="sub">旧码不再显示，更换后失效</span></span>${btn("更换", "rotate", "secondary")}</div>` : ""}</div>${btn("退出当前账号", "logout", "link full")}<p class="hint">退出不会删除历史成绩；其他设备保持登录。</p>`;
  }
  if (next === "success" || next === "storage")
    html = `<div class="center"><span class="success-mark">✓</span><h3 style="margin-top:12px">${flow === "recover" ? "密码已重设" : flow === "rotate" ? "恢复码已更换" : "账号准备好了"}</h3><p class="hint">${flow === "recover" ? "旧密码、旧会话和旧恢复码已失效。" : "当前玩家和历史成绩保留。"}</p></div>${next === "storage" ? note("未能保存登录状态。本页可以继续玩，刷新或关闭后需重新登录。请先保存下面的信息。", "error") : ""}${kind === "linuxdo" ? note("此账号通过 Linux.do 登录，尚未设置本地密码账号。") : accountCard()}${recoveryCard()}<p class="hint">恢复码只显示这一次。请保存在密码管理器或其他安全位置；使用后失效。</p><label class="check"><input id="saved" type="checkbox">我已保存完整账号和恢复码</label>${btn("保存好了，继续玩", "finish", "primary full")}${next === "storage" ? btn("重试保存登录状态", "retryStorage") : ""}`;
  if (next === "recover")
    html = `<p>不使用邮箱或短信。请选择你已有的恢复方式。</p>${form("recover", field("完整登录账号", "account", "text", handle) + field("一次性恢复码", "code", "text", "", "输入之前保存的恢复码。") + submit("验证恢复码"))}<div class="divider">已绑定 Linux.do</div>${btn("通过 Linux.do 验证并恢复", "oauthRecover")}<details><summary>忘记编号，或没有恢复方式？</summary><p class="hint">先检查密码管理器、注册时保存的完整账号。本页不会查询同名账号或列出编号。若已绑定 Linux.do，可用它登录；如果两种恢复方式都没有，无法凭昵称、分数或截图找回。</p></details>${back("login")}`;
  if (next === "reset" || next === "change")
    html = `${note(next === "reset" ? "身份验证已完成，请设置新密码。" : "修改后，所有旧会话会退出，并生成新的恢复码。")}${form("reset", (next === "change" ? password("old", "当前密码") : "") + password("pass", "新密码", true) + password("confirm", "再次输入新密码", true) + submit("确认并保存新密码"))}${back(next === "change" ? kind : "recover")}`;
  if (next === "bind")
    html = `<p>先验证当前密码，再前往 Linux.do 连接身份。</p>${note("绑定后两种方式都进入当前账号。不会合并另一正式账号的成绩。")}${form("bind", password() + submit("验证并继续"))}${back(kind)}`;
  if (next === "bindConfirm")
    html = `<h3>为当前账号添加 Linux.do</h3>${accountCard()}${note("保留当前登录账号、公开昵称、编号、历史与棋盘。Linux.do 后续改名不会覆盖本地昵称。")}<p class="hint">若这个 Linux.do 已属于其他正式账号，本次绑定会被拒绝。目前不支持解绑。</p>${btn("前往 Linux.do 授权", "oauthBind", "primary full")}${back(kind)}`;
  if (next === "conflict")
    html = `${note("这个 Linux.do 已关联其他正式账号，无法绑定到当前账号。", "error")}<p>当前账号、成绩和棋盘均已保留，没有合并。</p>${btn("返回当前账号", "password", "primary full")}${btn("退出后登录其他账号", "switch", "secondary full")}<p class="hint">不会展示另一账号的名字或成绩。</p>`;
  if (next === "rename")
    html = `<p>公开昵称会出现在排行榜和新分享卡中。</p>${form("rename", field("公开昵称", "name", "text", nickname, "2—12 个字符；可能会分配新的公开编号。") + submit("保存公开昵称"))}${kind !== "guest" ? note(`固定登录账号仍为 ${escape(handle)}。`) : ""}${back(kind)}`;
  if (next === "rotate")
    html = `${note("更换后，旧恢复码立即失效。请在下一步保存新码。")}${["linuxdo", "linked"].includes(kind) ? btn("用 Linux.do 重新验证", "oauthRotate", "primary full") : form("rotate", password() + submit("验证并更换恢复码"))}${back(kind)}`;
  if (next === "uncertain")
    html = `${note("提交后没有收到确认，账号可能已经创建。", "error")}${accountCard()}<p>先检查本次结果，请勿重复注册。</p>${btn("检查本次创建结果", "checkResult", "primary full")}${btn("模拟回执已过期", "expired", "link full")}<p class="hint">使用同一次创建记录检查，不会创建第二个账号。</p>`;
  if (next === "expired")
    html = `${note("本次结果已无法重新读取。", "error")}${accountCard()}<p>请使用刚才保存的账号和设置的密码尝试登录。不要重新注册；仍无法登录时进入恢复流程。</p>${btn("前往登录", "login", "primary full")}${btn("找回账号", "recover")}`;
  if (next === "unavailable")
    html = `${note("密码服务暂不可用，请稍后再试。", "error")}<p>你仍可在本地继续玩，也可以尝试 Linux.do 登录。</p>${btn("使用 Linux.do", "oauthLogin")}${btn("继续本地玩", "close", "primary full")}`;
  if (next === "guard") {
    const game = $("game").value;
    const copies = {
      idle: "切换后进入另一账号；当前账号的历史仍归原账号。",
      classic:
        "当前在线局属于原账号。切换前，可明确将这一局转为本地继续；它将不再上传排行榜。",
      daily:
        "当前每日正式局尚未完成。请先回到原账号完成或明确结束本局，不能转交给另一账号。",
      unknown: "开局是否成功还不确定。请先回到游戏核对开局结果，再切换账号。",
      pending:
        "原账号还有待上传记录。请先处理上传；无法安全保存的记录会阻止切换。",
    };
    html = `${note(copies[game])}${btn("回到当前游戏", "close", "primary full")}${game === "classic" ? btn("本局转为本地，再继续", "guardContinue") : game === "idle" ? btn("确认继续", "guardContinue") : ""}<p class="hint">关闭账号面板会恢复打开前的暂停状态；每日截止时间不会延长。</p>`;
  }
  if (next === "oauth")
    html = `<p>正式版本将在 Linux.do 完成授权后返回。</p>${note("这里仅演示验证结果，不会打开第三方网页。")}<div class="stack">${btn("模拟验证通过", "oauthDone", "primary full")}${btn("模拟拒绝授权", "oauthDeny")}${flow === "bind" ? btn("模拟账号已被占用", "conflict") : ""}${flow === "guestBind" ? btn("模拟进入已有 Linux.do 账号", "guestMerge") : ""}</div>${btn("取消", "cancelOAuth", "link full")}<p class="hint">取消或失败会保留原账号与对局；验证不等于承诺上游要求重新输入密码。</p>`;
  if (next === "leave") {
    $("title").textContent = "还没有保存恢复信息";
    html =
      note(
        "关闭后将无法再次查看这份恢复码。建议先保存完整账号和恢复码。",
        "error",
      ) +
      btn("返回保存信息", "returnSave", "primary full") +
      btn("知道了，仍然关闭", "leaveAnyway");
  }
  $("content").innerHTML = html;
  if ($("avatar-crab")) drawCrabIcon($("avatar-crab"), 1, 40, 36, 2);
  if (open && !panel.open) {
    beforePause = $("paused").checked;
    currentPaused = true;
    panel.showModal();
    updatePause();
  }
  const focus = $("content").querySelector("input:not([type=checkbox]),button");
  (focus || $("close")).focus();
  if (next === "success" || next === "storage")
    $("content").querySelector("[data-action=finish]").disabled = true;
  if (next === "limited") {
    let remaining = 30;
    const b = $("content").querySelector("button[type=submit]");
    b.disabled = true;
    countdown = setInterval(() => {
      remaining--;
      b.textContent = remaining > 0 ? `${remaining} 秒后重试` : "登录";
      if (remaining === 0) {
        b.disabled = false;
        clearInterval(countdown);
      }
    }, 1000);
  }
  if (next === "loading") {
    $("content").querySelector("button[type=submit]").disabled = true;
    timer = setTimeout(() => show("timeout"), 3500);
  }
  $("content").scrollTop = 0;
}
function updatePause() {
  $("game-status").textContent = currentPaused
    ? "演示棋盘已暂停"
    : "演示棋盘未暂停";
}
function close(force = false) {
  if (
    !force &&
    ["success", "storage"].includes(screen) &&
    !$("saved")?.checked
  ) {
    saveScreen = screen;
    show("leave");
    return;
  }
  if (!force && screen === "leave") {
    show(saveScreen);
    return;
  }
  clearTimeout(timer);
  clearInterval(countdown);
  panel.close();
  currentPaused = beforePause;
  updatePause();
  $("open").focus();
}
function guard(action) {
  pendingAction = action;
  show("guard");
}
function freshEnough() {
  const a = $("pass").value,
    b = $("confirm").value;
  if ([...a].length < 15 || [...a].length > 128)
    return "密码需为 15—128 个字符。";
  if (a !== b) return "两次输入的密码不一致。";
  return "";
}
function error(text) {
  $("error").textContent = text;
}
async function copy(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = "已复制";
  } catch {
    button.textContent = "复制失败，请长按上方文本手动复制";
  }
}
$("content").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.show) {
    const input = $(b.dataset.show);
    const visible = input.type === "password";
    input.type = visible ? "text" : "password";
    b.textContent = visible ? "隐藏" : "显示";
    b.setAttribute("aria-pressed", String(visible));
    b.setAttribute("aria-label", visible ? "隐藏密码" : "显示密码");
    return;
  }
  const a = b.dataset.action;
  if (!a) return;
  if (a === "close") return close();
  if (a === "returnSave") return show(saveScreen);
  if (a === "leaveAnyway") return close(true);
  if (a === "copyHandle") return copy(handle, b);
  if (a === "copyCode") return copy("DEMO-ONLY-CLAWD-4821", b);
  if (a === "register") {
    flow = "register";
    return show(a);
  }
  if (a === "setPassword") {
    flow = "set";
    if ($("game").value === "pending") return guard("setPassword");
    return kind === "linuxdo" ? show("oauth") : show("register");
  }
  if (a === "guestCreate") {
    kind = "guest";
    nickname = "小螃蟹";
    return show("guest");
  }
  if (a === "guestBind") {
    flow = "guestBind";
    return show("oauth");
  }
  if (a === "oauthLogin") {
    flow = "login";
    return $("game").value === "idle" ? show("oauth") : guard("oauthLogin");
  }
  if (a === "oauthRecover") {
    flow = "recover";
    return show("oauth");
  }
  if (a === "oauthRotate") {
    flow = "rotate";
    return show("oauth");
  }
  if (a === "oauthBind") {
    flow = "bind";
    return show("oauth");
  }
  if (a === "oauthDeny") {
    show(kind);
    $("content").insertAdjacentHTML(
      "afterbegin",
      note("授权未完成，原账号与对局已保留。", "error"),
    );
    return;
  }
  if (a === "cancelOAuth")
    return show(["recover", "login"].includes(flow) ? "login" : kind);
  if (a === "oauthDone") {
    if (flow === "recover") return show("reset");
    if (flow === "set") return show("register");
    if (flow === "rotate") return show("success");
    return show(flow === "bind" ? "linked" : "linuxdo");
  }
  if (a === "guestMerge") {
    pendingAction = "guestMerge";
    return show("guard");
  }
  if (a === "finish") {
    if (!$("saved").checked) return;
    $("scene").value = kind;
    return close();
  }
  if (a === "retryStorage") {
    show("success");
    $("content").insertAdjacentHTML(
      "afterbegin",
      note("演示：已成功保存登录状态。", "success"),
    );
    return;
  }
  if (a === "checkResult") {
    flow = "register";
    return show("success");
  }
  if (a === "logout" || a === "switch") return guard(a);
  if (a === "guardContinue") {
    if ($("game").value === "classic") $("game").value = "idle";
    if (pendingAction === "guestMerge") return show("linuxdo");
    if (pendingAction === "oauthLogin") return show("oauth");
    if (pendingAction === "loginComplete") return show("password");
    return show("login");
  }
  if (a === "cancel") return show("login");
  show(a);
});
$("content").addEventListener("change", (e) => {
  if (e.target.id === "saved")
    $("content").querySelector("[data-action=finish]").disabled =
      !e.target.checked;
});
$("content").addEventListener("submit", (e) => {
  e.preventDefault();
  const action = e.target.dataset.form;
  if (action === "register" || action === "rename") {
    const name = $("name").value.normalize("NFKC").trim();
    if ([...name].length < 2 || [...name].length > 12)
      return error("名字需为 2—12 个字符。");
    nickname = name;
    if (action === "rename") return show(kind);
    handle = `${name}#4821`;
    return show("reserve");
  }
  if (action === "reserve" || action === "reset") {
    const issue = freshEnough();
    if (issue) return error(issue);
    if (action === "reserve") {
      kind = originKind === "linuxdo" ? "linked" : "password";
    } else {
      flow = "recover";
      if (kind === "guest") kind = "password";
    }
    return show("success");
  }
  if (action === "login") {
    if (!/^.+#[0-9]{4}$/.test($("account").value))
      return error("请补全 # 和四位编号，不会查询或列出同名账号。");
    handle = $("account").value;
    return $("game").value === "idle"
      ? show("password")
      : guard("loginComplete");
  }
  if (action === "recover") {
    if (!/^.+#[0-9]{4}$/.test($("account").value))
      return error("请输入包含 # 和四位编号的完整登录账号。");
    if (!$("code").value.trim()) return error("请输入恢复码。");
    handle = $("account").value;
    flow = "recover";
    return show("reset");
  }
  if (action === "bind") return show("bindConfirm");
  if (action === "rotate") {
    flow = "rotate";
    return show("success");
  }
});
$("scene").innerHTML = Object.entries(scenes)
  .map(([id, label]) => `<option value="${id}">${label}</option>`)
  .join("");
$("scene").addEventListener("change", () => {
  flow = "register";
  kind = originKind = "guest";
  nickname = "小螃蟹";
  handle = "小螃蟹#4821";
  if (["success", "storage"].includes($("scene").value)) kind = "password";
  show($("scene").value);
});
$("open").addEventListener("click", () => show($("scene").value));
$("close").addEventListener("click", () => close());
panel.addEventListener("cancel", (e) => {
  e.preventDefault();
  close();
});
$("wire").addEventListener("change", () =>
  document.body.classList.toggle("wire", $("wire").checked),
);
$("paused").addEventListener("change", () => {
  currentPaused = $("paused").checked;
  updatePause();
});
// The isolated native dialog traps keyboard focus; these events never reach the demo board.
panel.addEventListener("keydown", (e) => {
  e.stopPropagation();
  if (e.key === "Escape") { e.preventDefault(); close(); return; }
  if (e.key !== "Tab") return;
  const controls = [
    ...panel.querySelectorAll(
      "button:not(:disabled),input:not(:disabled):not([type=hidden]),summary",
    ),
  ].filter((el) => el.getClientRects().length > 0);
  const first = controls[0],
    last = controls.at(-1);
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
});
drawCrabIcon($("crab"), 7, 110, 90, 2);
const initial = new URL(location.href).searchParams.get("scene");
if (initial && scenes[initial]) {
  $("scene").value = initial;
  if (["success", "storage"].includes(initial)) kind = "password";
  show(initial);
}
