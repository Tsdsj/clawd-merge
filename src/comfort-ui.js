import { drawCrabIcon } from "./crabs.js";
const markup = `<dialog class="comfort-dialog" id="comfort-panel" aria-labelledby="comfort-panel-title">
      <header class="panel-header">
        <div class="title-row">
          <h2 id="comfort-panel-title">玩法与设置</h2>
          <button id="comfort-close" aria-label="关闭玩法与设置">×</button>
        </div>
        <nav aria-label="选择内容">
          <button id="comfort-rules-tab" aria-pressed="false">玩法</button
          ><button id="comfort-settings-tab" aria-pressed="true">舒适设置</button>
        </nav>
      </header>
      <div class="panel-content">
        <section id="comfort-rules" hidden>
          <h3 id="comfort-rules-title">经典玩法</h3>
          <p id="comfort-rules-copy">
            相同的 Clawd
            相碰会合成升级。左右瞄准、点击投放；危险线持续超时则结束。
          </p>
          <p class="muted">键盘：方向键瞄准 · 空格投放 · P 暂停。</p>
          <button id="comfort-rules-settings" class="primary">调整动效与震动</button>
        </section>
        <section id="comfort-settings">
          <p class="scope">本机设置 · 经典与每日共用</p>
          <fieldset>
            <legend>动态效果</legend>
            <div class="segmented">
              <label
                ><input
                  type="radio"
                  name="comfort-motion"
                  value="system"
                  checked
                /><span>跟随系统</span></label
              ><label
                ><input type="radio" name="comfort-motion" value="reduced" /><span
                  >减弱</span
                ></label
              ><label
                ><input type="radio" name="comfort-motion" value="standard" /><span
                  >标准</span
                ></label
              >
            </div>
          </fieldset>
          <p id="comfort-effective-copy" class="effective"></p>
          <p id="comfort-motion-description" class="muted"></p>
          <div class="setting-row">
            <div>
              <label for="comfort-shake">合成震屏</label>
              <p id="comfort-shake-description">大合成时轻微晃动棋盘。</p>
            </div>
            <label class="switch-hit"
              ><input
                id="comfort-shake"
                type="checkbox"
                role="switch"
                aria-describedby="comfort-shake-description"
            /></label>
          </div>
          <div class="setting-row">
            <div>
              <label for="comfort-particles">装饰粒子</label>
              <p id="comfort-particles-description">合成时的小碎屑与庆祝粒子。</p>
            </div>
            <label class="switch-hit"
              ><input
                id="comfort-particles"
                type="checkbox"
                role="switch"
                aria-describedby="comfort-particles-description"
            /></label>
          </div>
          <p id="comfort-locked-note" class="muted" hidden>
            减弱动态下这两项关闭；你的开关选择会保留，恢复标准时重新使用。
          </p>
          <div class="setting-row">
            <div>
              <label for="comfort-haptics">触控震动</label>
              <p id="comfort-haptics-description">默认关闭；设备支持时轻触反馈。</p>
            </div>
            <label class="switch-hit"
              ><input
                id="comfort-haptics"
                type="checkbox"
                role="switch"
                aria-describedby="comfort-haptics-description"
            /></label>
          </div>
          <div class="preview">
            <div><b>效果预览</b><span id="comfort-preview-label"></span></div>
            <div id="comfort-preview-stage">
              <canvas id="comfort-preview-crab" aria-label="合成效果示意"></canvas
              ><span class="particle p1">·</span
              ><span class="particle p2">·</span
              ><span class="particle p3">·</span
              ><span class="merge-label">合成 +30</span>
            </div>
            <button id="comfort-preview-button">预览一次合成</button>
            <p id="comfort-preview-feedback" class="muted" role="status">
              只演示效果，不计分、不发声、不震动。
            </p>
          </div>
          <p class="muted footnote">
            危险线、分数和必要反馈始终保留。音效仍由棋盘音效按钮控制。
          </p>
          <div id="comfort-storage-note" class="storage-note" role="status">
            <span id="comfort-storage-copy"></span
            ><button id="comfort-retry" hidden>重试保存</button>
          </div>
          <div class="reset-row">
            <button id="comfort-reset" class="text-button">恢复舒适设置默认值</button
            ><button id="comfort-undo" class="text-button" hidden>撤销</button>
          </div>
        </section>
        
      </div>
      <footer class="panel-footer">
        <span id="comfort-footer-status">打开设置已暂停游戏</span
        ><button id="comfort-done" class="primary">完成，返回游戏</button>
      </footer>
    </dialog>`;
