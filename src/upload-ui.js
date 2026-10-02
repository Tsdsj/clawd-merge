const ERROR_TEXT = {
  session_expired: '原成绩凭证已过期，已停止重试。',
  bad_session: '原成绩凭证无效，已停止重试。',
  no_session: '没有收到原在线凭证，不能重新申请凭证补交旧分。',
  score_conflict: '该局已接受不同内容，不能覆盖原成绩。',
  too_fast: '成绩未通过投放耗时校验，已停止重试。',
  implausible: '成绩未通过分数校验，已停止重试。',
};

export function createUploadUI({
  outbox,
  showModal,
  closeOthers,
  isGameOver,
  openAccount,
  openRanks,
  notify,
}) {
  const $ = (id) => document.getElementById(id),
    queue = $('pending-modal'),
    removeModal = $('remove-result-modal');
  let currentKey = null,
    removeKey = null,
    context = '';
  function presentation(e) {
    if (e.state === 'accepted')
      return {
        title: e.receipt.improved ? '已上传 · 个人新纪录' : '已上传',
        tone: 'success',
        text: `提交时个人最佳排名 ${e.receipt.rank ? '#' + e.receipt.rank : '—'}。${e.cleanupPending ? '本机记录清理失败，可以重试清理。' : '最新名次可在排行榜查看。'}`,
        action: e.cleanupPending ? '重试清理' : '查看排行榜',
      };
    if (e.state === 'removed')
      return { title: '本机记录已移除', text: '不再由本机自动补传；不会删除服务端已接受的成绩。' };
    if (e.state === 'corrupt')
      return { title: '这条记录暂时无法读取', tone: 'warning', text: '记录损坏或版本不兼容，尚未自动删除。' };
    if (!e.durable && !e.journaled)
      return {
        title: '尚未保存，请勿刷新',
        tone: 'warning',
        text:
          e.error === 'queue_full'
            ? '待处理队列已满，目前只保留在这一页。可先处理其他记录。'
            : '本机写入失败，目前只保留在这一页。关闭或刷新可能丢失成绩。',
        action: e.state === 'uploading' ? null : e.state === 'rejected' ? '重试保存记录' : '重试保存并上传',
      };
    if (e.state === 'ticket')
      return { title: '正在等待原成绩凭证…', text: '结束结果已保留，不会重新申请凭证冒充原局。' };
    if (e.state === 'identity')
      return {
        title: '等待原身份处理',
        tone: 'warning',
        text: `成绩属于 ${e.playerName}，不会用其他账号上传。请重新登录原身份。`,
        action: '前往账号',
      };
    if (e.state === 'rejected')
      return {
        title: '本局无法上榜',
        tone: 'warning',
        text: ERROR_TEXT[e.error] || '服务端拒绝了这条成绩，已停止自动重试。',
      };
    if (e.state === 'uploading')
      return { title: '正在上传成绩…', text: '结果已暂存，你可以直接开始下一局。' };
    if (e.error === 'rate_limited' || e.error === 'http_429')
      return {
        title: e.attempts >= 4 ? '已暂存，自动重试已暂停' : '已暂存，等待服务器允许重试',
        tone: 'warning',
        text: '请求过于频繁，将遵守服务器等待时间；之后可手动重试。',
        action: '稍后重试',
      };
    return {
      title: e.attempts >= 4 ? '已暂存，自动重试已暂停' : '已暂存，等待补传',
      tone: 'warning',
      text: e.attempts >= 4 ? '记录保留，稍后可以手动重试。' : '联网后会尝试补传；开始新局不会覆盖这条记录。',
      action: '立即重试',
    };
  }
  async function action(entry) {
    if (['rate_limited', 'http_429'].includes(entry.error) && entry.nextAt > Date.now()) {
      notify(`服务器要求继续等待，约 ${Math.ceil((entry.nextAt - Date.now()) / 1000)} 秒后可重试。`);
      return;
    }
    if (entry.state === 'identity') {
      showModal(queue, false);
      openAccount();
      return;
    }
    if (entry.state === 'accepted' && !entry.cleanupPending) {
      showModal(queue, false);
      openRanks();
      return;
    }
    await outbox.retry(entry.key);
    render();
  }
  function button(label, entry, kind, handler) {
    const b = document.createElement('button');
    b.className = kind === 'remove' ? 'link-btn' : 'btn ghost';
    b.type = 'button';
    b.textContent = label;
    b.dataset.key = entry.key;
    b.dataset.action = kind;
    b.onclick = async () => {
      b.disabled = true;
      try {
        await handler();
      } finally {
        b.disabled = false;
      }
    };
    return b;
  }
  function renderQueue() {
    const focus = document.activeElement?.dataset;
    const entries = outbox.list();
    $('pending-list').replaceChildren();
    $('pending-context').textContent = entries.length
      ? context || '成绩绑定原对局和原身份；开始新局不会覆盖旧结果。'
      : '待处理记录已处理完，可以返回游戏。';
    if (outbox.readError)
      $('pending-context').textContent = '暂时无法读取本机队列。已知记录仍保留，请恢复浏览器存储后重试。';
    if (!entries.length) {
      const row = document.createElement('li');
      row.textContent = outbox.readError ? '本机存储不可读取' : '没有待处理成绩';
      $('pending-list').append(row);
    }
    for (const entry of entries) {
      const row = document.createElement('li'),
        heading = document.createElement('b'),
        meta = document.createElement('p'),
        status = document.createElement('p');
      const view = presentation(entry);
      heading.textContent = Number.isFinite(entry.score)
        ? entry.score.toLocaleString('zh-CN')
        : '记录无法读取';
      meta.textContent = entry.playerName ? `原身份：${entry.playerName} · 经典模式` : '';
      status.textContent = `${view.title}。${view.text}`;
      row.append(heading, meta, status);
      if (view.action) {
        const retry = button(view.action, entry, 'retry', () => action(entry));
        retry.disabled = outbox.inflight.has(entry.key) || entry.state === 'uploading';
        row.append(retry);
      }
      const remove = button('移除本机记录', entry, 'remove', () => {
        removeKey = entry.key;
        showModal(queue, false);
        $('remove-result-copy').textContent =
          `移除后本机不再补传${Number.isFinite(entry.score) ? '这条 ' + entry.score + ' 分成绩' : '这条记录'}。不会删除本机最高分或服务端已接受的成绩。`;
        showModal(removeModal, true);
      });
      remove.disabled = outbox.inflight.has(entry.key) || entry.state === 'uploading';
      row.append(remove);
      $('pending-list').append(row);
    }
    if (focus?.key) {
      const target = [...$('pending-list').querySelectorAll('button')].find(
        (b) => b.dataset.key === focus.key && b.dataset.action === focus.action && !b.disabled,
      );
      (target || $('pending-close')).focus({ preventScroll: true });
    }
  }
  function render() {
    const entries = outbox.list();
    $('pending-btn').classList.toggle('hidden', !entries.length && !outbox.readError);
    $('pending-btn').textContent = outbox.readError ? '待处理记录不可读取' : `待处理成绩 ${entries.length}`;
    $('pending-note').classList.toggle('hidden', !entries.length || isGameOver());
    $('pending-note').textContent = entries.some((e) => !e.durable && !e.journaled && e.state !== 'accepted')
      ? '有成绩尚未写入本机，请勿刷新；可在“待处理”中重试。'
      : '有旧成绩待处理，不影响当前这局。';
    const entry = currentKey ? outbox.get(currentKey) : null;
    $('upload-state').classList.toggle('hidden', !entry || !isGameOver());
    if (entry && isGameOver()) {
      const view = presentation(entry);
      $('upload-state').dataset.tone = view.tone || 'normal';
      $('upload-title').textContent = view.title;
      $('upload-description').textContent = view.text;
      $('upload-retry').classList.toggle('hidden', !view.action);
      $('upload-retry').textContent = view.action || '';
      $('upload-retry').disabled = outbox.inflight.has(entry.key);
      $('upload-retry').onclick = () => void action(entry);
    }
    if (!queue.classList.contains('hidden')) renderQueue();
  }
  function open(message = '') {
    context = message;
    closeOthers();
    renderQueue();
    showModal(queue, true);
  }
  $('pending-btn').onclick = () => open();
  $('pending-close').onclick = () => showModal(queue, false);
  $('keep-result').onclick = () => {
    showModal(removeModal, false);
    open(context);
  };
  $('remove-result').onclick = async () => {
    const button = $('remove-result');
    button.disabled = true;
    try {
      if (await outbox.remove(removeKey)) {
        showModal(removeModal, false);
        notify('本机记录已移除');
        render();
      } else
        $('remove-result-copy').textContent = '暂未移除：可能正在处理，或浏览器暂不允许清理。请稍后重试。';
    } finally {
      button.disabled = false;
    }
  };
  return {
    render,
    open,
    setCurrent(key) {
      currentKey = key;
      render();
    },
    hasCurrent() {
      return Boolean(currentKey && outbox.get(currentKey));
    },
    hasUnresolved(playerId) {
      const entries = outbox.list();
      return (
        outbox.readError ||
        entries.some((e) => e.state === 'corrupt' || (e.playerId === playerId && e.state !== 'accepted'))
      );
    },
  };
}
