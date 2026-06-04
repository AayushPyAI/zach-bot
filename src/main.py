"""Orchestrator. Single browser session, end to end - everything visible.

Flow:
  1. Open Chrome, log in (visible).
  2. For each subreddit: scroll the feed (visible) + fetch posts (silent JSON).
  3. For each post: idle-browse the post page (visible), THEN call OpenAI
     to score + draft. Browser stays open the whole time so the user can
     watch a real-looking human session.
  4. Post the top-scoring drafts (visible typing + submit).

The browser is NEVER closed mid-run. To avoid the prior 'invalid state'
asyncio conflict, we just don't touch Playwright during the OpenAI call -
the browser sits idle on the post page while OpenAI thinks.
"""
from __future__ import annotations

import random
import sys
import time
from typing import List, Tuple

from loguru import logger

from .analyzer import Analysis, Analyzer
from .browser import RedditBrowser
from .config import Config, load_config
from .db import StateDB
from .discover import Post, discover_posts
from .logger import setup_logger
from .poster import post_comment


def _eligible_to_post(cfg: Config, db: StateDB) -> Tuple[bool, str]:
    if cfg.posting.dry_run:
        return True, ""
    posted_24h = db.comments_in_last_24h()
    if posted_24h >= cfg.posting.daily_cap:
        return False, f"daily cap reached ({posted_24h}/{cfg.posting.daily_cap})"
    last_ts = db.last_comment_ts()
    if last_ts is not None:
        gap_minutes = (int(time.time()) - last_ts) / 60.0
        if gap_minutes < cfg.posting.min_gap_minutes:
            return False, f"min gap not met ({gap_minutes:.1f}m < {cfg.posting.min_gap_minutes}m)"
    return True, ""


def _row_to_post(row) -> Post:
    return Post(
        id=row["post_id"],
        subreddit=row["subreddit"],
        title=row["title"] or "",
        body=row["body"] or "",
        author="",
        url=row["url"] or "",
        permalink="",
        created_utc=0,
        num_comments=0,
        upvotes=0,
        over_18=False,
        locked=False,
        archived=False,
        is_self=True,
    )


def _discover(cfg: Config, db: StateDB, browser: RedditBrowser) -> List[Post]:
    new_posts: List[Post] = []
    for sub in cfg.subreddits:
        posts = discover_posts(browser, sub, cfg.discovery)
        for p in posts:
            if db.has_seen(p.id):
                continue
            db.mark_seen(p.id, p.subreddit, p.title, p.url, p.body)
            new_posts.append(p)
        time.sleep(random.uniform(2.0, 5.0))
    return new_posts


def _posts_to_analyze(db: StateDB, newly_found: List[Post]) -> List[Post]:
    out: List[Post] = []
    seen_ids: set[str] = set()
    for row in db.list_unanalyzed():
        pid = row["post_id"]
        if pid in seen_ids:
            continue
        seen_ids.add(pid)
        out.append(_row_to_post(row))
    for p in newly_found:
        if p.id in seen_ids:
            continue
        if db.is_analyzed(p.id):
            continue
        seen_ids.add(p.id)
        out.append(p)
    return out


def _analyze_all(
    cfg: Config,
    db: StateDB,
    analyzer: Analyzer,
    posts: List[Post],
    browser: RedditBrowser,
) -> List[Tuple[Post, Analysis]]:
    """Score posts with OpenAI. Between each call, idle-browse the post
    page in the visible browser so the user sees activity."""
    scored: List[Tuple[Post, Analysis]] = []
    total = len(posts)
    logger.info("Analyzing {} post(s) with OpenAI (browser stays visible)...", total)

    for i, p in enumerate(posts, start=1):
        if db.is_analyzed(p.id):
            logger.debug("Skipping {} - already analyzed", p.id)
            continue

        logger.info("[{}/{}] Reading post {} in r/{}: {}", i, total, p.id, p.subreddit, p.title[:80])
        # Visible: open this candidate on new reddit + scroll a little.
        browser.idle_browse(p.url)

        logger.info("[{}/{}] Sending to OpenAI for scoring...", i, total)
        try:
            analysis = analyzer.analyze(p)
        except Exception as e:
            logger.error("Analyze failed for {}: {}", p.id, e)
            continue

        db.update_analysis(p.id, analysis.relevance, analysis.reason, analysis.comment)
        logger.info(
            "  -> relevance={} | comment={} | reason={}",
            analysis.relevance,
            "YES" if analysis.comment else "NO",
            analysis.reason,
        )
        if analysis.comment:
            scored.append((p, analysis))

        # Small visible scroll + pause between API calls (gentler on RL + looks human).
        browser.idle_browse(None)
        time.sleep(random.uniform(0.5, 1.5))

    scored.sort(key=lambda x: x[1].relevance, reverse=True)
    return scored


