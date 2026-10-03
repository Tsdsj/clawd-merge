import { Game, WORLD_W, WORLD_H, enableHaptics } from "./game.js";
import { drawCrabIcon, defOf } from "./crabs.js";
import { sfx } from "./audio.js";
import { PauseState } from "./pause.js";
import { getStorage } from "./storage.js";
import { ChallengeStore } from "./challenge-store.js";
import { ChallengeSession } from "./challenge-session.js";
import { SETTLE_SECONDS } from "./challenge.js";
import { ChallengeApi } from "./challenge-api.js";
import { ChallengeUploads } from "./challenge-uploads.js";
import { shareResult } from "./challenge-share.js";
import {renderPlayerChip} from "./player-identity.js";

export function createChallengeUI({
  scope,
  classicSummary,
  onEnter,
  onExit,
  getPlayer,
  request,
  requestIdentity,
  requestAccount,
  onShare,
  comfort,
  onHelp,
}) {
  const $ = (id) => document.getElementById(`daily-${id}`);
  const root = $("app"),
    board = $("board"),
    canvas = $("canvas"),
    dialog = $("dialog");
  const api = new ChallengeApi({
    request,
    getPlayer,
    storage: getStorage(),
    scope,
  });
  let uploads,
    loading = false,
    serviceError = "",
    loadVersion = 0,
    retryAt = 0,
    identityKey = "",
    dialogKind = "",
    dialogVersion = 0,
    recoveryError = "",
    lastReceiptKey;
  let active = false,
    view = "hub",
    session,
    last = performance.now(),
    pointer = null,
    aiming = false;
  let definition = api.cached(),
    nextDateCheck = 0,
    lastNext = undefined,
    lastRemaining,
    laidOutGame,
    layoutView,
    lastUiStatus;
  const keys = new Set();
  const pauses = new PauseState(syncPause);
  const store = new ChallengeStore({
    scope,
    storage: getStorage(),
    locks: navigator.locks,
    channelFactory:
      typeof BroadcastChannel === "function"
        ? (name) => new BroadcastChannel(name)
        : null,
  });
  const show = (id, visible) => $(id).classList.toggle("hidden", !visible);
  const dateLabel = (id) =>
    /^\d{4}-\d{2}-\d{2}$/.test(id)
      ? `${Number(id.slice(5, 7))} 月 ${Number(id.slice(8))} 日`
      : id;
  const current = () => session?.game;
  function clearInput() {
    aiming = false;
    keys.clear();
    if (current()) current().pendingDrop = false;
    if (pointer !== null && board.hasPointerCapture(pointer))
      board.releasePointerCapture(pointer);
    pointer = null;
  }
  function syncPause() {
    const game = current(),
      paused =
        !active ||
        view !== "play" ||
        pauses.paused ||
        Boolean(session?.handoffPaused) ||
        (formal() &&
          (session.checking ||
            (session.eligibility && session.eligibility !== "valid")));
    if (game && game.paused !== paused) {
      clearInput();
      game.setPaused(paused);
      last = performance.now();
    }
    updatePlay();
  }
  function ask(title, copy, choices, kind = "info") {
    dialogKind = kind;
    dialogVersion++;
    $("dialog-extra").replaceChildren();
    $("dialog-title").textContent = title;
    $("dialog-copy").textContent = copy;
    $("dialog-actions").replaceChildren(
      ...choices.map(([label, action, secondary]) => {
        const button = document.createElement("button");
        button.className = `btn${secondary ? " ghost" : ""}`;
        button.textContent = label;
        button.onclick = () => {
          dialog.close();
          action();
        };
        return button;
      }),
    );
    pauses.set("dialog", true);
    if (!dialog.open) dialog.showModal();
  }
  dialog.addEventListener("close", () => {
    if (dialog.open) return;
    dialogKind = "";
    pauses.set("dialog", false);
    if (view === "play") board.focus({ preventScroll: true });
  });
  function layout() {
    if (!active || view !== "play" || !current()) return;
    const rect = $("stage").getBoundingClientRect();
    const width = Math.floor(
      Math.min(rect.width - 6, ((rect.height - 6) * WORLD_W) / WORLD_H),
    );
    if (width <= 0) return;
    board.style.width = `${width}px`;
    board.style.height = `${(width * WORLD_H) / WORLD_W}px`;
    current().resize(
      width,
      (width * WORLD_H) / WORLD_W,
      Math.min(devicePixelRatio || 1, 3),
    );
    laidOutGame = current();
    layoutView = view;
    lastNext = undefined;
    updatePlay();
    current().render();
  }
  const formal = () => session?.record?.mode === "formal";
  const entryForResult = () =>
    session?.record ? uploads?.queue.findRound(session.record.roundId) : null;
  const remaining = () => api.data?.allowance?.remaining;
  const deadlineLabel = (t) =>
    new Date(t).toLocaleString("zh-CN", {
      timeZone: "Asia/Shanghai",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  function updatePlay() {
    const game = current();
    if (!game) return;
    $("score").textContent = String(game.score);
    if (lastRemaining !== game.drops) {
      $("remaining").replaceChildren(
        document.createTextNode(`${100 - game.drops} `),
        Object.assign(document.createElement("small"), {
          textContent: "/ 100",
        }),
      );
      lastRemaining = game.drops;
    }
    $("round-kind").textContent = formal()
      ? `正式 · 第 ${session.record.online.attempt} 次`
      : "练习 · 不参与排名";
    $("round-kind").classList.toggle("formal", formal());
    $("round-day").textContent = dateLabel(game.challenge.challengeId);
    $("next-label").textContent = game.next === null ? "已投完" : "下一个";
    show("next", game.next !== null);
    if (game.next !== null && lastNext !== game.next) {
      drawCrabIcon(
        $("next"),
        game.next,
        40,
        30,
        Math.min(devicePixelRatio || 1, 3),
      );
      lastNext = game.next;
    }
    $("claw").textContent = `钳子 ×${game.claws}`;
    $("claw").disabled =
      game.over ||
      game.settling ||
      game.paused ||
      (!game.claws && !game.clawMode);
    $("claw").classList.toggle("active", game.clawMode);
    board.classList.toggle("claw-mode", game.clawMode);
    board.classList.toggle("fever", game.fever);
    const blocked =
      formal() && session.eligibility && session.eligibility !== "valid";
    const paused = game.paused && view === "play" && !dialog.open;
    show("paused", paused);
    $("pause").textContent = blocked ? "确认资格" : paused ? "继续" : "暂停";
    $("pause-title").textContent = blocked
      ? session.eligibility === "expired"
        ? "正式截止已过"
        : session.checking
          ? "正在核验资格"
          : "等待原资格确认"
      : "已暂停";
    $("continue").textContent = blocked
      ? "处理正式资格"
      : formal()
        ? "继续正式挑战"
        : "继续练习";
    $("pause-copy").textContent = blocked
      ? "原棋盘已保留。联网核验或明确转为练习后继续。"
      : pauses.has("background")
        ? "离开时已暂停，准备好了再继续。"
        : formal()
          ? "游戏计时已暂停；正式提交截止不会延长。"
          : "棋盘与结算计时已暂停。";
    for (const id of ["pause", "restart", "home", "classic", "tab", "help"])
      $(id).disabled = Boolean(
        game.settling && view === "play" && !game.over && !blocked,
      );
    show("settling", game.settling && !paused);
    $("settle-time").textContent =
      `结算中 · ${Math.max(0, Math.ceil(SETTLE_SECONDS - game.challenge.settlingTime))} 秒`;
    const old =
      definition && game.challenge.challengeId !== definition.challengeId;
    show("midnight", Boolean(old) || formal());
    $("midnight").textContent = formal()
      ? `${old ? "正在进行旧题；" : ""}正式提交截止：北京时间 ${deadlineLabel(session.record.online.submitUntil)}。`
      : `这是 ${dateLabel(game.challenge.challengeId)} 的练习，仍按原题继续，不会中途换题。`;
    $("save-status").textContent =
      session.warning ||
      (session.temporary
        ? "临时练习 · 只保留在本页"
        : `挑战已保存 · ${new Date(session.record.savedAt).toLocaleTimeString("zh-CN")} · 经典局独立保留`);
    show("save-retry", Boolean(session.warning) && !session.temporary);
    $("sound").classList.toggle("muted", !sfx.enabled);
  }
  function paint() {
    if (!active || !session) return;
    const previousView = view;
    if (session.status !== "active") view = "hub";
    else if (current()?.over) view = "result";
    show("hub", view === "hub");
    show("play", view === "play");
    show("result", view === "result");
    renderPlayerChip($("identity"),getPlayer());
    $("date").textContent = definition
      ? dateLabel(definition.challengeId)
      : "今日挑战";
    $("classic-note").textContent = classicSummary();
    $("day-status").textContent = loading
      ? "正在读取服务器题目与正式机会…"
      : api.data
        ? "北京时间 00:00 换题 · 题目已由服务器确认"
        : definition
          ? "已缓存的练习题 · 尚未确认今日正式机会"
          : "尚未获取题目，可先继续经典模式";
    const budget = api.data?.allowance;
    $("attempts").textContent = budget
      ? `${budget.remaining} / 3 次`
      : api.data
        ? "先选择身份"
        : loading
          ? "读取中…"
          : "等待联网";
    $("attempts").classList.toggle("daily-coming", !budget);
    $("best").textContent = api.data?.me?.best
      ? `${api.data.me.best.toLocaleString("zh-CN")} 分`
      : "—";
    $("service-note").textContent =
      serviceError ||
      "正式机会每日 3 次；领取凭证成功才扣次。练习不限次数、不参与排名。";
    $("rank").disabled = !api.data;
    const list = uploads?.queue.list() || [];
    show("pending", list.length > 0);
    $("pending").textContent = `待处理 ${list.length}`;
    const saved = session.record?.game,
      busy = session.status === "busy",
      pending =
        Boolean(session.pendingIntent) || session.status === "intent-invalid";
    const hasSave =
      Boolean(saved) && ["saved", "active"].includes(session.status);
    show("resume", hasSave || pending);
    if (pending) {
      $("resume").textContent =
        session.status === "intent-invalid"
          ? "开局确认记录损坏，需要明确处理后才能重新开局。"
          : `有一次 ${dateLabel(session.pendingIntent.challengeId)} 开局尚未确认。可能已经扣次；重试沿用原请求，不会多扣。`;
    } else if (hasSave) {
      const b = document.createElement("b");
      b.textContent =
        saved.challenge.phase === "finished"
          ? "上次挑战已经结束"
          : session.record.mode === "formal"
            ? `继续正式第 ${session.record.online.attempt} 次，不再扣机会`
            : "有一局练习还没结束";
      $("resume").replaceChildren(
        b,
        document.createTextNode(
          `${dateLabel(saved.challenge.challengeId)} · ${saved.score} 分 · 剩余 ${100 - saved.drops} 投`,
        ),
      );
    }
    show("resume-btn", hasSave || busy || pending);
    $("resume-btn").disabled = Boolean(session.issuing || session.checking);
    $("resume-btn").textContent = busy
      ? "接管挑战对局"
      : pending
        ? session.status === "intent-invalid"
          ? "处理损坏的开局记录"
          : session.issuing
            ? "正在确认原开局…"
            : "继续确认这次开局"
        : saved?.challenge.phase === "finished"
          ? "查看上次挑战结果"
          : session.record?.mode === "formal"
            ? "继续原正式挑战"
            : "继续上次练习";
    show(
      "formal",
      !(
        hasSave &&
        session.record.mode === "formal" &&
        saved.challenge.phase !== "finished" &&
        saved.challenge.challengeId === definition?.challengeId
      ) && !pending,
    );
    $("formal").disabled =
      loading ||
      !api.formalAvailable ||
      (Boolean(getPlayer()) && budget?.remaining === 0) ||
      !session.store.owned ||
      session.temporary;
    $("formal").textContent = !api.formalAvailable
      ? "联网后开启正式挑战"
      : !getPlayer()
        ? "选择身份，开始正式挑战"
        : budget?.remaining === 0
          ? "今日正式机会已用完"
          : session.temporary
            ? "正式挑战需要可靠存档"
            : "开始正式挑战";
    $("formal").classList.toggle("ghost", hasSave);
    $("practice").disabled =
      session.status === "initializing" || busy || !definition;
    $("practice").classList.toggle(
      "ghost",
      hasSave ||
        busy ||
        pending ||
        (!$("formal").classList.contains("hidden") && !$("formal").disabled),
    );
    $("practice").textContent = !definition
      ? "没有缓存题目，可先玩经典"
      : busy
        ? "挑战正在另一页进行"
        : pending
          ? "处理开局后再练习"
          : session.status === "unavailable"
            ? "临时练习 · 不保存"
            : hasSave
              ? "新练一局这道题"
              : "先练一局 · 不限次数";
    const notices = {
      busy: "另一页正在使用挑战存档。接管需先保存并暂停；经典局不受影响。",
      invalid: "挑战存档损坏或版本不兼容；确认新开前不会覆盖原记录。",
      unavailable: "无法安全保存挑战。正式开局暂不可用，可明确选择临时练习。",
    };
    const warning =
      session.warning || recoveryError || notices[session.status] || "";
    show("hub-warning", Boolean(warning));
    $("hub-warning").textContent = warning;
    show(
      "retry",
      (Boolean(warning) || Boolean(serviceError)) &&
        !busy &&
        !session.temporary,
    );
    if (view === "result" && current()) paintResult();
    if (previousView !== view || lastUiStatus !== session.status) {
      if (view === "hub") $("hub").scrollTop = 0;
      if (view === "result") $("result").scrollTop = 0;
    }
    lastUiStatus = session.status;
    syncPause();
    if (view === "play" && (laidOutGame !== current() || layoutView !== view))
      requestAnimationFrame(layout);
    layoutView = view;
    if (view === "result" && previousView !== "result" && !dialog.open)
      $("again").focus({ preventScroll: true });
  }
  function paintResult() {
    const game = current(),
      entry = entryForResult(),
      upload = session.record.upload;
    $("result-kind").textContent = formal()
      ? "正式挑战完成"
      : "练习完成 · 不参与排名";
    $("result-kind").classList.toggle("formal", formal());
    $("final").textContent = game.score.toLocaleString("zh-CN");
    $("result-day").textContent =
      `${dateLabel(game.challenge.challengeId)} · ${formal() ? "正式挑战" : "每日挑战练习"}`;
    $("final-detail").textContent =
      `${game.drops} / 100 投 · ${game.challenge.reason === "limit" ? "投放用尽" : "危险线持续超时"} · 最高合成：${defOf(game.maxLevel).name}`;
    let title = "只记录本次练习",
      copy = "练习不消耗正式机会，也不会写入经典成绩或今日榜。",
      status =
        session.warning ||
        (session.temporary
          ? "结果仅保留在当前页面。"
          : "练习结果已保存，可在入口重新查看。");
    const receipt = upload?.receipt || entry?.receipt;
    if (formal()) {
      if (receipt) {
        title = receipt.improved ? "已上传 · 本题个人新纪录" : "已上传正式成绩";
        copy = `本题个人最佳 ${receipt.best} 分${receipt.rank ? ` · 提交时排名 #${receipt.rank}` : " · 正分成绩参与排名"}`;
        status = entry?.cleanupPending
          ? "服务器已确认，本机状态正在同步。"
          : "本局回执已保存，不会重复计入成绩。";
      } else if (upload?.state === "removed") {
        title = "本机补传记录已移除";
        copy = "不再重试这条记录；如果服务器已接受，可在本题榜查看。";
        status = "当前结果只供本机查看。";
      } else if (entry) {
        title =
          {
            pending: "成绩已暂存，准备上传",
            uploading: "正在上传正式成绩…",
            retry: "成绩已暂存，等待重试",
            identity: "等待原身份处理",
            rejected: "本局未获服务器确认",
            corrupt: "成绩记录需要处理",
          }[entry.state] || "成绩待处理";
        if (entry.state === "retry" && entry.attempts >= 4)
          title = "成绩已暂存，自动重试已暂停";
        if (entry.error === "rate_limited" && entry.nextAt > Date.now())
          title = "服务器限流，等待允许重试";
        copy =
          entry.error === "challenge_expired"
            ? "已超过这道题的正式提交截止，不能再上榜。"
            : entry.error === "score_conflict"
              ? "服务器已接受不同内容，不能覆盖原回执。"
              : `截止：北京时间 ${deadlineLabel(session.record.online.submitUntil)}。补传始终使用原身份和原凭证。`;
        status = entry.durable
          ? "结果记录已保存在本机。"
          : entry.journaled
            ? "结果仍保存在原对局记录中，请先处理补传再开新局。"
            : "记录尚未保存，请勿刷新或关闭页面。";
      } else {
        title = "成绩尚未进入补传队列";
        copy = "请重试保存，当前结果不会冒充已上传。";
        status =
          session.warning || recoveryError || "请先处理本局结果再开新局。";
      }
    }
    $("result-status-title").textContent = title;
    $("result-status-copy").textContent = copy;
    $("result-save").textContent = status;
    show(
      "result-retry",
      formal()
        ? !receipt && upload?.state !== "removed"
        : Boolean(session.warning) && !session.temporary,
    );
    $("result-retry").textContent =
      entry?.state === "rejected" ||
      entry?.state === "identity" ||
      entry?.state === "corrupt"
        ? "查看处理记录"
        : formal()
          ? "重试保存并上传"
          : "重试保存结果";
    $("again").textContent =
      api.formalAvailable && (remaining() > 0 || !getPlayer())
        ? !getPlayer()
          ? "选择身份，参加正式挑战"
          : `再挑战一次 · 还剩 ${remaining()} 次`
        : "再练一次同一道题";
    show(
      "result-practice",
      api.formalAvailable && (remaining() > 0 || !getPlayer()),
    );
    show("result-rank", formal());
  }
  session = new ChallengeSession({
    store,
    api,
    getPlayer,
    onChange: () => {
      recoverSafe();
      paint();
    },
    onFinish: (s) => {
      if (s.record?.mode === "formal")
        uploads.stage(s.record, s.game.snapshot());
    },
    canReplace: (record, game) => !uploads || uploads.canReplace(record, game),
    createGame: (challenge, onGameOver) =>
      new Game(
        canvas,
        {
          onGameOver,
          onNext: () => {
            lastNext = undefined;
          },
          onClaws: () => {},
        },
        { challenge, comfort },
      ),
  });
  uploads = new ChallengeUploads({
    scope,
    store,
    api,
    getPlayer,
    locks: navigator.locks,
    onChange: (entry) => {
      paint();
      if (dialogKind === "queue") renderQueue();
      if (entry?.state === "accepted" && entry.key !== lastReceiptKey) {
        lastReceiptKey = entry.key;
        void loadToday();
      }
    },
    onRecord: (record) => {
      if (session.record?.roundId === record.roundId) {
        session.record = record;
        if (session.game && !session.game.over)
          session.game.restore(record.game);
      }
    },
  });
  recoverSafe();
  uploads.queue.start();
  drawCrabIcon($("hero"), 7, 90, 65, 2);
  function recoverSafe() {
    if (!uploads) return;
    try {
      uploads.recover();
      recoveryError = "";
    } catch {
      recoveryError = "有正式结果尚未进入补传队列，请先处理待提交记录。";
    }
  }
  async function loadToday() {
    const version = ++loadVersion;
    loading = true;
    paint();
    try {
      const data = await api.today();
      if (version !== loadVersion) return;
      definition = data.challenge;
      serviceError = "";
    } catch (error) {
      if (version !== loadVersion) return;
      api.data = null;
      definition =
        definition || api.cached() || session?.record?.game.challenge || null;
      serviceError =
        error.status === 401
          ? "登录已失效，请打开账号重新登录。原正式局和待处理成绩仍保留。"
          : definition
            ? "未能连接服务器。当前仅可练习缓存题目；正式开局需要联网确认。"
            : "未能获取题目，且本机没有缓存。可以先继续经典模式。";
      retryAt = performance.now() + 30000;
    } finally {
      if (version === loadVersion) {
        loading = false;
        paint();
      }
    }
  }
  function activateView() {
    if (!active) {
      current()?.setPaused(true);
      view = "hub";
      return;
    }
    view = current()?.over ? "result" : "play";
    pauses.clear();
    if (dialog.open) pauses.set("dialog", true);
    if (document.body.classList.contains("modal-open"))
      pauses.set("external", true);
    if (document.hidden) pauses.set("background", true);
    paint();
    if (!dialog.open)
      (view === "result" ? $("again") : board).focus({ preventScroll: true });
  }
  function start(challenge = definition, temporary = false) {
    if (!challenge) return;
    if (session.start(challenge, temporary)) {
      session.eligibility = null;
      activateView();
    }
  }
  function pendingChoices() {
    ask(
      "这次正式开局尚未确认",
      "请求可能已被服务器接受。重试会使用原请求标识；放弃本机记录不保证退回已经消耗的机会。",
      [
        ...(session.pendingIntent
          ? [["继续确认原开局", () => void resume()]]
          : []),
        ["保留记录，稍后处理", () => {}, true],
        [
          "放弃这条开局记录",
          () => {
            session.discardStart();
            paint();
          },
          true,
        ],
      ],
    );
  }
  function newPractice(challenge = definition) {
    if (!challenge) return;
    if (session.pendingIntent || session.status === "intent-invalid") {
      pendingChoices();
      return;
    }
    if (session.status === "unavailable") {
      ask(
        "开始临时练习？",
        "当前无法自动保存。临时练习只保留在本页，刷新后不能恢复，也不会覆盖旧存档。",
        [
          ["暂不开局", () => {}, true],
          ["开始临时练习", () => start(challenge, true)],
        ],
      );
      return;
    }
    const unfinished =
      (session.game && !session.game.over) ||
      Boolean(
        session.record && session.record.game.challenge.phase !== "finished",
      );
    if (unfinished || session.status === "invalid") {
      ask(
        formal() ? "放弃正式局，开始练习？" : "新开一局挑战练习？",
        formal()
          ? "这会放弃当前正式资格，已经使用的机会不退回。经典局保留。"
          : session.status === "invalid"
            ? "确认后才替换无法读取的挑战存档。经典存档不会改变。"
            : "这会替换当前未完成的练习。经典局与成绩保留。",
        [
          ["保留原局", () => {}],
          [
            "放弃原局，开始练习",
            () => start(challenge, session.temporary),
            true,
          ],
        ],
      );
      return;
    }
    start(challenge, session.temporary);
  }
  async function prepareFormal() {
    if (session.pendingIntent || session.status === "intent-invalid") {
      pendingChoices();
      return;
    }
    if (!getPlayer()) {
      requestIdentity();
      return;
    }
    if (!api.formalAvailable) {
      await loadToday();
      if (!api.formalAvailable) return;
    }
    if (!session.store.owned || session.temporary) {
      session.warning = "浏览器必须允许安全保存，才能领取正式机会。";
      paint();
      return;
    }
    const d = api.data.challenge,
      n = remaining();
    if (!Number.isInteger(n)) {
      paint();
      return;
    }
    if (n <= 0) {
      ask(
        "今日正式机会已用完",
        "当前正式局仍可继续。若改为新练习，将放弃当前棋盘和正式资格，已用机会不退回。",
        [
          ["保留当前局", () => {}],
          ["放弃并开始练习", () => start(d, session.temporary), true],
        ],
      );
      return;
    }
    const replacing =
      session.record && session.record.game.challenge.phase !== "finished";
    ask(
      `开始 ${dateLabel(d.challengeId)} 正式挑战？`,
      `${replacing ? "新开会替换当前未完成的挑战；已经使用的正式机会不退回。\n" : ""}今日还剩 ${n} 次。服务器确认领取凭证后消耗 1 次；刷新与重试不重复扣次。\n100 次投放；最迟北京时间 ${deadlineLabel(d.submitUntil)} 前提交。`,
      [
        [
          "开始正式挑战 · 消耗 1 次",
          async () => {
            const started = await session.startFormal(d);
            await loadToday();
            if (started) activateView();
          },
        ],
        ["先练习，不用机会", () => newPractice(d), true],
      ],
    );
  }
  function eligibilityChoices() {
    const copy = {
      identity: "这局属于原身份，请切回原身份后重试。不会以当前账号提交。",
      network: "暂时无法核验原凭证。重试不会领取新机会；也可以明确转为练习。",
      expired: "已超过这道题的正式提交截止，原棋盘仍保留。",
      used: "服务器显示这局凭证已用于提交，不能重新当作正式局继续。",
      invalid: "原正式凭证已失效。可以保留原局稍后处理，或转为练习。",
      checking: "正在核验原资格，请稍候。",
    };
    ask(
      "确认原正式资格",
      `${copy[session.eligibility] || "原正式资格暂时无法确认。"}\n转为练习后不可恢复本局正式资格，已用机会不退回。`,
      [
        ...(["identity", "network"].includes(session.eligibility)
          ? [["重试核验", () => void resume()]]
          : []),
        ...(session.eligibility === "identity"
          ? [["打开账号，切回原身份", () => requestAccount(), true]]
          : []),
        [
          "保留原局，返回入口",
          () => {
            view = "hub";
            paint();
          },
        ],
        [
          "转为练习继续",
          () => {
            if (session.toPractice()) activateView();
          },
          true,
        ],
      ],
    );
  }
  async function resume() {
    if (session.status === "busy") {
      await session.takeover();
      recoverSafe();
      void uploads.queue.kick();
      paint();
      return;
    }
    if (session.status === "intent-invalid") {
      pendingChoices();
      return;
    }
    if (session.pendingIntent) {
      const started = await session.retryStart();
      await loadToday();
      if (started) activateView();
      return;
    }
    if (formal()) {
      if (await session.resumeFormal()) activateView();
      else if (!session.checking && active) eligibilityChoices();
      return;
    }
    if (session.status === "saved" && !session.resume()) return;
    if (session.status === "active") activateView();
  }
  function home() {
    if (
      current()?.settling &&
      !current().over &&
      (!formal() || session.eligibility === "valid")
    )
      return;
    clearInput();
    current()?.setPaused(true);
    session.flush();
    view = "hub";
    paint();
    $("date").focus({ preventScroll: true });
  }
  function leave() {
    if (
      current()?.settling &&
      view === "play" &&
      (!formal() || session.eligibility === "valid")
    )
      return;
    const done = () => {
      clearInput();
      current()?.setPaused(true);
      active = false;
      root.classList.add("hidden");
      onExit();
    };
    if (session.status === "active" && !session.flush())
      ask(
        "挑战尚未保存成功",
        "切换后棋盘仍保留在这一页，但刷新或关闭可能丢失进度。经典局不受影响。",
        [
          [
            "留在挑战，重试保存",
            () => {
              session.flush();
              paint();
            },
          ],
          ["仍切回经典", done, true],
        ],
      );
    else done();
  }
  async function togglePause() {
    if (view !== "play" || !current() || current().over || dialog.open) return;
    if (
      formal() &&
      (pauses.has("background") ||
        (session.eligibility && session.eligibility !== "valid"))
    ) {
      await resume();
      return;
    }
    if (current().settling) return;
    if (current().paused) {
      session.handoffPaused = false;
      pauses.resume();
    } else pauses.set("manual", true);
    session.flush();
    updatePlay();
    if (!current().paused) board.focus({ preventScroll: true });
  }
  async function openRank(
    challengeId = api.data?.challenge.challengeId,
    limit = 20,
  ) {
    if (!challengeId) return;
    ask(
      `${dateLabel(challengeId)} · 正式挑战榜`,
      "正在读取本题榜单…",
      [["返回游戏", () => {}]],
      "rank",
    );
    const version = dialogVersion;
    try {
      const data = await api.board(challengeId, limit);
      if (!dialog.open || dialogKind !== "rank" || version !== dialogVersion)
        return;
      $("dialog-copy").textContent = data.total
        ? `共 ${data.total} 人上榜 · 只包含这道题的正式成绩`
        : "这道题还没有正分正式成绩，快来挑战吧。";
      const list = document.createElement("ol");
      list.className = "daily-rank-list";
      for (const e of data.entries) {
        const li = document.createElement("li"),
          name = document.createElement("span"),
          score = document.createElement("b");
        name.textContent = `${e.rank}  ${e.name}${e.tag ? " #" + e.tag : ""}${e.linuxdo ? " · L" : ""}`;
        score.textContent = String(e.score);
        li.append(name, score);
        list.append(li);
      }
      $("dialog-extra").replaceChildren(list);
      if (data.me) {
        const me = document.createElement("p");
        me.className = "daily-my-rank";
        me.textContent = data.me.rank
          ? `我的名次 #${data.me.rank} · ${data.me.best} 分`
          : "我还没有本题正式成绩";
        $("dialog-extra").append(me);
      }
      if (data.total > data.entries.length && limit < 100) {
        const more = document.createElement("button");
        more.className = "link-btn";
        more.textContent = "查看更多";
        more.onclick = () =>
          void openRank(challengeId, Math.min(100, limit + 20));
        $("dialog-extra").append(more);
      }
    } catch (error) {
      if (dialog.open && dialogKind === "rank" && version === dialogVersion) {
        $("dialog-copy").textContent = error.message;
        const retry = document.createElement("button");
        retry.className = "btn ghost";
        retry.textContent = "重新加载";
        retry.onclick = () => void openRank(challengeId, limit);
        $("dialog-extra").replaceChildren(retry);
      }
    }
  }
  function queueTitle(entry) {
    if (entry.state === "retry" && entry.attempts >= 4) return "自动重试已暂停";
    return (
      {
        pending: "准备上传",
        uploading: "正在上传",
        retry: "等待重试",
        identity: "等待原身份",
        rejected: "已停止重试",
        accepted: "服务器已确认，正在同步",
        corrupt: "记录损坏",
      }[entry.state] || "待处理"
    );
  }
  function openQueue() {
    ask(
      "待处理的挑战成绩",
      "每条记录只使用原身份、原题目和原凭证。新开一局不会覆盖旧记录。",
      [["返回游戏", () => {}]],
      "queue",
    );
    renderQueue();
  }
  function renderQueue() {
    if (!dialog.open || dialogKind !== "queue") return;
    const focused = document.activeElement?.dataset?.queueKey,
      action = document.activeElement?.dataset?.queueAction;
    const list = document.createElement("div");
    list.className = "daily-queue-list";
    const entries = uploads.queue.list();
    if (!entries.length) {
      const p = document.createElement("p");
      p.textContent = "没有待处理成绩";
      list.append(p);
    }
    for (const entry of entries) {
      const row = document.createElement("section"),
        title = document.createElement("b"),
        copy = document.createElement("p");
      title.textContent =
        entry.state === "corrupt"
          ? "损坏的本机记录"
          : `${dateLabel(entry.challengeId)} · ${entry.score} 分`;
      copy.textContent = `${queueTitle(entry)} · ${entry.playerName || "原身份"}${entry.error === "challenge_expired" ? " · 已超过提交截止" : entry.error === "score_conflict" ? " · 内容与已接受回执冲突" : ""}${!entry.durable && !entry.journaled ? " · 尚未保存，请勿刷新" : ""}`;
      row.append(title, copy);
      if (!["rejected", "corrupt"].includes(entry.state)) {
        const retry = document.createElement("button");
        retry.className = "btn ghost";
        retry.textContent = "重试";
        retry.disabled =
          entry.state === "uploading" ||
          (entry.error === "rate_limited" && entry.nextAt > Date.now());
        retry.dataset.queueKey = entry.key;
        retry.dataset.queueAction = "retry";
        retry.onclick = () => void uploads.queue.retry(entry.key);
        row.append(retry);
      }
      const remove = document.createElement("button");
      remove.className = "link-btn";
      remove.textContent = "移除本机记录";
      remove.disabled = entry.state === "uploading";
      remove.dataset.queueKey = entry.key;
      remove.dataset.queueAction = "remove";
      remove.onclick = () =>
        ask(
          "移除这条本机记录？",
          "移除后不再补传，不会退回正式机会，也不会删除服务器已接受的成绩。",
          [
            ["保留记录", openQueue],
            [
              "确认移除",
              async () => {
                await uploads.queue.remove(entry.key);
                openQueue();
              },
              true,
            ],
          ],
        );
      row.append(remove);
      list.append(row);
    }
    $("dialog-extra").replaceChildren(list);
    if (focused) {
      const buttons = [...list.querySelectorAll("button")];
      buttons
        .find(
          (b) =>
            b.dataset.queueKey === focused && b.dataset.queueAction === action,
        )
        ?.focus({ preventScroll: true });
    }
  }
  function retryResult() {
    if (!formal()) {
      session.flush();
      paint();
      return;
    }
    try {
      uploads.stage(
        session.record,
        current()?.snapshot() || session.record.game,
      );
      const entry = entryForResult();
      if (entry && ["identity", "rejected", "corrupt"].includes(entry.state))
        openQueue();
      else if (entry) void uploads.queue.retry(entry.key);
      recoveryError = "";
    } catch {
      recoveryError = "未能保存结果，请勿刷新，先处理待提交记录。";
    }
    paint();
  }
  function identityChanged() {
    const p = getPlayer(),
      key = p ? `${p.id}:${p.token}` : "";
    if (key === identityKey) return;
    identityKey = key;
    if (
      formal() &&
      current() &&
      !current().over &&
      p?.id !== session.record.online.playerId
    ) {
      session.eligibility = "identity";
      syncPause();
    }
    api.data = null;
    uploads.queue.wakeIdentity();
    if(formal()&&session.status==='active'&&current()&&!current().over&&p?.id===session.record.online.playerId)void session.resumeFormal();
    if (active) void loadToday();
  }
  $("practice").onclick = () => newPractice();
  $("resume-btn").onclick = () => void resume();
  $("formal").onclick = () => void prepareFormal();
  $("identity").onclick = () =>
    getPlayer() ? requestAccount() : requestIdentity();
  $("rank").onclick = () => void openRank();
  $("pending").onclick = openQueue;
  $("retry").onclick = () => {
    if (session.pendingIntent || session.status === "intent-invalid") {
      pendingChoices();
      return;
    }
    if (session.status === "active") session.flush();
    else void session.initialize();
    recoverSafe();
    void uploads.queue.kick();
    void loadToday();
    paint();
  };
  $("save-retry").onclick = () => {
    session.flush();
    recoverSafe();
    void uploads.queue.kick();
    paint();
  };
  $("result-retry").onclick = retryResult;
  $("share").onclick = () => {
    if (!current()?.over) return;
    try {
      onShare(
        shareResult(
          { ...session.record, game: current().snapshot() },
          entryForResult(),
        ),
      );
    } catch {
      ask("暂时无法分享", "本局结果尚未准备好，请重试。", [
        ["返回结果", () => {}],
      ]);
    }
  };
  $("home").onclick = $("tab").onclick = $("result-home").onclick = home;
  $("classic").onclick = $("result-classic").onclick = leave;
  $("restart").onclick = () =>
    formal()
      ? void prepareFormal()
      : newPractice(current()?.challengeDefinition || definition);
  $("again").onclick = () =>
    api.formalAvailable && (remaining() > 0 || !getPlayer())
      ? void prepareFormal()
      : newPractice(current().challengeDefinition);
  $("result-practice").onclick = () =>
    newPractice(current().challengeDefinition);
  $("result-rank").onclick = () =>
    void openRank(current().challenge.challengeId);
  $("pause").onclick = $("continue").onclick = () => void togglePause();
  $("claw").onclick = () => {
    sfx.unlock();
    current()?.toggleClaw();
    clearInput();
    updatePlay();
  };
  $("sound").onclick = () => {
    sfx.toggle();
    updatePlay();
  };
  $("help").onclick = () => onHelp(formal());
  const playable = () =>
    active &&
    view === "play" &&
    session.status === "active" &&
    current() &&
    !current().over &&
    !current().paused &&
    !current().settling &&
    !dialog.open;
  const point = (e) => {
    const r = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * WORLD_W,
      y: ((e.clientY - r.top) / r.height) * WORLD_H,
    };
  };
  board.addEventListener("pointerdown", (e) => {
    if (!playable()) return;
    sfx.unlock();
    if (e.isTrusted && e.pointerType === "touch") enableHaptics();
    const p = point(e);
    if (current().clawMode) {
      current().useClawAt(p.x, p.y);
      session.flush();
      updatePlay();
      return;
    }
    aiming = true;
    pointer = e.pointerId;
    board.setPointerCapture(pointer);
    current().setAim(p.x);
  });
  board.addEventListener("pointermove", (e) => {
    if (playable() && (aiming || e.pointerType === "mouse"))
      current().setAim(point(e).x);
  });
  board.addEventListener("pointerup", (e) => {
    if (!playable() || !aiming || e.pointerId !== pointer) return;
    current().setAim(point(e).x);
    clearInput();
    current().requestDrop();
  });
  board.addEventListener("pointercancel", clearInput);
  board.addEventListener("contextmenu", (e) => e.preventDefault());
  window.addEventListener("keydown", (e) => {
    if (
      !active ||
      dialog.open ||
      document.body.classList.contains("modal-open") ||
      e.target.closest("input,textarea,select") ||
      (e.target.closest("button,a") && ["Space", "Enter"].includes(e.code))
    )
      return;
    if (e.code === "KeyP") {
      e.preventDefault();
      if (!e.repeat) togglePause();
      return;
    }
    if (e.code === "KeyR") {
      e.preventDefault();
      if (!e.repeat && view === "play" && !current()?.settling)
        formal()
          ? void prepareFormal()
          : newPractice(current().challengeDefinition);
      return;
    }
    if (!playable()) return;
    if (["ArrowLeft", "ArrowRight", "KeyA", "KeyD"].includes(e.code)) {
      e.preventDefault();
      keys.add(e.code);
    } else if (["Space", "ArrowDown", "Enter"].includes(e.code)) {
      e.preventDefault();
      sfx.unlock();
      if (!e.repeat) current().requestDrop();
    } else if (e.code === "KeyC") {
      current().toggleClaw();
      updatePlay();
    }
  });
  window.addEventListener("keyup", (e) => keys.delete(e.code));
  function background() {
    if (!active) return;
    clearInput();
    if (current() && !current().over) pauses.set("background", true);
    session.flush();
    updatePlay();
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) background();
    last = performance.now();
  });
  window.addEventListener("blur", background);
  window.addEventListener("pagehide", () => {
    background();
    session.leave();
  });
  window.addEventListener("pageshow", (e) => {
    if (e.persisted && active) void session.initialize();
  });
  new ResizeObserver(layout).observe($("stage"));
  window.addEventListener("resize", layout);
  window.addEventListener("storage", (event) => {
    if (event.key?.startsWith(uploads.queue.prefix))
      uploads.queue.observe(event.key, event.newValue);
    identityChanged();
  });
  window.addEventListener("online", () => {
    uploads.queue.wakeOnline();
    if (active) void loadToday();
  });
  window.addEventListener("pagehide", () => uploads.queue.stop());
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      uploads.queue.start();
      if (active) void loadToday();
    }
  });
  const controller = {
    applyComfort: () => current()?.applyComfort(),
    get active() {
      return active;
    },
    hasBoundWork: (playerId) => uploads.hasBoundWork(playerId),
    get boundPlayerId(){const pending=session.store.readIntent(),saved=session.store.read();return pending.kind==='intent'?pending.intent.playerId:saved.record?.mode==='formal'&&saved.record.game.challenge.phase!=='finished'?saved.record.online?.playerId||null:null;},
    credentialRotationBlocked:()=>Boolean(session.checking||session.pendingIntent||['starting','intent-invalid'].includes(session.status)||uploads.queue.list().some(e=>e.state==='uploading')),
    canNavigateForAuth() {
      if (
        session.status === "active" &&
        !session.flush() &&
        (!current()?.over || !uploads.canReplace(session.record, current()))
      )
        return false;
      recoverSafe();
      return !uploads.queue
        .list()
        .some(
          (e) =>
            !e.durable &&
            !e.journaled &&
            !["accepted", "removed"].includes(e.state),
        );
    },
    identityChanged,
    setExternalModal: (open, reason = "external") => pauses.set(reason, open),
    async open() {
      if (active) return true;
      if (onEnter() === false) return false;
      active = true;
      root.classList.remove("hidden");
      view = "hub";
      paint();
      await session.initialize();
      definition = definition || session.record?.game.challenge || null;
      recoverSafe();
      void uploads.queue.kick();
      paint();
      $("date").focus({ preventScroll: true });
      void loadToday();
      return true;
    },
    async invitationToday() {
      await loadToday();
      return api.data?.challenge || null;
    },
    async enterInvitation(d, formalEntry) {
      if (
        current()?.settling &&
        !current().over &&
        (!formal() || session.eligibility === "valid")
      )
        return false;
      if (!(await controller.open())) return false;
      home();
      if (!formalEntry) newPractice(d);
      return true;
    },
    frame(now) {
      const dt = Math.max(0, Math.min((now - last) / 1000, 0.1));
      last = now;
      if (now >= nextDateCheck) {
        nextDateCheck = now + 1000;
        identityChanged();
        if (
          active &&
          !loading &&
          ((api.data && api.now() >= api.data.challenge.endsAt) ||
            (!api.data && now >= retryAt))
        )
          void loadToday();
      }
      const game = current();
      if (!active || view !== "play" || !game) return;
      if (
        formal() &&
        !game.over &&
        api.now() !== null &&
        api.now() >= session.record.online.submitUntil &&
        session.eligibility !== "expired"
      ) {
        session.eligibility = "expired";
        syncPause();
      }
      const dir =
        (keys.has("ArrowRight") || keys.has("KeyD") ? 1 : 0) -
        (keys.has("ArrowLeft") || keys.has("KeyA") ? 1 : 0);
      if (dir && playable())
        game.setAim(
          game.clampAim(game.aimX, game.current) +
            dir * 280 * Math.min(dt, 0.05),
        );
      game.update(dt);
      session.tick(now);
      updatePlay();
      game.render();
    },
  };
  return controller;
}