export function createComfortUI({ settings, onPause }) {
  const t = document.createElement("template");
  t.innerHTML = markup;
  const dialog = t.content.firstElementChild;
  document.body.append(dialog);
  const $ = (id) => dialog.querySelector(`#comfort-${id}`);
  let context = { mode: "classic" },
    timer;
  const supported = typeof navigator.vibrate === "function";
  const tab = (value) => {
    $("settings").hidden = !value;
    $("rules").hidden = value;
    $("rules-tab").setAttribute("aria-pressed", String(!value));
    $("settings-tab").setAttribute("aria-pressed", String(value));
    dialog.querySelector(".panel-content").scrollTop = 0;
  };
  function paint() {
    const p = settings.prefs,
      e = settings.effects;
    for (const r of dialog.querySelectorAll("[name=comfort-motion]"))
      r.checked = r.value === p.motion;
    $("effective-copy").textContent =
      p.motion === "system"
        ? settings.systemKnown
          ? `当前系统：${e.reduced ? "减弱动态" : "标准动态"} · 已跟随`
          : "无法检测系统偏好 · 暂用减弱动态"
        : `当前：${e.reduced ? "减弱" : "标准"}动态 · 不随系统变化`;
    $("motion-description").textContent = e.reduced
      ? "关闭震屏、装饰粒子与强化动效。危险提示和分数仍保留。"
      : "保留标准动效；可单独关闭震屏或装饰粒子。";
    for (const k of ["shake", "particles"]) {
      $(k).checked = e[k];
      $(k).disabled = e.reduced;
    }
    $("locked-note").hidden = !e.reduced;
    $("haptics").checked = p.haptics;
    $("haptics").disabled = !supported;
    $("haptics-description").textContent = supported
      ? "默认关闭；仅在有效触控操作后提供反馈。"
      : "此设备未提供震动能力；保留偏好但不触发。";
    $("preview-label").textContent = e.reduced ? "减弱动态" : "标准动态";
    const copies = {
      default: "默认设置 · 修改后保存到本机",
      saved: "已保存到本机 · 即时生效",
      "read-error": settings.dirty
        ? "设置仅在本页生效。仍无法读取原记录，尚未覆盖；请重试。"
        : "无法读取本机设置，暂用默认值。原记录未覆盖。",
      "write-error": "未能保存。设置已在本页生效，刷新后可能恢复旧设置。",
      invalid:
        "原设置损坏或版本不受支持，未被覆盖。本页选择有效；恢复默认可建立新的设置。",
    };
    $("storage-copy").textContent = copies[settings.status];
    $("storage-note").classList.toggle(
      "error",
      !["default", "saved"].includes(settings.status),
    );
    $("retry").hidden = !["read-error", "write-error"].includes(
      settings.status,
    );
    $("retry").textContent = settings.dirty ? "重试保存" : "重试读取";
    $("undo").hidden = !settings.canUndo;
    $("rules-title").textContent =
      context.mode === "daily" ? "每日挑战规则" : "经典玩法";
    $("rules-copy").textContent =
      context.mode === "daily"
        ? "相同题目使用同一投放序列，每局 100 投。游客与 LINUX DO 均可正式挑战，每日 3 次；练习不限次数，不上榜。最后一投后落稳持续 0.75 秒或到达 8 秒上限后结算。题目在北京时间每日 00:00 更新，旧题正式成绩须在次日 00:10 前通过服务器校验。"
        : "左右瞄准，点击或松手投放。相同的 Clawd 相碰会合成升级；落稳后超过危险线 3 秒结束，飞行中的不算。钳子夹走一只；彩虹让碰到的 Clawd 升级；狂热持续 8 秒、得分翻倍。";
    $("footer-status").textContent = context.formal
      ? "游戏已暂停；正式截止不延长"
      : "游戏已暂停；关闭恢复原状态";
    if (e.reduced) $("preview-stage").className = "";
  }
  const unsubscribe = settings.subscribe(paint);
  for (const r of dialog.querySelectorAll("[name=comfort-motion]"))
    r.onchange = () => settings.update({ motion: r.value });
  for (const k of ["shake", "particles", "haptics"])
    $(k).onchange = () => settings.update({ [k]: $(k).checked });
  $("reset").onclick = () => settings.reset();
  $("undo").onclick = () => {
    settings.undoReset();
    $("reset").focus();
  };
  $("retry").onclick = () => {
    settings.retry();
    if ($("retry").hidden) $("done").focus();
  };
  $("rules-tab").onclick = () => tab(false);
  $("settings-tab").onclick = $("rules-settings").onclick = () => tab(true);
  $("close").onclick = $("done").onclick = () => dialog.close();
  dialog.addEventListener("close", () => {
    if (!dialog.open) {
      clearTimeout(timer);
      $("preview-stage").className = "";
      onPause(false);
    }
  });
  dialog.addEventListener("keydown", (e) => e.stopPropagation());
  dialog.addEventListener("keyup", (e) => e.stopPropagation());
  $("preview-button").onclick = () => {
    const e = settings.effects,
      stage = $("preview-stage");
    clearTimeout(timer);
    stage.className = "";
    void stage.offsetWidth;
    stage.className = `preview-animate ${e.shake ? "shake" : ""} ${e.particles ? "dust" : ""} ${e.reduced ? "" : "pop"}`;
    $("preview-feedback").textContent = e.reduced
      ? "已预览静态提示。不计分、不发声、不震动。"
      : "已预览一次合成。不计分、不发声、不震动。";
    timer = setTimeout(() => {
      stage.className = "";
    }, 650);
  };
  drawCrabIcon($("preview-crab"), 7, 70, 55, 2);
  paint();
  return {
    open(value = { mode: "classic" }) {
      context = value;
      tab(false);
      paint();
      onPause(true);
      if (!dialog.open) dialog.showModal();
      $("rules-tab").focus();
    },
    destroy() {
      dialog.close();
      unsubscribe();
      dialog.remove();
    },
  };
}
