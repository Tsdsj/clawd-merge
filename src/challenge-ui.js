import { Game, WORLD_W, WORLD_H, enableHaptics } from './game.js';
import { drawCrabIcon, defOf } from './crabs.js';
import { sfx } from './audio.js';
import { PauseState } from './pause.js';
import { getStorage } from './storage.js';
import { ChallengeStore } from './challenge-store.js';
import { ChallengeSession } from './challenge-session.js';
import { challengeService, SETTLE_SECONDS } from './challenge.js';

export function createChallengeUI({ scope, identity, classicSummary, onEnter, onExit }) {
  const $ = (id) => document.getElementById(`daily-${id}`);
  const root = $('app'),
    board = $('board'),
    canvas = $('canvas'),
    dialog = $('dialog');
  let active = false,
    view = 'hub',
    session,
    last = performance.now(),
    pointer = null,
    aiming = false;
  let definition = challengeService.practice(),
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
    channelFactory: typeof BroadcastChannel === 'function' ? (name) => new BroadcastChannel(name) : null,
  });
  const show = (id, visible) => $(id).classList.toggle('hidden', !visible);
  const dateLabel = (id) =>
    /^\d{4}-\d{2}-\d{2}$/.test(id) ? `${Number(id.slice(5, 7))} 月 ${Number(id.slice(8))} 日` : id;
  const current = () => session?.game;
  function clearInput() {
    aiming = false;
    keys.clear();
    if (current()) current().pendingDrop = false;
    if (pointer !== null && board.hasPointerCapture(pointer)) board.releasePointerCapture(pointer);
    pointer = null;
  }
  function syncPause() {
    const game = current(),
      paused = !active || view !== 'play' || pauses.paused || Boolean(session?.handoffPaused);
    if (game && game.paused !== paused) {
      clearInput();
      game.setPaused(paused);
      last = performance.now();
    }
    updatePlay();
  }
  function ask(title, copy, choices) {
    $('dialog-title').textContent = title;
    $('dialog-copy').textContent = copy;
    $('dialog-actions').replaceChildren(
      ...choices.map(([label, action, secondary]) => {
        const button = document.createElement('button');
        button.className = `btn${secondary ? ' ghost' : ''}`;
        button.textContent = label;
        button.onclick = () => {
          dialog.close();
          action();
        };
        return button;
      }),
    );
    pauses.set('dialog', true);
    dialog.showModal();
  }
  dialog.addEventListener('close', () => {
    pauses.set('dialog', false);
    if (view === 'play') board.focus({ preventScroll: true });
  });
  function layout() {
    if (!active || view !== 'play' || !current()) return;
    const rect = $('stage').getBoundingClientRect();
    const width = Math.floor(Math.min(rect.width - 6, ((rect.height - 6) * WORLD_W) / WORLD_H));
    if (width <= 0) return;
    board.style.width = `${width}px`;
    board.style.height = `${(width * WORLD_H) / WORLD_W}px`;
    current().resize(width, (width * WORLD_H) / WORLD_W, Math.min(devicePixelRatio || 1, 3));
    laidOutGame = current();
    layoutView = view;
    lastNext = undefined;
    updatePlay();
    current().render();
  }
  function updatePlay() {
    const game = current();
    if (!game) return;
    $('score').textContent = String(game.score);
    if (lastRemaining !== game.drops) {
      $('remaining').replaceChildren(
        document.createTextNode(`${100 - game.drops} `),
        Object.assign(document.createElement('small'), { textContent: '/ 100' }),
      );
      lastRemaining = game.drops;
    }
    $('round-day').textContent = dateLabel(game.challenge.challengeId);
    $('next-label').textContent = game.next === null ? '已投完' : '下一个';
    show('next', game.next !== null);
    if (game.next !== null && lastNext !== game.next) {
      drawCrabIcon($('next'), game.next, 40, 30, Math.min(devicePixelRatio || 1, 3));
      lastNext = game.next;
    }
    $('claw').textContent = `钳子 ×${game.claws}`;
    $('claw').disabled = game.over || game.settling || game.paused || (!game.claws && !game.clawMode);
    $('claw').classList.toggle('active', game.clawMode);
    board.classList.toggle('claw-mode', game.clawMode);
    board.classList.toggle('fever', game.fever);
    const paused = game.paused && view === 'play' && !dialog.open;
    show('paused', paused);
    $('pause').textContent = paused ? '继续' : '暂停';
    $('pause-copy').textContent = pauses.has('background')
      ? '离开时已暂停，准备好了再继续。'
      : '棋盘与结算计时已暂停。';
    for (const id of ['pause', 'restart', 'home', 'classic', 'tab', 'help'])
      $(id).disabled = game.settling && view === 'play' && !game.over;
    show('settling', game.settling && !paused);
    $('settle-time').textContent =
      `结算中 · ${Math.max(0, Math.ceil(SETTLE_SECONDS - game.challenge.settlingTime))} 秒`;
    const old = game.challenge.challengeId !== definition.challengeId;
    show('midnight', old);
    $('midnight').textContent =
      `这是 ${dateLabel(game.challenge.challengeId)} 的练习，仍按原题继续，不会中途换题。`;
    $('save-status').textContent =
      session.warning ||
      (session.temporary ? '临时练习 · 只保留在本页' : '挑战已保存在本机 · 经典局独立保留');
    show('save-retry', Boolean(session.warning) && !session.temporary);
    $('sound').classList.toggle('muted', !sfx.enabled);
  }
  function paint() {
    if (!active || !session) return;
    const previousView = view;
    if (session.status !== 'active') view = 'hub';
    else if (current()?.over) view = 'result';
    show('hub', view === 'hub');
    show('play', view === 'play');
    show('result', view === 'result');
    $('identity').textContent = identity() || '本地练习 · 无需登录';
    $('date').textContent = dateLabel(definition.challengeId);
    $('classic-note').textContent = classicSummary();
    const saved = session.record?.game,
      busy = session.status === 'busy',
      unavailable = session.status === 'unavailable';
    const hasSave = Boolean(saved) && ['saved', 'active'].includes(session.status);
    show('resume', hasSave);
    if (hasSave) {
      const headline = document.createElement('b');
      headline.textContent = saved.challenge.phase === 'finished' ? '上次练习已经结束' : '有一局练习还没结束';
      $('resume').replaceChildren(
        headline,
        document.createTextNode(
          `${dateLabel(saved.challenge.challengeId)} · ${saved.score} 分 · 剩余 ${100 - saved.drops} 投`,
        ),
      );
    }
    show('resume-btn', hasSave || busy);
    $('practice').classList.toggle('ghost', hasSave);
    $('resume-btn').textContent = busy
      ? '接管挑战对局'
      : saved?.challenge.phase === 'finished'
        ? '查看上次练习结果'
        : '继续上次练习';
    $('practice').disabled = session.status === 'initializing' || busy;
    $('practice').textContent =
      session.status === 'initializing'
        ? '正在读取本机挑战…'
        : busy
          ? '挑战正在另一页进行'
          : unavailable
            ? '临时练习 · 不保存'
            : hasSave
              ? '新练一局今日题目'
              : '开始练习 · 不限次数';
    const notices = {
      busy: '另一页正在使用挑战存档。接管前须让原页保存并暂停；经典局不受影响。',
      invalid: '挑战存档损坏或版本不兼容。新开前会请你确认，原记录不会自动覆盖。',
      unavailable: '当前浏览器无法安全保存挑战。临时练习不会覆盖旧存档，刷新后无法恢复。',
    };
    const warning = session.warning || notices[session.status] || '';
    show('hub-warning', Boolean(warning));
    $('hub-warning').textContent = warning;
    show('retry', Boolean(warning) && !busy && !session.temporary);
    if (view === 'result' && current()) {
      const game = current();
      $('final').textContent = game.score.toLocaleString('zh-CN');
      $('result-day').textContent = `${dateLabel(game.challenge.challengeId)} · 每日挑战练习`;
      $('final-detail').textContent =
        `${game.drops} / 100 投 · ${game.challenge.reason === 'limit' ? '投放用尽' : '危险线持续超时'} · 最高合成：${defOf(game.maxLevel).name}`;
      $('result-save').textContent =
        session.warning ||
        (session.temporary ? '结果仅保留在当前页面。' : '练习结果已保存，可在入口重新查看。');
      show('result-retry', Boolean(session.warning) && !session.temporary);
    }
    if (previousView !== view || lastUiStatus !== session.status) {
      if (view === 'hub') $('hub').scrollTop = 0;
      if (view === 'result') $('result').scrollTop = 0;
    }
    lastUiStatus = session.status;
    syncPause();
    if (view === 'play' && (laidOutGame !== current() || layoutView !== view)) requestAnimationFrame(layout);
    layoutView = view;
    if (view === 'result' && previousView !== 'result' && !dialog.open)
      $('again').focus({ preventScroll: true });
  }
  session = new ChallengeSession({
    store,
    onChange: paint,
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
        { challenge },
      ),
  });
  drawCrabIcon($('hero'), 7, 90, 65, 2);
  function start(challenge = definition, temporary = false) {
    if (session.start(challenge, temporary)) {
      view = 'play';
      pauses.clear();
      if (document.hidden) pauses.set('background', true);
      paint();
      board.focus({ preventScroll: true });
    }
  }
  function newPractice(challenge = definition) {
    if (session.status === 'unavailable') {
      ask(
        '开始临时练习？',
        '当前无法自动保存。这次练习只保留在本页，刷新或关闭后不能恢复；原有存档不会被覆盖。',
        [
          ['暂不开局', () => {}, true],
          ['开始临时练习', () => start(challenge, true)],
        ],
      );
      return;
    }
    const unfinished =
      (session.game && !session.game.over) ||
      (session.record?.game.challenge.phase !== 'finished' && Boolean(session.record));
    if (unfinished || session.status === 'invalid') {
      ask(
        '新开一局挑战练习？',
        session.status === 'invalid'
          ? '确认后才替换无法读取的挑战存档。经典存档不会改变。'
          : '这会替换当前未完成的挑战练习。经典局和经典成绩都保留。',
        [
          ['保留原局', () => {}],
          ['放弃原局，开始新练习', () => start(challenge, session.temporary), true],
        ],
      );
      return;
    }
    start(challenge, session.temporary);
  }
  function resume() {
    if (session.status === 'busy') {
      void session.takeover();
      return;
    }
    if (session.status === 'saved' && !session.resume()) return;
    if (session.status === 'active') {
      view = current().over ? 'result' : 'play';
      pauses.clear();
      if (document.hidden) pauses.set('background', true);
      paint();
      (view === 'result' ? $('again') : board).focus({ preventScroll: true });
    }
  }
  function home() {
    if (current()?.settling && !current().over) return;
    clearInput();
    current()?.setPaused(true);
    session.flush();
    view = 'hub';
    paint();
    $('date').focus({ preventScroll: true });
  }
  function leave() {
    if (current()?.settling && view === 'play') return;
    const done = () => {
      clearInput();
      current()?.setPaused(true);
      active = false;
      root.classList.add('hidden');
      onExit();
    };
    if (session.status === 'active' && !session.flush()) {
      ask('挑战尚未保存成功', '切换后棋盘仍保留在这一页，但刷新或关闭可能丢失进度。经典局不受影响。', [
        [
          '留在挑战，重试保存',
          () => {
            session.flush();
            paint();
          },
        ],
        ['仍切回经典', done, true],
      ]);
    } else done();
  }
  function togglePause() {
    if (view !== 'play' || !current() || current().over || current().settling || dialog.open) return;
    if (current().paused) {
      session.handoffPaused = false;
      pauses.resume();
    } else pauses.set('manual', true);
    session.flush();
    updatePlay();
    if (!current().paused) board.focus({ preventScroll: true });
  }
  $('practice').onclick = () => newPractice();
  $('resume-btn').onclick = resume;
  $('retry').onclick = () => {
    if (session.status === 'active') session.flush();
    else void session.initialize();
    paint();
  };
  for (const id of ['save-retry', 'result-retry'])
    $(id).onclick = () => {
      session.flush();
      paint();
    };
  $('home').onclick = $('tab').onclick = $('result-home').onclick = home;
  $('classic').onclick = $('result-classic').onclick = leave;
  $('restart').onclick = () => newPractice(current()?.challengeDefinition || definition);
  $('again').onclick = () => newPractice(current().challengeDefinition);
  $('pause').onclick = $('continue').onclick = togglePause;
  $('claw').onclick = () => {
    sfx.unlock();
    current()?.toggleClaw();
    clearInput();
    updatePlay();
  };
  $('sound').onclick = () => {
    sfx.toggle();
    updatePlay();
  };
  $('help').onclick = () =>
    ask(
      '每日挑战怎么玩',
      '每局 100 次投放，所有相同题目使用同一掉落序列。练习不限次数，不上榜。\n最后一投后停止投放和道具操作：落稳持续 0.75 秒即可结束，最多结算 8 秒。\n当前题目来自本机北京时间，只作练习。正式机会与榜单尚未开放；接通后游客与 LINUX DO 均可参加，每日 3 次，旧题次日 00:10 截止。',
      [['知道了', () => {}]],
    );
  const playable = () =>
    active &&
    view === 'play' &&
    session.status === 'active' &&
    current() &&
    !current().over &&
    !current().paused &&
    !current().settling &&
    !dialog.open;
  const point = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * WORLD_W, y: ((e.clientY - r.top) / r.height) * WORLD_H };
  };
  board.addEventListener('pointerdown', (e) => {
    if (!playable()) return;
    sfx.unlock();
    if (e.isTrusted && e.pointerType === 'touch') enableHaptics();
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
  board.addEventListener('pointermove', (e) => {
    if (playable() && (aiming || e.pointerType === 'mouse')) current().setAim(point(e).x);
  });
  board.addEventListener('pointerup', (e) => {
    if (!playable() || !aiming || e.pointerId !== pointer) return;
    current().setAim(point(e).x);
    clearInput();
    current().requestDrop();
  });
  board.addEventListener('pointercancel', clearInput);
  board.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('keydown', (e) => {
    if (
      !active ||
      dialog.open ||
      e.target.closest('input,textarea,select') ||
      (e.target.closest('button,a') && ['Space', 'Enter'].includes(e.code))
    )
      return;
    if (e.code === 'KeyP') {
      e.preventDefault();
      if (!e.repeat) togglePause();
      return;
    }
    if (e.code === 'KeyR') {
      e.preventDefault();
      if (!e.repeat && view === 'play' && !current()?.settling) newPractice(current().challengeDefinition);
      return;
    }
    if (!playable()) return;
    if (['ArrowLeft', 'ArrowRight', 'KeyA', 'KeyD'].includes(e.code)) {
      e.preventDefault();
      keys.add(e.code);
    } else if (['Space', 'ArrowDown', 'Enter'].includes(e.code)) {
      e.preventDefault();
      sfx.unlock();
      if (!e.repeat) current().requestDrop();
    } else if (e.code === 'KeyC') {
      current().toggleClaw();
      updatePlay();
    }
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  function background() {
    if (!active) return;
    clearInput();
    if (current() && !current().over) pauses.set('background', true);
    session.flush();
    updatePlay();
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) background();
    last = performance.now();
  });
  window.addEventListener('blur', background);
  window.addEventListener('pagehide', () => {
    background();
    session.leave();
  });
  window.addEventListener('pageshow', (e) => {
    if (e.persisted && active) void session.initialize();
  });
  new ResizeObserver(layout).observe($('stage'));
  window.addEventListener('resize', layout);
  return {
    get active() {
      return active;
    },
    async open() {
      if (active || onEnter() === false) return;
      active = true;
      root.classList.remove('hidden');
      view = 'hub';
      definition = challengeService.practice();
      paint();
      await session.initialize();
      paint();
      $('date').focus({ preventScroll: true });
    },
    frame(now) {
      const dt = Math.max(0, Math.min((now - last) / 1000, 0.1));
      last = now;
      if (now >= nextDateCheck) {
        nextDateCheck = now + 1000;
        const next = challengeService.practice();
        if (next.challengeId !== definition.challengeId) {
          definition = next;
          paint();
        }
      }
      const game = current();
      if (!active || view !== 'play' || !game) return;
      const dir =
        (keys.has('ArrowRight') || keys.has('KeyD') ? 1 : 0) -
        (keys.has('ArrowLeft') || keys.has('KeyA') ? 1 : 0);
      if (dir && playable())
        game.setAim(game.clampAim(game.aimX, game.current) + dir * 280 * Math.min(dt, 0.05));
      game.update(dt);
      session.tick(now);
      updatePlay();
      game.render();
    },
  };
}