def _post_drafts(
    cfg: Config,
    db: StateDB,
    scored: List[Tuple[Post, Analysis]],
    browser: RedditBrowser,
) -> None:
    logger.info("Posts with usable drafts: {}", len(scored))
    if not scored:
        return

    for post, analysis in scored:
        if db.was_attempted(post.id):
            logger.info("Skipping {} - already attempted before.", post.id)
            continue

        ok, why = _eligible_to_post(cfg, db)
        if not ok:
            logger.info("Stopping posting loop: {}", why)
            break

        logger.info("=" * 72)
        logger.info("POST  r/{}  {}", post.subreddit, post.url)
        logger.info("TITLE {}", post.title)
        logger.info("DRAFT >>>")
        for line in (analysis.comment or "").splitlines():
            logger.info("      | {}", line)
        logger.info("<<<")

        if cfg.posting.dry_run:
            logger.warning("[DRY RUN] Not posting. Set posting.dry_run: false to enable.")
            db.mark_commented(post.id, dry_run=True)
            continue

        try:
            success = post_comment(browser, post, analysis.comment or "", cfg.posting)
        except Exception as e:
            logger.error("Failed to post on {}: {}", post.id, e)
            db.mark_skipped(post.id, f"post error: {e}")
            continue

        if success:
            db.mark_commented(post.id, dry_run=False)
            wait_minutes = cfg.posting.min_gap_minutes + random.uniform(
                0, cfg.posting.jitter_minutes
            )
            logger.info("Sleeping {:.1f} minutes before next post...", wait_minutes)
            time.sleep(wait_minutes * 60)
        else:
            db.mark_skipped(post.id, "post not confirmed")


def run_once(cfg: Config) -> None:
    db = StateDB(cfg.db_path_abs)
    analyzer = Analyzer(cfg.openai_api_key, cfg.openai_model, cfg.ai)

    browser = RedditBrowser(
        user_data_dir=cfg.user_data_dir_abs,
        headless=cfg.browser.headless,
        user_agent=cfg.browser.user_agent,
        username=cfg.reddit_username,
        password=cfg.reddit_password,
    )

    # Single browser session for the whole run - everything visible.
    with browser.session():
        browser.login()
        newly_found = _discover(cfg, db, browser)
        logger.info("Discovery done.")

        to_analyze = _posts_to_analyze(db, newly_found)
        logger.info("Posts queued for analysis: {}", len(to_analyze))
        if not to_analyze:
            logger.info("Nothing new to analyze. Exiting.")
            db.close()
            return

        scored = _analyze_all(cfg, db, analyzer, to_analyze, browser)
        _post_drafts(cfg, db, scored, browser)

    db.close()
    logger.info("Run complete.")


def main() -> int:
    cfg = load_config()
    setup_logger(cfg.log_path_abs)
    logger.info("Starting reddit-comment-bot")
    logger.info("Subreddits: {}", ", ".join(cfg.subreddits))
    logger.info("Dry run: {}", cfg.posting.dry_run)
    try:
        run_once(cfg)
        return 0
    except KeyboardInterrupt:
        logger.warning("Stopped by you (Ctrl+C). Progress is saved - re-run to continue.")
        return 130
    except Exception as e:
        logger.error("Fatal error: {}", e)
        return 1


if __name__ == "__main__":
    sys.exit(main())
