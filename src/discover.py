"""Discover candidate posts in a subreddit using Reddit's public JSON feed.

We use Reddit's `?.json` endpoint via the already-logged-in browser. This is
the same data the new-reddit UI renders, but easier to parse than HTML.

If `visual_mode` is enabled, we ALSO navigate the visible browser window to
each subreddit on www.reddit.com and scroll it before fetching JSON, so the
user can watch the bot working.
"""
from __future__ import annotations

import json
import random
import time
from dataclasses import dataclass
from typing import List, Optional

from loguru import logger

from .browser import RedditBrowser
from .config import DiscoveryCfg


@dataclass
class Post:
    id: str            # e.g. "1abcd2"
    subreddit: str
    title: str
    body: str
    author: str
    url: str           # canonical https://www.reddit.com/r/.../comments/...
    permalink: str     # /r/.../comments/.../...
    created_utc: int
    num_comments: int
    upvotes: int
    over_18: bool
    locked: bool
    archived: bool
    is_self: bool      # text post vs link post


def _fetch_listing_json(browser: RedditBrowser, subreddit: str, sort: str, limit: int) -> dict:
    """Use the browser to fetch /r/<sub>/<sort>.json. Reddit responds with JSON."""
    url = f"https://www.reddit.com/r/{subreddit}/{sort}.json?limit={limit}"
    logger.debug("GET {}", url)
    resp = browser.page.request.get(url, headers={"Accept": "application/json"})
    if not resp.ok:
        raise RuntimeError(f"Failed to fetch {url}: HTTP {resp.status}")
    try:
        return resp.json()
    except Exception:
        # Fallback in case content-type is off
        return json.loads(resp.text())


def _parse_post(child: dict, subreddit: str) -> Optional[Post]:
    d = child.get("data") or {}
    pid = d.get("id")
    if not pid:
        return None
    permalink = d.get("permalink", "")
    return Post(
        id=pid,
        subreddit=subreddit,
        title=(d.get("title") or "").strip(),
        body=(d.get("selftext") or "").strip(),
        author=d.get("author") or "",
        url="https://www.reddit.com" + permalink if permalink else (d.get("url") or ""),
        permalink=permalink,
        created_utc=int(d.get("created_utc") or 0),
        num_comments=int(d.get("num_comments") or 0),
        upvotes=int(d.get("ups") or 0),
        over_18=bool(d.get("over_18")),
        locked=bool(d.get("locked")),
        archived=bool(d.get("archived")),
        is_self=bool(d.get("is_self")),
    )


def _visit_subreddit_visibly(browser: RedditBrowser, subreddit: str, sort: str) -> None:
    """Open the subreddit in the visible browser tab and scroll a bit so the
    user can watch the bot 'browsing' before we fetch JSON behind the scenes."""
    url = f"https://www.reddit.com/r/{subreddit}/{sort}/"
    logger.info("[visual] Navigating to {}", url)
    try:
        browser.page.goto(url, wait_until="domcontentloaded", timeout=20_000)
    except Exception as e:
        logger.debug("[visual] navigation issue: {}", e)
        return
    browser._human_pause(1.5, 2.5)
    # Scroll a few times like a real user skimming the list.
    for _ in range(random.randint(3, 6)):
        browser.page.mouse.wheel(0, random.randint(400, 900))
        browser._human_pause(0.6, 1.4)
    # Tiny scroll back up sometimes - feels human.
    if random.random() < 0.4:
        browser.page.mouse.wheel(0, -random.randint(200, 500))
        browser._human_pause(0.4, 1.0)


def _open_post_visibly(browser: RedditBrowser, post: "Post") -> None:
    """Open one candidate post in the visible browser tab and scroll."""
    if not post.url:
        return
    url = post.url  # already https://www.reddit.com/...
    logger.info("[visual] Reading post: {}", url)
    try:
        browser.page.goto(url, wait_until="domcontentloaded", timeout=20_000)
    except Exception as e:
        logger.debug("[visual] post open issue: {}", e)
        return
    browser._human_pause(1.5, 3.0)
    for _ in range(random.randint(2, 4)):
        browser.page.mouse.wheel(0, random.randint(300, 700))
        browser._human_pause(0.5, 1.2)


def discover_posts(
    browser: RedditBrowser,
    subreddit: str,
    cfg: DiscoveryCfg,
) -> List[Post]:
    """Return posts that pass cheap structural filters. AI scoring happens later."""
    if cfg.visual_mode:
        _visit_subreddit_visibly(browser, subreddit, cfg.sort)

    try:
        payload = _fetch_listing_json(browser, subreddit, cfg.sort, cfg.posts_per_subreddit)
    except Exception as e:
        logger.error("Discovery failed for r/{}: {}", subreddit, e)
        return []

    children = (payload.get("data") or {}).get("children") or []
    now = int(time.time())
    out: List[Post] = []

    for child in children:
        post = _parse_post(child, subreddit)
        if post is None:
            continue

        # Structural / safety filters
        if not post.is_self:
            continue  # skip link posts - we want text discussions
        if post.locked or post.archived or post.over_18:
            continue
        age_seconds = now - post.created_utc
        if age_seconds < cfg.min_age_minutes * 60:
            continue
        if age_seconds > cfg.max_age_hours * 3600:
            continue
        if len(post.body) < cfg.min_body_chars:
            continue

        # Optional keyword pre-filter
        if cfg.keywords:
            hay = (post.title + " " + post.body).lower()
            if not any(kw.lower() in hay for kw in cfg.keywords):
                continue

        out.append(post)

    logger.info("r/{}: {} candidate post(s) after filtering", subreddit, len(out))

    # Optionally open each candidate post in the visible browser so the user
    # can watch the bot "reading" before AI scoring happens.
    if cfg.visual_mode and cfg.visual_open_posts:
        for p in out[:5]:  # cap at 5 to avoid wasting time
            _open_post_visibly(browser, p)

    return out
