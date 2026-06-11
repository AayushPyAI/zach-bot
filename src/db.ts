import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { AnalysisResult, RedditPost, StoredPost } from "./types.js";

const schema = `
CREATE TABLE IF NOT EXISTS posts (
  post_id TEXT PRIMARY KEY,
  subreddit TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  author TEXT NOT NULL,
  url TEXT NOT NULL,
  permalink TEXT NOT NULL,
  created_utc INTEGER NOT NULL,
  comment_count INTEGER NOT NULL,
  upvotes INTEGER NOT NULL,
  over_18 INTEGER NOT NULL,
  locked INTEGER NOT NULL,
  archived INTEGER NOT NULL,
  is_self INTEGER NOT NULL,
  first_seen_ts INTEGER NOT NULL,
  relevance INTEGER,
  reason TEXT,
  draft_comment TEXT,
  commented INTEGER NOT NULL DEFAULT 0,
  commented_ts INTEGER,
  dry_run INTEGER NOT NULL DEFAULT 0,
  skipped_reason TEXT,
  intent INTEGER,
  removed INTEGER,
  last_checked_ts INTEGER
);

CREATE INDEX IF NOT EXISTS idx_posts_commented_ts ON posts(commented_ts);
CREATE INDEX IF NOT EXISTS idx_posts_subreddit_commented_ts ON posts(subreddit, commented_ts);

-- Original posts created by this account (separate from comments on others' posts).
CREATE TABLE IF NOT EXISTS created_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subreddit TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  post_type TEXT NOT NULL,
  audience TEXT,
  created_ts INTEGER NOT NULL,
  url TEXT,
  reddit_post_id TEXT,
  dry_run INTEGER NOT NULL DEFAULT 1,
  score INTEGER,
  comment_count INTEGER,
  last_checked_ts INTEGER
);

CREATE INDEX IF NOT EXISTS idx_created_posts_created_ts ON created_posts(created_ts);
CREATE INDEX IF NOT EXISTS idx_created_posts_subreddit ON created_posts(subreddit, created_ts);

CREATE TABLE IF NOT EXISTS account_snapshots (
  ts INTEGER NOT NULL,
  age_days REAL NOT NULL,
  comment_karma INTEGER NOT NULL,
  link_karma INTEGER NOT NULL,
  total_karma INTEGER NOT NULL,
  stage TEXT NOT NULL,
  posting INTEGER NOT NULL,
  daily_cap INTEGER NOT NULL
);
`;

