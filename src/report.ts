import path from "node:path";

import Database from "better-sqlite3";

import { loadConfig } from "./config.js";

/**
 * Read-only marketing report from the SQLite state: the funnel (seen → analyzed
 * → drafted → posted), removal rate, intent/relevance averages, a breakdown by
 * audience/subreddit, and account growth. Run with `npm run report`.
 */
function main(): void {
  const config = loadConfig();
  const dbPath = path.resolve(config.runtime.databasePath);
  // Open read-write so we can apply the same idempotent column migrations as the
  // main app — otherwise reporting on a DB created before these columns errors.
  const db = new Database(dbPath, { fileMustExist: true });
  for (const col of ["intent INTEGER", "removed INTEGER", "last_checked_ts INTEGER"]) {
    try {
      db.exec(`ALTER TABLE posts ADD COLUMN ${col}`);
    } catch {
      // already exists
    }
  }

  const one = <T>(sql: string, ...args: unknown[]): T => db.prepare(sql).get(...args) as T;
  const all = <T>(sql: string, ...args: unknown[]): T[] => db.prepare(sql).all(...args) as T[];

  const funnel = one<{ seen: number; analyzed: number; drafted: number; live: number; dry: number; skipped: number }>(
    `SELECT
       COUNT(*) AS seen,
       SUM(CASE WHEN relevance IS NOT NULL THEN 1 ELSE 0 END) AS analyzed,
       SUM(CASE WHEN draft_comment IS NOT NULL THEN 1 ELSE 0 END) AS drafted,
       SUM(CASE WHEN commented = 1 AND dry_run = 0 THEN 1 ELSE 0 END) AS live,
       SUM(CASE WHEN commented = 1 AND dry_run = 1 THEN 1 ELSE 0 END) AS dry,
       SUM(CASE WHEN skipped_reason IS NOT NULL THEN 1 ELSE 0 END) AS skipped
     FROM posts`,
  );

  const removalRaw = one<{ checked: number | null; removed: number | null }>(
    `SELECT SUM(CASE WHEN removed IS NOT NULL THEN 1 ELSE 0 END) AS checked,
            SUM(CASE WHEN removed = 1 THEN 1 ELSE 0 END) AS removed
     FROM posts WHERE commented = 1 AND dry_run = 0`,
  );
  const removal = { checked: removalRaw.checked ?? 0, removed: removalRaw.removed ?? 0 };

  const quality = one<{ avgRel: number | null; avgIntent: number | null }>(
    `SELECT AVG(relevance) AS avgRel, AVG(intent) AS avgIntent FROM posts WHERE relevance IS NOT NULL`,
  );

  const byAudience = all<{ subreddit: string; drafted: number; live: number }>(
    `SELECT subreddit,
            SUM(CASE WHEN draft_comment IS NOT NULL THEN 1 ELSE 0 END) AS drafted,
            SUM(CASE WHEN commented = 1 AND dry_run = 0 THEN 1 ELSE 0 END) AS live
     FROM posts GROUP BY subreddit HAVING drafted > 0 ORDER BY drafted DESC`,
  );

  let snapshots: Array<{ ts: number; age_days: number; total_karma: number; stage: string; daily_cap: number }> = [];
  try {
    snapshots = all(`SELECT ts, age_days, total_karma, stage, daily_cap FROM account_snapshots ORDER BY ts ASC`);
  } catch {
    // table may not exist on very old DBs
  }

  const removalRate = removal.checked > 0 ? ((removal.removed / removal.checked) * 100).toFixed(0) : "n/a";
  const lines: string[] = [];
  lines.push("══════════ Reddit bot — marketing report ══════════");
  lines.push(`DB: ${dbPath}`);
  lines.push("");
  lines.push("Funnel:");
  lines.push(`  posts seen:        ${funnel.seen}`);
  lines.push(`  analyzed (AI):     ${funnel.analyzed}`);
  lines.push(`  drafts generated:  ${funnel.drafted}`);
  lines.push(`  posted LIVE:       ${funnel.live}`);
  lines.push(`  draft-only saved:  ${funnel.dry}`);
  lines.push(`  skipped:           ${funnel.skipped}`);
  lines.push("");
  lines.push("Comment health:");
  lines.push(`  live comments checked: ${removal.checked}`);
  lines.push(`  removed by Reddit:     ${removal.removed} (${removalRate}% removal rate)`);
  lines.push("");
  lines.push("AI scores (avg over analyzed):");
  lines.push(`  relevance: ${quality.avgRel?.toFixed(1) ?? "n/a"}   intent: ${quality.avgIntent?.toFixed(1) ?? "n/a"}`);
  lines.push("");
  lines.push("By subreddit (drafted / live):");
  for (const row of byAudience) {
    lines.push(`  r/${row.subreddit}: ${row.drafted} drafted, ${row.live} live`);
  }
  lines.push("");
  if (snapshots.length > 0) {
    const first = snapshots[0]!;
    const last = snapshots[snapshots.length - 1]!;
    lines.push("Account growth:");
    lines.push(`  first seen: karma ${first.total_karma}, age ${first.age_days.toFixed(0)}d, stage ${first.stage}`);
    lines.push(`  latest:     karma ${last.total_karma}, age ${last.age_days.toFixed(0)}d, stage ${last.stage}, cap ${last.daily_cap}/day`);
    lines.push(`  karma gained: ${last.total_karma - first.total_karma} over ${snapshots.length} sessions`);
  } else {
    lines.push("Account growth: no snapshots yet (run the bot once).");
  }
  lines.push("════════════════════════════════════════════════════");

  process.stdout.write(lines.join("\n") + "\n");
  db.close();
}

main();
