// Isolated UI demonstration: no storage, network, real physics or score submission.
import { drawCrabIcon } from '../../../src/crabs.js';
const $ = (id) => document.getElementById(id);
const model = {
  mode: 'daily',
  phase: 'hub',
  kind: 'formal',
  identity: 'guest',
  left: 3,
  drops: 0,
  score: 0,
  saved: false,
  paused: false,
  midnight: false,
  restoreOffline: false,
  pending: false,
  error: false,
  cached: true,
  expired: false,
  seconds: 8,
  bestDaily: 0,
  classicScore: 1282,
};
let timer;
const show = (id, visible) => $(id).classList.toggle('hidden', !visible);
function dialog(title, paragraphs, actions, name = false) {
  $('dialog-title').textContent = title;
  $('dialog-copy').replaceChildren(
    ...paragraphs.map((text) => {
      const p = document.createElement('p');
      p.textContent = text;
      return p;
    }),
  );
  show('name-field', name);
  $('dialog-actions').replaceChildren(
    ...actions.map(([label, action, secondary]) => {
      const button = document.createElement('button');
      button.className = `btn${secondary ? ' ghost' : ''}`;
      button.textContent = label;
      button.onclick = () => {
        $('dialog').close();
        action();
      };
      return button;
    }),
  );
  if (!$('dialog').open) $('dialog').showModal();
}
function stopTimer() {
  clearInterval(timer);
  timer = undefined;
}
function draw() {
  const ctx = $('scene').getContext('2d');
  ctx.fillStyle = '#151a2e';
  ctx.fillRect(0, 0, 400, 640);
  ctx.fillStyle = '#242840';
  for (let y = 18; y < 640; y += 22) for (let x = 14; x < 400; x += 22) ctx.fillRect(x, y, 2, 2);
  ctx.strokeStyle = '#b56b68';
  ctx.setLineDash([7, 7]);
  ctx.beginPath();
  ctx.moveTo(0, 140);
  ctx.lineTo(400, 140);
  ctx.stroke();
  ctx.setLineDash([]);
  const placements = [
    [7, 125, 460, 130],
    [4, 280, 480, 85],
    [5, 210, 383, 90],
    [2, 330, 430, 65],
    [3, 67, 355, 72],
    [6, 310, 325, 103],
    [2, 137, 294, 60],
  ];
  if (model.drops > 0 || model.mode === 'classic')
    for (const [level, x, y, width] of placements) {
      const icon = document.createElement('canvas');
      drawCrabIcon(icon, level, width, width * 0.78, 1);
      ctx.drawImage(icon, x - width / 2, y + 105 - width * 0.39);
    }
  if (model.phase !== 'settling' && model.drops < 100) {
    const icon = document.createElement('canvas');
    drawCrabIcon(icon, 2, 40, 32, 1);
    ctx.drawImage(icon, 180, 42);
  }
}
function render() {
  const classic = model.mode === 'classic',
    hub = !classic && ['hub', 'loading', 'error'].includes(model.phase);
  const playing = classic || ['playing', 'settling'].includes(model.phase);
  const formal = model.kind === 'formal';
  $('scenario').value = classic
    ? 'classic'
    : model.phase === 'result'
      ? model.pending
        ? 'pending'
        : 'result'
      : model.phase === 'playing'
        ? model.expired
          ? 'expired'
          : model.midnight
            ? 'midnight'
            : formal
              ? 'playing'
              : 'practice'
        : model.phase === 'hub'
          ? model.restoreOffline
            ? 'restore-offline'
            : model.saved
              ? 'resume'
              : model.left === 0
                ? 'exhausted'
                : 'hub'
          : model.phase === 'error' && !model.cached
            ? 'no-cache'
            : model.phase;
  show('next', classic || model.drops < 100);
  document.querySelector('.next .sub').textContent = !classic && model.drops >= 100 ? '已投完' : '下一个';
  const who = {
    guest: '游客 · 橙色钳子 #4821',
    linuxdo: 'LINUX DO · fucdd',
    none: '尚未创建身份 · 可直接练习',
  };
  $('identity-label').textContent = who[model.identity];
  $('classic-mode').setAttribute('aria-pressed', String(classic));
  $('daily-mode').setAttribute('aria-pressed', String(!classic));
  for (const id of ['classic-mode', 'daily-mode', 'return-hub', 'restart'])
    $(id).disabled = model.phase === 'settling';
  show('hub', hub);
  show('game-panel', playing);
  show('result-panel', !classic && model.phase === 'result');
  $('attempts').innerHTML = `${model.left} <small>/ 3 次</small>`;
  $('daily-best').textContent = model.bestDaily
    ? `${model.bestDaily.toLocaleString('en-US')} 分`
    : '还没有正式成绩';
  const loading = model.phase === 'loading',
    error = model.phase === 'error';
  $('day-copy').textContent = loading
    ? '正在获取今日题目与正式机会…'
    : error
      ? '暂时无法获取今日题目'
      : '北京时间 00:00 换题 · 今日题目已就绪';
  $('start-formal').disabled = loading || (!error && model.left === 0 && !model.saved);
  $('start-formal').textContent = loading
    ? '正在读取今日挑战…'
    : error
      ? '重新连接'
      : model.saved
        ? formal
          ? `继续正式第 ${3 - model.left} 次 · 不扣机会`
          : '继续未完成的练习'
        : model.left === 0
          ? '今日正式机会已用完'
          : model.identity === 'none'
            ? '起个名字，开始正式挑战'
            : '开始正式挑战';
  $('start-practice').disabled = loading || (error && !model.cached);
  $('start-practice').textContent =
    error && model.cached
      ? '练习已缓存的 10 月 02 日题目'
      : error
        ? '尚无缓存题目，可先玩经典'
        : '先练一局 · 不限次数';
  $('entry-note').textContent =
    model.left === 0
      ? '明日 00:00 重置机会。练习不会进入正式榜。'
      : '领取开局凭证后消耗 1 次；刷新续玩不再扣次。';
  show('resume-card', model.saved);
  $('resume-card').querySelector('b').textContent = formal ? '有一局正式挑战还没结束' : '有一局练习还没结束';
  $('resume-card').querySelector('p').textContent =
    `${model.score.toLocaleString('en-US')} 分 · 剩余 ${100 - model.drops} 投`;
  $('resume-card').querySelector('.sub').textContent = formal
    ? '继续原局不再扣机会。'
    : '练习不参与正式排名。';
  show('notice', error || model.restoreOffline || model.left === 0);
  $('notice').textContent = error
    ? '连接失败。不会扣正式机会；重新连接后获取服务器确认的今日题目。'
    : model.restoreOffline
      ? '原局仍保留，但暂时无法核验正式资格。不会重新领取机会。'
      : '今天的 3 次正式机会已用完，仍可不限次练习。';
  $('round-kind').textContent = classic
    ? '经典 · 本地游玩'
    : formal
      ? `正式 · 第 ${3 - model.left} 次`
      : '练习 · 不参与排名';
  $('round-kind').classList.toggle('practice', !formal || classic);
  $('round-day').textContent = classic ? '' : model.midnight ? '昨日题目 · 10/02' : '10 月 02 日';
  show('return-hub', !classic);
  $('score').textContent = (classic ? model.classicScore : model.score).toLocaleString('en-US');
  $('remaining-label').textContent = classic ? '模式' : '剩余投放';
  $('remaining').innerHTML = classic
    ? '<small>自由合成</small>'
    : `${Math.max(0, 100 - model.drops)} <small>/ 100</small>`;
  show('game-note', !classic && model.midnight);
  $('game-note').textContent = '日期已更新。这局仍是 10/02 的题目，须在 10/03 00:10 前提交；不会中途换题。';
  const settling = model.phase === 'settling';
  show('board-overlay', model.paused || settling || model.expired);
  $('board-overlay').classList.toggle('settling', settling);
  $('overlay-title').textContent = model.expired
    ? '正式提交截止已过'
    : settling
      ? `结算中 · ${model.seconds} 秒`
      : '已暂停';
  $('overlay-copy').textContent = model.expired
    ? '这局不能再计入正式榜。可继续本地练习，保留当前棋盘。'
    : settling
      ? '已投完 100 次。停止投放与道具操作，落稳后会提前结算。'
      : classic
        ? '经典局已暂停，准备好了再继续。'
        : '棋盘与游戏计时已暂停。正式提交截止时间仍按北京时间计算。';
  $('board').setAttribute('aria-disabled', String(settling || model.paused || model.expired));
  $('claw').disabled = settling || model.paused || model.expired;
  $('pause').disabled = settling;
  $('pause').textContent = model.expired ? '转为练习继续' : model.paused ? '继续' : '暂停';
  $('save-status').textContent = classic
    ? '经典局已保存；每日挑战的进度独立保留。'
    : settling
      ? '正在完成最后的合成；不会再接受新投放。'
      : '当前挑战已自动保存；经典局仍保留。';
  if (model.phase === 'result') {
    $('result-kind').textContent = formal ? '正式挑战完成' : '练习完成 · 不参与排名';
    $('result-kind').classList.toggle('practice', !formal);
    $('result-score').textContent = model.score.toLocaleString('en-US');
    $('result-detail').textContent =
      `${model.drops} / 100 投 · ${model.drops === 100 ? '投放用尽' : '危险线持续超时'} · 最高合成：魔法Clawd`;
    const heading = document.createElement('b'),
      copy = document.createElement('p');
    heading.textContent = !formal
      ? '只记录本次练习'
      : model.pending
        ? '成绩已暂存，等待联网'
        : '已计入今日成绩';
    copy.textContent = !formal
      ? '不消耗正式机会，也不会进入今日榜。'
      : model.pending
        ? '旧题最迟 10/03 00:10 前提交。新开一局不会覆盖这条待提交成绩。'
        : `今日个人最好 ${Math.max(model.bestDaily, model.score).toLocaleString('en-US')} · 当前排名 #12`;
    $('result-status').replaceChildren(heading, copy);
    $('result-status').classList.toggle('pending', model.pending);
    $('result-primary').textContent = model.pending
      ? '立即重试提交'
      : !formal
        ? `返回正式挑战 · 还剩 ${model.left} 次`
        : model.left
          ? `再挑战一次 · 还剩 ${model.left} 次`
          : '今日机会用完 · 继续练习';
    show('result-ranking', formal && !model.pending);
  }
  draw();
}
function start(kind, resume = false) {
  model.mode = 'daily';
  model.kind = kind;
  model.phase = 'playing';
  model.paused = false;
  model.expired = false;
  if (!resume) {
    model.drops = 0;
    model.score = 0;
    model.midnight = false;
  }
  model.saved = false;
  model.restoreOffline = false;
  model.pending = false;
  render();
  $('board').focus();
}
function formal() {
  if (model.phase === 'error') {
    model.phase = 'hub';
    model.error = false;
    render();
    return;
  }
  if (model.saved) {
    if (model.restoreOffline && model.kind === 'formal') {
      dialog(
        '暂时无法核验原局',
        [
          '原局与机会都保留。继续正式挑战需要联网核验，重试不会扣新机会。',
          '转为练习后，这局不能再恢复正式资格。',
        ],
        [
          ['重试核验', () => start('formal', true)],
          ['转为练习继续', () => start('practice', true), true],
          ['返回入口，保留原局', () => {}, true],
        ],
      );
      return;
    }
    start(model.kind, true);
    return;
  }
  if (model.left === 0) return;
  if (model.identity === 'none') {
    dialog(
      '起个名字，参加挑战',
      ['游客也有每日 3 次正式机会。也可以用 LINUX DO 身份参加。'],
      [
        [
          '使用这个游客身份',
          () => {
            model.identity = 'guest';
            $('identity').value = 'guest';
            formal();
          },
        ],
        [
          '用 LINUX DO 参加',
          () => {
            model.identity = 'linuxdo';
            $('identity').value = 'linuxdo';
            formal();
          },
          true,
        ],
        ['先练一局', () => start('practice'), true],
      ],
      true,
    );
    return;
  }
  dialog(
    '开始一次正式挑战？',
    [
      `今日还剩 ${model.left} 次。领取开局凭证成功后消耗 1 次；中途放弃不会退回。`,
      '100 次投放，最后一投后最多结算 8 秒。刷新可继续原局，不会再扣次。',
      '本题正式成绩最迟在 10/03 00:10 前提交。',
    ],
    [
      [
        '开始正式挑战 · 消耗 1 次',
        () => {
          model.left--;
          start('formal');
        },
      ],
      ['先练习，不用机会', () => start('practice'), true],
    ],
  );
}
function practice() {
  if (model.saved && model.kind === 'formal') {
    dialog(
      '用练习替换未完成挑战？',
      ['当前正式挑战还没结束。新开练习会放弃这局正式资格，已经用掉的机会不会退回。', '经典局不受影响。'],
      [
        ['继续原来的正式局', () => formal()],
        ['放弃正式局，开始练习', () => start('practice'), true],
      ],
    );
    return;
  }
  start('practice');
}
function result() {
  stopTimer();
  if (model.kind === 'formal' && !model.pending) model.bestDaily = Math.max(model.bestDaily, model.score);
  model.phase = 'result';
  model.saved = false;
  model.paused = false;
  render();
}
function settle() {
  stopTimer();
  model.phase = 'settling';
  model.drops = 100;
  model.seconds = 8;
  model.paused = false;
  render();
  timer = setInterval(() => {
    model.seconds--;
    if (model.seconds <= 0) result();
    else render();
  }, 1000);
}
function drop() {
  if (
    model.mode !== 'daily' ||
    model.phase !== 'playing' ||
    model.paused ||
    model.expired ||
    model.drops >= 100
  )
    return;
  model.drops++;
  model.score += 32;
  if (model.drops === 100) settle();
  else render();
}
function hub() {
  if (model.phase === 'playing') model.saved = true;
  model.phase = 'hub';
  model.paused = false;
  render();
}
function scenario(value) {
  stopTimer();
  $('dialog').close();
  Object.assign(model, {
    mode: 'daily',
    phase: 'hub',
    kind: 'formal',
    left: 3,
    drops: 0,
    score: 0,
    saved: false,
    paused: false,
    midnight: false,
    restoreOffline: false,
    pending: false,
    error: false,
    cached: true,
    expired: false,
    bestDaily: 0,
  });
  if (value === 'classic') model.mode = 'classic';
  if (['playing', 'practice', 'midnight', 'expired'].includes(value))
    Object.assign(model, {
      phase: 'playing',
      left: 2,
      drops: 63,
      score: 2864,
      kind: value === 'practice' ? 'practice' : 'formal',
      midnight: ['midnight', 'expired'].includes(value),
      expired: value === 'expired',
    });
  if (['result', 'pending'].includes(value))
    Object.assign(model, {
      phase: 'result',
      left: 2,
      drops: 100,
      score: 9764,
      pending: value === 'pending',
      bestDaily: value === 'result' ? 9764 : 0,
    });
  if (value === 'exhausted') model.left = 0;
  if (['resume', 'restore-offline'].includes(value))
    Object.assign(model, {
      saved: true,
      left: 2,
      drops: 63,
      score: 2864,
      restoreOffline: value === 'restore-offline',
    });
  if (value === 'loading') model.phase = 'loading';
  if (['error', 'no-cache'].includes(value))
    Object.assign(model, { phase: 'error', error: true, cached: value === 'error' });
  if (value === 'settling') {
    model.left = 2;
    model.score = 9764;
    settle();
  } else render();
}
$('scenario').onchange = () => scenario($('scenario').value);
$('identity').onchange = () => {
  model.identity = $('identity').value;
  render();
};
$('wire').onchange = () => document.body.classList.toggle('wireframe', $('wire').checked);
$('classic-mode').onclick = $('return-classic').onclick = () => {
  if (model.phase === 'playing') model.saved = true;
  model.mode = 'classic';
  render();
};
$('daily-mode').onclick = () => {
  model.mode = 'daily';
  hub();
};
$('return-hub').onclick = hub;
$('start-formal').onclick = formal;
$('start-practice').onclick = practice;
$('board').onclick = drop;
$('board').onkeydown = (event) => {
  if (event.code === 'Space' || event.code === 'Enter') {
    event.preventDefault();
    drop();
  }
};
$('pause').onclick = () => {
  if (model.expired) {
    model.kind = 'practice';
    model.expired = false;
  } else model.paused = !model.paused;
  render();
};
$('restart').onclick = () => {
  if (model.mode === 'classic') {
    dialog(
      '重新开始经典模式？',
      ['当前经典棋盘与分数将清空，每日挑战进度会保留。'],
      [
        ['保留这局', () => {}],
        [
          '重新开始经典',
          () => {
            model.classicScore = 0;
            render();
          },
          true,
        ],
      ],
    );
    return;
  }
  dialog(
    '新开一局挑战？',
    ['当前挑战的棋盘和分数会清空，已经使用的正式机会不退回。'],
    [
      ['保留这局', () => {}],
      [
        '放弃这局，返回每日入口',
        () => {
          model.saved = false;
          model.phase = 'hub';
          render();
        },
        true,
      ],
    ],
  );
};
$('claw').onclick = () =>
  dialog(
    '钳子',
    ['原型仅展示操作位置。真实玩法沿用经典规则；最后一投后停止道具操作。'],
    [['知道了', () => {}]],
  );
