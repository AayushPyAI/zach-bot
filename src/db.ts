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
  skipped_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_posts_commented_ts ON posts(commented_ts);
CREATE INDEX IF NOT EXISTS idx_posts_subreddit_commented_ts ON posts(subreddit, commented_ts);

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
      SET relevance = ?, reason = ?, draft_comment = ?
      WHERE post_id = ?
    `).run(analysis.relevance, analysis.reason, analysis.draftComment, postId);
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
    reason: row.reason === null ? null : String(row.reason),
    draftComment: row.draft_comment === null ? null : String(row.draft_comment),
    commented: Number(row.commented) === 1,
    commentedTs: row.commented_ts === null ? null : Number(row.commented_ts),
    dryRun: Number(row.dry_run) === 1,
    skippedReason: row.skipped_reason === null ? null : String(row.skipped_reason),
  };
}