export class StateDb {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec(schema);
    // Idempotent migrations for DBs created before these columns existed.
    for (const col of [
      "intent INTEGER",
      "removed INTEGER",
      "last_checked_ts INTEGER",
    ]) {
      try {
        this.db.exec(`ALTER TABLE posts ADD COLUMN ${col}`);
      } catch {
        // Column already exists — fine.
      }
    }
  }

  close(): void {
    this.db.close();
  }

  recordAccountSnapshot(snapshot: {
    ageDays: number;
    commentKarma: number;
    linkKarma: number;
    totalKarma: number;
    stage: string;
    posting: boolean;
    dailyCap: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO account_snapshots (ts, age_days, comment_karma, link_karma, total_karma, stage, posting, daily_cap)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        Math.floor(Date.now() / 1000),
        snapshot.ageDays,
        snapshot.commentKarma,
        snapshot.linkKarma,
        snapshot.totalKarma,
        snapshot.stage,
        snapshot.posting ? 1 : 0,
        snapshot.dailyCap,
      );
  }

  hasSeen(postId: string): boolean {
    const row = this.db.prepare("SELECT 1 FROM posts WHERE post_id = ?").get(postId);
    return Boolean(row);
  }

  saveDiscovered(post: RedditPost): void {
    const stmt = this.db.prepare(`
      INSERT INTO posts (
        post_id, subreddit, title, body, author, url, permalink, created_utc,
        comment_count, upvotes, over_18, locked, archived, is_self, first_seen_ts
      ) VALUES (
        @id, @subreddit, @title, @body, @author, @url, @permalink, @createdUtc,
        @commentCount, @upvotes, @over18, @locked, @archived, @isSelf, @firstSeenTs
      )
      ON CONFLICT(post_id) DO UPDATE SET
        body = excluded.body,
        comment_count = excluded.comment_count,
        upvotes = excluded.upvotes
    `);

    stmt.run({
      ...post,
      over18: post.over18 ? 1 : 0,
      locked: post.locked ? 1 : 0,
      archived: post.archived ? 1 : 0,
      isSelf: post.isSelf ? 1 : 0,
      firstSeenTs: Math.floor(Date.now() / 1000),
    });
  }

  listPendingAnalysis(limit: number): StoredPost[] {
    const rows = this.db.prepare(`
      SELECT * FROM posts
      WHERE relevance IS NULL
      ORDER BY first_seen_ts ASC
      LIMIT ?
    `).all(limit) as Record<string, unknown>[];

    return rows.map(mapStoredPost);
  }

  recordAnalysis(postId: string, analysis: AnalysisResult): void {
    this.db.prepare(`
      UPDATE posts
      SET relevance = ?, intent = ?, reason = ?, draft_comment = ?
      WHERE post_id = ?
    `).run(analysis.relevance, analysis.intent, analysis.reason, analysis.draftComment, postId);
  }

  /** Live comments posted within the window that are due for a removal re-check. */
  commentsToRecheck(withinDays: number, limit: number): Array<{ id: string; url: string; draft: string }> {
    const cutoff = Math.floor(Date.now() / 1000) - withinDays * 86_400;
    const rows = this.db.prepare(`
      SELECT post_id, url, draft_comment
      FROM posts
      WHERE commented = 1 AND dry_run = 0 AND commented_ts >= ?
        AND (removed IS NULL OR removed = 0)
        AND draft_comment IS NOT NULL
      ORDER BY last_checked_ts ASC NULLS FIRST
      LIMIT ?
    `).all(cutoff, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({ id: String(r.post_id), url: String(r.url), draft: String(r.draft_comment) }));
  }

  markCommentChecked(postId: string, removed: boolean): void {
    this.db.prepare(`
      UPDATE posts
      SET removed = ?, last_checked_ts = ?
      WHERE post_id = ?
    `).run(removed ? 1 : 0, Math.floor(Date.now() / 1000), postId);
  }

  /** Removal stats over comments checked within the window (for the throttle). */
  removalStats(withinDays: number): { checked: number; removed: number } {
    const cutoff = Math.floor(Date.now() / 1000) - withinDays * 86_400;
    const row = this.db.prepare(`
      SELECT
        SUM(CASE WHEN removed IS NOT NULL THEN 1 ELSE 0 END) AS checked,
        SUM(CASE WHEN removed = 1 THEN 1 ELSE 0 END) AS removed
      FROM posts
      WHERE commented = 1 AND dry_run = 0 AND commented_ts >= ?
    `).get(cutoff) as { checked: number | null; removed: number | null };
    return { checked: row.checked ?? 0, removed: row.removed ?? 0 };
  }

  markSkipped(postId: string, reason: string): void {
    this.db.prepare("UPDATE posts SET skipped_reason = ? WHERE post_id = ?").run(reason, postId);
  }

  markCommented(postId: string, dryRun: boolean): void {
    this.db.prepare(`
      UPDATE posts
      SET commented = 1, commented_ts = ?, dry_run = ?
      WHERE post_id = ?
    `).run(Math.floor(Date.now() / 1000), dryRun ? 1 : 0, postId);
  }

  wasAttempted(postId: string): boolean {
    const row = this.db.prepare(`
      SELECT 1
      FROM posts
      WHERE post_id = ?
        AND (commented = 1 OR skipped_reason IS NOT NULL)
    `).get(postId);
    return Boolean(row);
  }

  commentsInLast24h(): number {
    const cutoff = Math.floor(Date.now() / 1000) - 24 * 3600;
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM posts
      WHERE commented = 1 AND dry_run = 0 AND commented_ts >= ?
    `).get(cutoff) as { count: number };
    return row.count;
  }

  lastCommentTimestamp(): number | null {
    const row = this.db.prepare(`
      SELECT MAX(commented_ts) AS ts
      FROM posts
      WHERE commented = 1 AND dry_run = 0
    `).get() as { ts: number | null };
    return row.ts;
  }

  lastCommentTimestampForSubreddit(subreddit: string): number | null {
    const row = this.db.prepare(`
      SELECT MAX(commented_ts) AS ts
      FROM posts
      WHERE commented = 1 AND dry_run = 0 AND subreddit = ?
    `).get(subreddit) as { ts: number | null };
    return row.ts;
  }

  // ── Original post creation ──────────────────────────────────────────────

  saveCreatedPost(data: {
    subreddit: string;
    title: string;
    body: string;
    postType: string;
    audience?: string;
    dryRun: boolean;
    url?: string;
    redditPostId?: string;
  }): void {
    this.db.prepare(`
      INSERT INTO created_posts (subreddit, title, body, post_type, audience, created_ts, url, reddit_post_id, dry_run)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.subreddit,
      data.title,
      data.body,
      data.postType,
      data.audience ?? null,
      Math.floor(Date.now() / 1000),
      data.url ?? null,
      data.redditPostId ?? null,
      data.dryRun ? 1 : 0,
    );
  }

  /** Live (non-dry-run) posts created in the last 7 days. */
  postsThisWeek(): number {
    const cutoff = Math.floor(Date.now() / 1000) - 7 * 86_400;
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM created_posts
      WHERE dry_run = 0 AND created_ts >= ?
    `).get(cutoff) as { count: number };
    return row.count;
  }

  /** Timestamp of the most recent live post in a given subreddit, or null. */
  lastPostTimestampForSubreddit(subreddit: string): number | null {
    const row = this.db.prepare(`
      SELECT MAX(created_ts) AS ts FROM created_posts
      WHERE subreddit = ? AND dry_run = 0
    `).get(subreddit) as { ts: number | null };
    return row.ts;
  }
}

function mapStoredPost(row: Record<string, unknown>): StoredPost {
  return {
    id: String(row.post_id),
    subreddit: String(row.subreddit),
    title: String(row.title),
    body: String(row.body),
    author: String(row.author),
    url: String(row.url),
    permalink: String(row.permalink),
    createdUtc: Number(row.created_utc),
    commentCount: Number(row.comment_count),
    upvotes: Number(row.upvotes),
    over18: Number(row.over_18) === 1,
    locked: Number(row.locked) === 1,
    archived: Number(row.archived) === 1,
    isSelf: Number(row.is_self) === 1,
    firstSeenTs: Number(row.first_seen_ts),
    relevance: row.relevance === null ? null : Number(row.relevance),
    intent: row.intent === null || row.intent === undefined ? null : Number(row.intent),
    reason: row.reason === null ? null : String(row.reason),
    draftComment: row.draft_comment === null ? null : String(row.draft_comment),
    commented: Number(row.commented) === 1,
    commentedTs: row.commented_ts === null ? null : Number(row.commented_ts),
    dryRun: Number(row.dry_run) === 1,
    skippedReason: row.skipped_reason === null ? null : String(row.skipped_reason),
  };
}