$('result-primary').onclick = () => {
  if (model.pending) {
    model.pending = false;
    model.bestDaily = Math.max(model.bestDaily, model.score);
    render();
  } else if (model.kind === 'practice') {
    model.phase = 'hub';
    render();
  } else if (model.left) formal();
  else practice();
};
$('result-practice').onclick = () => start('practice');
$('result-back').onclick = () => {
  model.phase = 'hub';
  render();
};
$('result-ranking').onclick = () =>
  dialog(
    '今日榜 · 10 月 02 日',
    [
      `示例排名 #12 · ${model.score.toLocaleString('en-US')} 分`,
      '这里只展示本题正式成绩。练习和经典模式各自独立。',
    ],
    [['返回结果', () => {}]],
  );
$('rules').onclick = $('help').onclick = () =>
  dialog(
    '每日挑战怎么玩',
    [
      '所有人面对同一道题。北京时间每日 00:00 更新，100 次投放。',
      '游客与 LINUX DO 用户都有每日 3 次正式机会；练习不限次数，不进入正式榜。',
      '最后一投后最多结算 8 秒，落稳可提前结束；这段时间不能再投放或使用道具。',
      '跨日不换掉当前棋盘，旧题最迟次日 00:10 前提交。暂停不会延长正式截止。',
    ],
    [['知道了', () => {}]],
  );
$('close-dialog').onclick = () => $('dialog').close();
$('last-drop').onclick = () => {
  stopTimer();
  Object.assign(model, {
    mode: 'daily',
    phase: 'playing',
    left: 2,
    drops: 99,
    score: 6240,
    paused: false,
    expired: false,
  });
  render();
};
$('settled').onclick = () => {
  if (model.phase === 'settling') result();
};
$('danger').onclick = () => {
  if (model.mode === 'daily' && model.phase === 'playing') result();
};
drawCrabIcon($('hero-crab'), 7, 90, 65, 2);
drawCrabIcon($('next'), 3, 40, 35, 2);
render();
