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
from datetime import datetime
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
    cap = cfg.posting.daily_cap
    if cap > 0:
        posted_24h = db.comments_in_last_24h()
        if posted_24h >= cap:
            return False, f"daily cap reached ({posted_24h}/{cap})"
    last_ts = db.last_comment_ts()
    if last_ts is not None:
        gap_minutes = (int(time.time()) - last_ts) / 60.0
        floor = cfg.posting.enforce_gap_minutes
        if gap_minutes < floor:
            return False, f"min gap not met ({gap_minutes:.1f}m < {floor}m)"
    return True, ""


def _within_active_hours(cfg: Config) -> bool:
    """Honor humanize.active_hours [start, end). Empty list = always active."""
    hrs = cfg.humanize.active_hours
    if not cfg.humanize.enabled or not hrs or len(hrs) != 2:
        return True
    start, end = hrs[0], hrs[1]
    now_h = datetime.now().hour
    if start <= end:
        return start <= now_h < end
    # Wrap-around window (e.g. 22 -> 6)
    return now_h >= start or now_h < end


def _subreddit_on_cooldown(cfg: Config, db: StateDB, subreddit: str) -> bool:
    cd = cfg.humanize.per_subreddit_cooldown_minutes
    if not cfg.humanize.enabled or cd <= 0 or cfg.posting.dry_run:
        return False
    last = db.last_comment_ts_for_subreddit(subreddit)
    if last is None:
        return False
    mins = (int(time.time()) - last) / 60.0
    return mins < cd


def _maybe_lurk(cfg: Config, browser: RedditBrowser) -> None:
    """At session start, casually browse a few unrelated subreddits."""
    h = cfg.humanize
    if not h.enabled or not h.lurk_subreddits:
        return
    if random.random() >= h.lurk_probability:
        return
    n = random.randint(max(1, h.lurk_min), max(h.lurk_min, h.lurk_max))
    subs = random.sample(h.lurk_subreddits, k=min(n, len(h.lurk_subreddits)))
    for sub in subs:
        browser.lurk_subreddit(sub)
        browser.try_upvote_current_page(probability=h.upvote_probability)


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
    # Shuffle subreddit order each run so the pattern isn't identical daily.
    subs = list(cfg.subreddits)
    if cfg.discovery.shuffle_subreddits:
        random.shuffle(subs)
    for sub in subs:
        sort = cfg.discovery.pick_sort()  # random tab per sub (new/hot/rising)
        logger.info("Scanning r/{} (sort={})", sub, sort)
        posts = discover_posts(browser, sub, cfg.discovery, sort=sort)
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
        # Sometimes upvote a post we're reading (real users vote).
        if cfg.humanize.enabled:
            browser.try_upvote_current_page(probability=cfg.humanize.upvote_probability)

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

        # Per-subreddit cooldown: don't hit the same sub repeatedly.
        if _subreddit_on_cooldown(cfg, db, post.subreddit):
            logger.info("Skipping {} - r/{} on cooldown.", post.id, post.subreddit)
            continue

        # Humans don't comment on EVERY good post - sometimes just read & move on.
        if (
            cfg.humanize.enabled
            and not cfg.posting.dry_run
            and random.random() < cfg.humanize.skip_good_post_probability
        ):
            logger.info("[human] Chose to read {} and move on (no comment).", post.id)
            browser.idle_browse(post.url)
            db.mark_skipped(post.id, "human-skip (read only)")
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
            success = post_comment(
                browser,
                post,
                analysis.comment or "",
                cfg.posting,
                upvote_probability=cfg.humanize.upvote_probability if cfg.humanize.enabled else 0.0,
            )
        except Exception as e:
            logger.error("Failed to post on {}: {}", post.id, e)
            db.mark_skipped(post.id, f"post error: {e}")
            continue

        if success:
            db.mark_commented(post.id, dry_run=False)
            base_gap = cfg.posting.pick_gap_minutes()
            wait_minutes = base_gap + random.uniform(0, cfg.posting.jitter_minutes)
            logger.info(
                "Sleeping {:.1f} min before next post (base {:.1f} + jitter).",
                wait_minutes, base_gap,
            )
            time.sleep(wait_minutes * 60)
        else:
            db.mark_skipped(post.id, "post not confirmed")


def run_once(cfg: Config) -> None:
    db = StateDB(cfg.db_path_abs)

    # --- Humanize gates (only when actually posting) ---
    if cfg.humanize.enabled and not cfg.posting.dry_run:
        if not _within_active_hours(cfg):
            logger.info(
                "Outside active hours {} (now {}h). Doing nothing this run.",
                cfg.humanize.active_hours, datetime.now().hour,
            )
            db.close()
            return
        if random.random() < cfg.humanize.skip_day_probability:
            logger.info(
                "[human] Random skip-day triggered ({:.0%} chance). No activity this run.",
                cfg.humanize.skip_day_probability,
            )
            db.close()
            return

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
        # Warm up the session by lurking unrelated subs first (looks human).
        _maybe_lurk(cfg, browser)
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
