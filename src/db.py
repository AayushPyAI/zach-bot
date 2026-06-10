"""SQLite state: remember which posts we've seen, scored, or commented on."""
from __future__ import annotations

import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator, Optional


SCHEMA = """
CREATE TABLE IF NOT EXISTS posts (
    post_id        TEXT PRIMARY KEY,
    subreddit      TEXT NOT NULL,
    title          TEXT NOT NULL,
    url            TEXT NOT NULL,
    first_seen_ts  INTEGER NOT NULL,
    relevance      INTEGER,
    reason         TEXT,
    draft_comment  TEXT,
    commented      INTEGER NOT NULL DEFAULT 0,
    commented_ts   INTEGER,
    dry_run        INTEGER NOT NULL DEFAULT 0,
    skipped_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_posts_commented_ts ON posts(commented_ts);
"""


class StateDB:
    def __init__(self, db_path: Path):
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(db_path))
        self._conn.row_factory = sqlite3.Row
        self._conn.executescript(SCHEMA)
        self._migrate()
        self._conn.commit()

    def _migrate(self) -> None:
        """Add columns introduced after first release (safe to run repeatedly)."""
        try:
            self._conn.execute("ALTER TABLE posts ADD COLUMN body TEXT")
        except sqlite3.OperationalError:
            pass

    @contextmanager
    def _tx(self) -> Iterator[sqlite3.Cursor]:
        cur = self._conn.cursor()
        try:
            yield cur
            self._conn.commit()
        except Exception:
            self._conn.rollback()
            raise
        finally:
            cur.close()

    def has_seen(self, post_id: str) -> bool:
        cur = self._conn.execute("SELECT 1 FROM posts WHERE post_id = ?", (post_id,))
        return cur.fetchone() is not None

    def mark_seen(
        self,
        post_id: str,
        subreddit: str,
        title: str,
        url: str,
        body: str = "",
    ) -> None:
        with self._tx() as cur:
            cur.execute(
                """INSERT OR IGNORE INTO posts
                   (post_id, subreddit, title, url, body, first_seen_ts)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (post_id, subreddit, title, url, body, int(time.time())),
            )
            # Refresh body if we re-discover the same post with more text.
            cur.execute(
                "UPDATE posts SET body = ? WHERE post_id = ? AND (body IS NULL OR body = '')",
                (body, post_id),
            )

    def is_analyzed(self, post_id: str) -> bool:
        cur = self._conn.execute(
            "SELECT 1 FROM posts WHERE post_id = ? AND relevance IS NOT NULL",
            (post_id,),
        )
        return cur.fetchone() is not None

    def list_unanalyzed(self) -> list[sqlite3.Row]:
        """Posts saved from a previous run that crashed mid-analysis."""
        cur = self._conn.execute(
            """SELECT post_id, subreddit, title, url, body
               FROM posts WHERE relevance IS NULL ORDER BY first_seen_ts"""
        )
        return list(cur.fetchall())

    def was_attempted(self, post_id: str) -> bool:
        """True if we've ever tried (commented OR skipped) on this post,
        so we don't double-attempt and look like a bot."""
        cur = self._conn.execute(
            """SELECT 1 FROM posts
               WHERE post_id = ?
                 AND (commented = 1 OR skipped_reason IS NOT NULL)""",
            (post_id,),
        )
        return cur.fetchone() is not None

    def update_analysis(
        self,
        post_id: str,
        relevance: int,
        reason: str,
        draft_comment: Optional[str],
    ) -> None:
        with self._tx() as cur:
            cur.execute(
                """UPDATE posts
                   SET relevance = ?, reason = ?, draft_comment = ?
                   WHERE post_id = ?""",
                (relevance, reason, draft_comment, post_id),
            )

    def mark_skipped(self, post_id: str, reason: str) -> None:
        with self._tx() as cur:
            cur.execute(
                "UPDATE posts SET skipped_reason = ? WHERE post_id = ?",
                (reason, post_id),
            )

    def mark_commented(self, post_id: str, dry_run: bool) -> None:
        with self._tx() as cur:
            cur.execute(
                """UPDATE posts
                   SET commented = 1, commented_ts = ?, dry_run = ?
                   WHERE post_id = ?""",
                (int(time.time()), 1 if dry_run else 0, post_id),
            )

    def comments_in_last_24h(self) -> int:
        cutoff = int(time.time()) - 24 * 3600
        cur = self._conn.execute(
            "SELECT COUNT(*) FROM posts WHERE commented = 1 AND dry_run = 0 AND commented_ts >= ?",
            (cutoff,),
        )
        return int(cur.fetchone()[0])

    def last_comment_ts(self) -> Optional[int]:
        cur = self._conn.execute(
            "SELECT MAX(commented_ts) FROM posts WHERE commented = 1 AND dry_run = 0"
        )
        row = cur.fetchone()
        return int(row[0]) if row and row[0] is not None else None

    def last_comment_ts_for_subreddit(self, subreddit: str) -> Optional[int]:
        cur = self._conn.execute(
            """SELECT MAX(commented_ts) FROM posts
               WHERE commented = 1 AND dry_run = 0 AND subreddit = ?""",
            (subreddit,),
        )
        row = cur.fetchone()
        return int(row[0]) if row and row[0] is not None else None

    def close(self) -> None:
        self._conn.close()
