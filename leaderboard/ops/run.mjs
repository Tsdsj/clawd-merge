#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  collectReport,
  compareReports,
  cleanupStatements,
  renderMarkdown,
} from "./report.mjs";

const HELP = `只读运行报告（不会迁移数据库或执行清理）
  node leaderboard/ops/run.mjs --sqlite /path/to/db.sqlite --out /path/to/report
  node leaderboard/ops/run.mjs --remote --database clawd-merge --wrangler /path/to/wrangler.js --out /path/to/report
可选：--from 2026-10-01 --to 2026-10-03 --as-of ISO时间 --baseline /path/to/previous.json --source 标签
日期 YYYY-MM-DD 按北京时间 00:00；时间戳须带时区。区间左闭右开，最多366天。
默认统计观察点之前7天。输出 .json、.md 和 .cleanup.sql；最后一项仅供审查。
远程模式只使用已安装 Wrangler，读取现有认证，不下载工具，不导出个人数据。`;
const flags = new Set(["--remote", "--help"]);
const names = new Set([
  "--sqlite",
  "--database",
  "--wrangler",
  "--out",
  "--from",
  "--to",
  "--as-of",
  "--baseline",
  "--source",
]);
function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (Object.hasOwn(out, k)) throw new Error(`重复选项 ${k}`);
    if (flags.has(k)) out[k] = true;
    else if (names.has(k) && argv[i + 1] && !argv[i + 1].startsWith("--"))
      out[k] = argv[++i];
    else throw new Error(`未知或缺值选项 ${k}`);
  }
  return out;
}
function instant(v) {
  if (v === undefined) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const n = Date.parse(`${v}T00:00:00+08:00`);
    if (new Date(n + 28800000).toISOString().slice(0, 10) !== v)
      throw new Error("无效日期");
    return n;
  }
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(v)) throw new Error("时间戳必须带时区");
  const n = Date.parse(v);
  if (!Number.isFinite(n)) throw new Error("无效时间");
  return n;
}
async function main() {
  const a = args(process.argv.slice(2));
  if (a["--help"]) {
    console.log(HELP);
    return;
  }
  if (Boolean(a["--sqlite"]) === Boolean(a["--remote"]))
    throw new Error("请选择一个数据源：--sqlite 或 --remote");
  if (a["--sqlite"] && (a["--database"] || a["--wrangler"]))
    throw new Error("本地模式不接受远程数据库选项");
  const asOf = instant(a["--as-of"]) ?? Date.now(),
    to = instant(a["--to"]) ?? asOf,
    from = instant(a["--from"]) ?? to - 7 * 86400000;
  if (asOf > Date.now() + 1000) throw new Error("观察截止时间不能在未来");
  const source =
    a["--source"] ??
    (a["--remote"]
      ? `d1:${a["--database"]}`
      : `sqlite:${basename(a["--sqlite"])}`);
  const out = resolve(a["--out"] ?? `/tmp/clawd-ops-${asOf}`),
    files = [".json", ".md", ".cleanup.sql"].map((ext) => out + ext);
  if (files.some(existsSync))
    throw new Error("输出已存在，请选用新的 --out，保留历史快照");
  let db, query;
  if (a["--sqlite"]) {
    db = new DatabaseSync(resolve(a["--sqlite"]), { readOnly: true });
    db.exec("BEGIN");
    query = async (sql) => ({ rows: db.prepare(sql).all() });
  } else {
    const bin = a["--wrangler"] ?? process.env.WRANGLER_BIN;
    if (!bin || !existsSync(bin) || !a["--database"])
      throw new Error("远程读取需要现有 --wrangler 文件路径和 --database");
    const config = fileURLToPath(new URL("../wrangler.toml", import.meta.url));
    query = async (sql) => {
      if (!/^(SELECT|EXPLAIN QUERY PLAN|WITH)\b/.test(sql))
        throw new Error("远程只允许只读查询");
      const run = spawnSync(
        process.execPath,
        [
          resolve(bin),
          "d1",
          "execute",
          a["--database"],
          "--remote",
          "--config",
          config,
          "--command",
          sql,
          "--json",
        ],
        { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, timeout: 60000 },
      );
      if (run.status !== 0)
        throw new Error(
          `D1 只读查询失败（exit ${run.status ?? "timeout"}），请检查 Wrangler 认证/连接；未输出原始数据`,
        );
      let result;
      try {
        result = JSON.parse(run.stdout);
      } catch {
        throw new Error("D1 返回非 JSON 结果");
      }
      if (
        !Array.isArray(result) ||
        result.length !== 1 ||
        result[0].success !== true
      )
        throw new Error("D1 只读结果不完整");
      return { rows: result[0].results, meta: result[0].meta };
    };
  }
  try {
    const report = await collectReport(query, { from, to, asOf, source });
    if (db) {
      const size = db.prepare("PRAGMA page_size").get().page_size,
        count = db.prepare("PRAGMA page_count").get().page_count;
      report.storage.localLogicalBytes = Number(size) * Number(count);
    }
    const baseline = a["--baseline"]
        ? JSON.parse(readFileSync(a["--baseline"], "utf8"))
        : null,
      comparison = compareReports(report, baseline);
    mkdirSync(dirname(out), { recursive: true });
    const cleanup = `-- REVIEW ONLY: no deletion was executed by the report command.\n-- Source: ${source.replace(/[\r\n]/g, " ")}\n-- Fixed observation cutoff: ${new Date(asOf).toISOString()}\n-- Back up and verify the target before applying. Each statement updates or deletes at most 500 rows.\n-- Keep all score receipts, scores, challenge ledgers, allowances, bests, recovery codes and unexpired tokens.\n\n${cleanupStatements(
      report,
    )
      .map((v) => v.sql)
      .join("\n\n")}\n`;
    writeFileSync(
      files[0],
      JSON.stringify({ ...report, comparison }, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    writeFileSync(files[1], renderMarkdown(report, comparison), {
      flag: "wx",
      mode: 0o600,
    });
    writeFileSync(files[2], cleanup, { flag: "wx", mode: 0o600 });
    console.log(
      `只读报告已生成：\n${files.join("\n")}\n没有执行迁移、清理或发布。`,
    );
  } finally {
    if (db) {
      db.exec("ROLLBACK");
      db.close();
    }
  }
}
main().catch((e) => {
  console.error(`报告失败：${e.message}`);
  process.exitCode = 1;
});
