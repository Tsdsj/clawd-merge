#!/usr/bin/env node
// Only aggregate output. Never prints names, player IDs, tokens or database paths.
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inspectDisplayName, NAME_POLICY_VERSION } from "../src/name-policy.js";

export function auditNames(db, { blockedWords = "" } = {}) {
  const hasAlias = db
    .prepare("PRAGMA table_info(players)")
    .all()
    .some((c) => c.name === "public_alias");
  const report = {
    mode: "read-only",
    policyVersion: NAME_POLICY_VERSION,
    scanned: 0,
    allowed: 0,
    masked: 0,
    unavailable: 0,
    missingAliases: 0,
    byRule: {},
  };
  const rows = db
    .prepare(
      `SELECT name, ${hasAlias ? "public_alias" : "NULL AS public_alias"} FROM players`,
    )
    .iterate();
  for (const player of rows) {
    const result = inspectDisplayName(player, { blockedWords });
    report.scanned++;
    report[result.status]++;
    if (result.status !== "allowed" && !player.public_alias)
      report.missingAliases++;
    if (result.ruleId)
      report.byRule[result.ruleId] = (report.byRule[result.ruleId] || 0) + 1;
  }
  return report;
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  let db;
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== "--sqlite" || !args[1])
      throw Error("usage");
    db = new DatabaseSync(resolve(args[1]), { readOnly: true });
    db.exec("BEGIN");
    const report = auditNames(db, {
      blockedWords: process.env.BLOCKED_WORDS || "",
    });
    db.exec("COMMIT");
    console.log(JSON.stringify(report, null, 2));
    if (!report.policyVersion) process.exitCode = 2;
  } catch {
    console.error(
      "Name audit failed. Supply --sqlite with a readable existing database; no migration or write was attempted.",
    );
    process.exitCode = 1;
  } finally {
    db?.close();
  }
}
