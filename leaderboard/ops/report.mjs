// Read-only aggregate operations. Never select identifiers, names, tokens or IP keys.
const TABLES = [
  "players",
  "tokens",
  "sessions",
  "scores",
  "score_receipts",
  "oauth_states",
  "login_codes",
  "rate_limits",
  "challenge_definitions",
  "challenge_allowances",
  "challenge_sessions",
  "challenge_scores",
  "challenge_bests",
];
const DAY = 86400000;
const unknown = {
  allPlayerParticipation: null,
  actualCompletedRounds: null,
  uploadSuccessRate: null,
  completionRate: null,
  retention: null,
  practiceParticipation: null,
  shareConversion: null,
};
function validate({ from, to, asOf, source }) {
  if (
    ![from, to, asOf].every(
      (n) => Number.isSafeInteger(n) && n >= 0 && n <= 8640000000000000,
    ) ||
    from >= to ||
    to > asOf ||
    to - from > 366 * DAY ||
    typeof source !== "string" ||
    !source.length ||
    source.length > 128
  )
    throw new Error("invalid_report_window");
}
const windowClause = (field, from, to) =>
  `${field} >= ${from} AND ${field} < ${to}`;
const metric = (value) =>
  value === null || value === undefined ? "未知" : String(value);
export async function collectReport(query, options) {
  validate(options);
  const { from, to, asOf, source } = options,
    started = performance.now(),
    costs = [];
  const q = async (label, sql) => {
    const at = performance.now(),
      r = await query(sql);
    if (!r || !Array.isArray(r.rows))
      throw new Error(`invalid_query_result:${label}`);
    costs.push({
      label,
      elapsedMs: Math.round((performance.now() - at) * 100) / 100,
      rowsRead: r.meta?.rows_read ?? null,
      rowsWritten: r.meta?.rows_written ?? null,
    });
    return r.rows;
  };
  const scalar = async (label, sql) => Number((await q(label, sql))[0]?.n ?? 0);
  const schema = new Set(
    (
      await q(
        "schema",
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
    ).map((r) => r.name),
  );
  const r = {
    schemaVersion: 1,
    source,
    window: {
      from,
      to,
      asOf,
      timeZone: "Asia/Shanghai",
      bounds: "from inclusive, to exclusive",
    },
    observedAt: new Date().toISOString(),
    classic: null,
    daily: null,
    observed: null,
    unknown: { ...unknown },
    storage: { tables: {} },
    cleanup: {},
    queryPlans: {},
    queryCosts: costs,
    warnings: [],
  };
  for (const table of TABLES)
    r.storage.tables[table] = schema.has(table)
      ? await scalar(`rows:${table}`, `SELECT COUNT(*) AS n FROM ${table}`)
      : null;
  const acceptedSources = [];
  if (schema.has("scores")) {
    const w = windowClause("created_at", from, to);
    r.classic = (
      await q(
        "classic:accepted",
        `SELECT COUNT(*) AS accepted,COUNT(DISTINCT player_id) AS acceptedPlayers,COALESCE(SUM(score=0),0) AS zeroScores FROM scores WHERE ${w}`,
      )
    )[0];
    r.classic.retainedStarts = schema.has("sessions")
      ? await scalar(
          "classic:retained-starts",
          `SELECT COUNT(*) AS n FROM sessions WHERE ${windowClause("started_at", from, to)}`,
        )
      : null;
    r.classic.issued = null;
    r.classic.cohortAcceptedRatio = null;
    r.classic.receiptsInWindow = schema.has("score_receipts")
      ? await scalar(
          "classic:receipts",
          `SELECT COUNT(*) AS n FROM score_receipts WHERE ${windowClause("accepted_at", from, to)}`,
        )
      : null;
    acceptedSources.push(
      `SELECT player_id,created_at AS at FROM scores WHERE ${w}`,
    );
    r.classic.byDate = await q(
      "classic:days",
      `SELECT date(created_at/1000+28800,'unixepoch') AS day,COUNT(*) AS accepted,COUNT(DISTINCT player_id) AS players FROM scores WHERE ${w} GROUP BY day ORDER BY day`,
    );
  } else r.warnings.push("经典成绩表不存在，经典统计不可用。");
  if (["challenge_sessions", "challenge_scores"].every((t) => schema.has(t))) {
    const w = windowClause("started_at", from, to),
      aw = windowClause("accepted_at", from, to);
    r.daily = (
      await q(
        "daily:starts",
        `SELECT COUNT(*) AS issued,COUNT(DISTINCT player_id) AS startPlayers FROM challenge_sessions WHERE ${w}`,
      )
    )[0];
    Object.assign(
      r.daily,
      (
        await q(
          "daily:accepted",
          `SELECT COUNT(*) AS accepted,COUNT(DISTINCT player_id) AS acceptedPlayers,COALESCE(SUM(score=0),0) AS zeroScores,COALESCE(SUM(reason='limit'),0) AS usedAllDrops FROM challenge_scores WHERE ${aw}`,
        )
      )[0],
    );
    r.daily.cohortAccepted = await scalar(
      "daily:cohort",
      `SELECT COUNT(*) AS n FROM challenge_sessions s JOIN challenge_scores c ON c.session_id=s.id WHERE ${windowClause("s.started_at", from, to)} AND c.accepted_at <= ${asOf}`,
    );
    r.daily.cohortPendingDeadline = await scalar(
      "daily:open-cohort",
      `SELECT COUNT(*) AS n FROM challenge_sessions s WHERE ${windowClause("s.started_at", from, to)} AND s.submit_until > ${asOf} AND NOT EXISTS(SELECT 1 FROM challenge_scores c WHERE c.session_id=s.id AND c.accepted_at <= ${asOf})`,
    );
    r.daily.cohortAcceptedRatio = r.daily.issued
      ? r.daily.cohortAccepted / r.daily.issued
      : null;
    r.daily.byDate = await q(
      "daily:days",
      `SELECT date(started_at/1000+28800,'unixepoch') AS day,COUNT(*) AS issued,COUNT(DISTINCT player_id) AS players FROM challenge_sessions WHERE ${w} GROUP BY day ORDER BY day`,
    );
    acceptedSources.push(
      `SELECT player_id,accepted_at AS at FROM challenge_scores WHERE ${aw}`,
    );
  } else
    r.warnings.push("每日挑战表尚未完整迁移，每日挑战统计为未知，不是零。");
  if (acceptedSources.length) {
    const cte = `WITH accepted AS (${acceptedSources.join(" UNION ALL ")})`;
    r.observed = (
      await q(
        "observed:accepted",
        `${cte} SELECT COUNT(*) AS acceptedRounds,COUNT(DISTINCT player_id) AS acceptedPlayers FROM accepted`,
      )
    )[0];
    r.observed.repeatAcceptedPlayers = await scalar(
      "observed:repeat",
      `${cte} SELECT COUNT(*) AS n FROM (SELECT player_id FROM accepted GROUP BY player_id HAVING COUNT(*)>=2)`,
    );
    r.observed.acceptedOnMultipleDays = await scalar(
      "observed:repeat-days",
      `${cte} SELECT COUNT(*) AS n FROM (SELECT player_id FROM accepted GROUP BY player_id HAVING COUNT(DISTINCT date(at/1000+28800,'unixepoch'))>=2)`,
    );
  }
  if (schema.has("players"))
    r.queryPlans.classic = (
      await q(
        "plan:classic",
        "EXPLAIN QUERY PLAN SELECT id,best_score,best_level,best_at FROM players WHERE best_score>0 ORDER BY best_score DESC,best_at ASC LIMIT 20",
      )
    ).map((v) => v.detail);
  if (schema.has("challenge_bests") && schema.has("players")) {
    const day = new Date(from + 28800000).toISOString().slice(0, 10);
    r.queryPlans.daily = (
      await q(
        "plan:daily",
        `EXPLAIN QUERY PLAN SELECT b.player_id,b.score,b.max_level,b.best_at,p.name FROM challenge_bests b JOIN players p ON p.id=b.player_id WHERE b.challenge_id='${day}' AND b.score>0 ORDER BY b.score DESC,b.best_at ASC,b.player_id ASC LIMIT 20`,
      )
    ).map((v) => v.detail);
  }
  for (const { table, predicate } of cleanupRules(r))
    r.cleanup[table] = await scalar(
      `cleanup:${table}`,
      `SELECT COUNT(*) AS n FROM ${table} WHERE ${predicate}`,
    );
  r.warnings.push(
    "经典凭证已有清理，retainedStarts 不是全部开局；不能以它计算完成率。",
    "旧经典成绩缺少完整幂等回执，按接受记录计数，不能追溯证明所有历史记录都已按一局去重。",
    "只统计服务器可见的身份与接受记录；匿名离线、练习、失败上传和分享行为未采集。",
    "acceptedPlayers 是账号数而非自然人数；游客重建与账号合并会改变历史身份口径。",
    "区间接受数按接受时间统计；每日凭证接受比例按区间开局 cohort 截至 asOf 统计，两者不可混除。",
    "只有一份快照不能说明增长或留存改善；多次查询的远程表存量不是事务一致快照。",
  );
  r.elapsedMs = Math.round((performance.now() - started) * 100) / 100;
  return r;
}
function cleanupRules(r) {
  const t = r.window.asOf,
    available = (table) =>
      r.storage.tables[table] !== null && r.storage.tables[table] !== undefined;
  const rules = [
    {
      table: "oauth_states",
      key: "state_hash",
      predicate: `created_at < ${Math.max(0, t - 10 * 60000)}`,
      order: "created_at",
    },
    {
      table: "login_codes",
      key: "code_hash",
      predicate: `created_at < ${Math.max(0, t - 2 * 60000)}`,
      order: "created_at",
    },
    {
      table: "rate_limits",
      key: "key",
      predicate: `window_start < ${Math.max(0, t - DAY)}`,
      order: "window_start",
    },
  ].filter((v) => available(v.table));
  if (available("sessions") && available("score_receipts"))
    rules.push({
      table: "sessions",
      key: "id",
      predicate: `(used=0 AND started_at < ${Math.max(0, t - DAY - 3 * 3600000)}) OR (used=1 AND EXISTS(SELECT 1 FROM score_receipts r WHERE r.session_id=sessions.id AND r.accepted_at < ${Math.max(0, t - DAY)}))`,
      order: "started_at",
    });
  return rules;
}
export function cleanupStatements(report) {
  validate({ ...report.window, source: report.source });
  return cleanupRules(report).map(({ table, key, predicate, order }) => ({
    table,
    sql: `DELETE FROM ${table} WHERE ${key} IN (SELECT ${key} FROM ${table} WHERE ${predicate} ORDER BY ${order} LIMIT 500);`,
  }));
}
export function compareReports(current, baseline) {
  if (!baseline) return null;
  if (
    baseline.schemaVersion !== 1 ||
    baseline.source !== current.source ||
    baseline.window.asOf >= current.window.asOf
  )
    throw new Error("incompatible_baseline");
  return {
    elapsedHours: (current.window.asOf - baseline.window.asOf) / 3600000,
    tables: Object.fromEntries(
      TABLES.map((t) => [
        t,
        current.storage.tables[t] === null ||
        baseline.storage.tables[t] === null ||
        baseline.storage.tables[t] === undefined
          ? null
          : current.storage.tables[t] - baseline.storage.tables[t],
      ]),
    ),
  };
}
export function renderMarkdown(r, comparison = null) {
  const date = (n) =>
    new Date(n).toLocaleString("zh-CN", {
      timeZone: "Asia/Shanghai",
      hour12: false,
    });
  const lines = [
    "# 运行与效果观察报告",
    "",
    `数据源：${r.source}。报告 schema：${r.schemaVersion}。`,
    `统计区间：北京时间 ${date(r.window.from)} ≤ 时间 < ${date(r.window.to)}；cohort 观察截止 ${date(r.window.asOf)}。`,
    `读取时间：${r.observedAt}。只输出聚合数据，无昵称、身份 ID、token 或 IP。`,
    "",
    "## 参与与接受记录",
    "",
    "| 指标 | 结果 | 口径 |",
    "| --- | --- | --- |",
    `| 服务器接受的总局数 | ${metric(r.observed?.acceptedRounds)} | 经典 scores + 每日 challenge_scores；含零分；按接受记录计数 |`,
    `| 有接受成绩的账号数 | ${metric(r.observed?.acceptedPlayers)} | 区间去重账号，不等同所有玩家 |`,
    `| 接受至少两局的账号数 | ${metric(r.observed?.repeatAcceptedPlayers)} | 区间重复参与观察，不称为留存率 |`,
    `| 在至少两天被接受成绩的账号数 | ${metric(r.observed?.acceptedOnMultipleDays)} | 北京时间自然日 |`,
    `| 经典接受局数 / 账号数 | ${metric(r.classic?.accepted)} / ${metric(r.classic?.acceptedPlayers)} | 按接受时间；历史完整开局数未知 |`,
    `| 经典区间幂等回执数 | ${metric(r.classic?.receiptsInWindow)} | 旧版成绩未回填完整回执，不等同所有历史局数 |`,
    `| 每日签发凭证数 / 开局账号数 | ${metric(r.daily?.issued)} / ${metric(r.daily?.startPlayers)} | 按凭证 started_at；幂等重放不增加 |`,
    `| 每日接受局数 / 账号数 | ${metric(r.daily?.accepted)} / ${metric(r.daily?.acceptedPlayers)} | 按 accepted_at；不是区间开局 cohort 的完成数 |`,
    `| 区间每日凭证截至观察点已接受数 | ${metric(r.daily?.cohortAccepted)} | 包括区间结束后、观察点之前被接受的这些凭证 |`,
    `| 每日凭证接受比例 | ${r.daily?.cohortAcceptedRatio == null ? "未知（无可用分母）" : (100 * r.daily.cohortAcceptedRatio).toFixed(2) + "%"} | 不是上传成功率或真实完成率；未截止凭证 ${metric(r.daily?.cohortPendingDeadline)} |`,
    "| 全部参与人数 / 实际完成局数 | 未知 | 未采集匿名、离线与练习事件 |",
    "| 上传成功率 / 留存率 / 分享转化 | 未知 | 没有客户端尝试次数或完整参与队列，不能推算 |",
    "",
    "## 存储与维护候选",
    "",
    "| 表 | 当前行数 | 与基线差值 | 可清理候选数 |",
    "| --- | --- | --- | --- |",
  ];
  for (const t of TABLES)
    lines.push(
      `| ${t} | ${metric(r.storage.tables[t])} | ${comparison ? metric(comparison.tables[t]) : "无基线"} | ${Object.hasOwn(r.cleanup, t) ? r.cleanup[t] : "保留"} |`,
    );
  lines.push(
    "",
    comparison
      ? `基线间隔 ${comparison.elapsedHours.toFixed(2)} 小时；行数差含新增与删除净变化，不是字节增长。`
      : "只有当前快照，不能断言存储增长速度。",
    "物理字节与平台配额请结合 D1 平台指标；当前报告的行数不是数据库实际磁盘大小。",
    "",
    "## 每日观察（仅列有记录日期）",
    "",
    "```json",
    JSON.stringify(
      {
        classicAccepted: r.classic?.byDate ?? null,
        dailyIssued: r.daily?.byDate ?? null,
      },
      null,
      2,
    ),
    "```",
    "",
    "## 榜单查询计划",
    "",
    "```text",
    ...Object.entries(r.queryPlans).flatMap(([k, v]) => [`${k}:`, ...v]),
    "```",
    "",
    "## 查询成本",
    "",
    "| 查询 | 本次耗时 ms | D1 rows_read | D1 rows_written |",
    "| --- | --- | --- | --- |",
  );
  for (const c of r.queryCosts)
    lines.push(
      `| ${c.label} | ${c.elapsedMs} | ${metric(c.rowsRead)} | ${metric(c.rowsWritten)} |`,
    );
  lines.push(
    "",
    "耗时含 CLI / 网络开销，不是榜单延迟基准。聚合扫描历史数据会产生读取成本，建议按迭代手动运行，避免高频轮询。",
    "",
    "## 限制与解释",
    "",
    ...r.warnings.map((v) => `- ${v}`),
    "",
    "清理文件仅供审查，默认没有执行 DELETE。成绩、回执、挑战凭证/次数账本与认证 tokens 全部保留。",
    "",
  );
  return lines.join("\n");
}
