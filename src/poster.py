"""Post a comment on a Reddit post via the logged-in browser.

`posting.use_old_reddit` in config.yaml controls which UI is used:
  - true  -> old.reddit.com (plain textarea, most reliable)
  - false -> www.reddit.com (more human; optional fallback to old)
"""
from __future__ import annotations

import random
import time
from typing import Optional
from urllib.parse import urlparse

from loguru import logger
from playwright.sync_api import Locator

from .browser import RedditBrowser
from .config import PostingCfg
from .discover import Post


def _to_old_reddit(url: str) -> str:
    parsed = urlparse(url)
    if not parsed.netloc:
        return url
    return url.replace("://www.reddit.com", "://old.reddit.com").replace(
        "://reddit.com", "://old.reddit.com"
    )


def _to_new_reddit(url: str) -> str:
    return url.replace("://old.reddit.com", "://www.reddit.com")


def post_comment(
    browser: RedditBrowser,
    post: Post,
    text: str,
    cfg: PostingCfg,
    upvote_probability: float = 0.0,
) -> bool:
    """Returns True on apparent success, False otherwise."""
    if cfg.use_old_reddit:
        return _post_old_reddit(browser, post, text, cfg, upvote_probability)

    ok = _post_new_reddit(browser, post, text, cfg, upvote_probability)
    if ok:
        return True
    if cfg.fallback_to_old_reddit:
        logger.warning("New-reddit post failed; falling back to old.reddit...")
        return _post_old_reddit(browser, post, text, cfg, upvote_probability)
    return False


def _open_and_read(
    browser: RedditBrowser,
    url: str,
    upvote_probability: float,
) -> None:
    browser.page.goto(url, wait_until="domcontentloaded", timeout=20_000)
    browser._human_pause(2.0, 3.5)
    browser.human_scroll(times=random.randint(2, 4))
    if upvote_probability > 0:
        browser.try_upvote_current_page(probability=upvote_probability)


def _post_old_reddit(
    browser: RedditBrowser,
    post: Post,
    text: str,
    cfg: PostingCfg,
    upvote_probability: float,
) -> bool:
    target = _to_old_reddit(post.url)
    logger.info("Opening post to comment (old reddit): {}", target)
    _open_and_read(browser, target, upvote_probability)

    textarea = browser.page.locator(
        ".commentarea form.usertext textarea[name='text']"
    ).first
    try:
        textarea.wait_for(state="visible", timeout=15_000)
    except Exception:
        logger.warning("Old-reddit comment box not visible.")
        if "You must be logged in" in browser.page.content():
            raise RuntimeError(
                "Session expired - please re-login (delete data/browser_profile)."
            )
        return False

    return _type_submit_confirm(
        browser, textarea, text, cfg, snippet_check_in_page=True
    )


def _post_new_reddit(
    browser: RedditBrowser,
    post: Post,
    text: str,
    cfg: PostingCfg,
    upvote_probability: float,
) -> bool:
    target = _to_new_reddit(post.url)
    logger.info("Opening post to comment (new reddit): {}", target)
    _open_and_read(browser, target, upvote_probability)

    composer = _find_new_reddit_composer(browser)
    if composer is None:
        logger.warning("New-reddit comment composer not found.")
        return False

    return _type_submit_confirm(
        browser, composer, text, cfg, snippet_check_in_page=True
    )


def _find_new_reddit_composer(browser: RedditBrowser) -> Optional[Locator]:
    """Best-effort: open the top-level comment box on new reddit."""
    page = browser.page

    # Sometimes the composer is collapsed behind a placeholder / button.
    for sel in [
        "textarea[placeholder*='comment' i]",
        "textarea[placeholder*='Add a comment' i]",
        "textarea[aria-label*='comment' i]",
        "div[contenteditable='true'][role='textbox']",
        "div[contenteditable='true']",
        "faceplate-textarea-input textarea",
        "shreddit-composer textarea",
    ]:
        try:
            loc = page.locator(sel).first
            if loc.count() and loc.is_visible():
                return loc
        except Exception:
            continue

    # Click triggers that expand the composer.
    for sel in [
        "textarea[placeholder*='comment' i]",
        "div[contenteditable='true']",
        "button:has-text('Add a comment')",
        "button:has-text('Join the conversation')",
        "[data-testid='comment-composer']",
    ]:
        try:
            loc = page.locator(sel).first
            if loc.count() and loc.is_visible():
                loc.click()
                browser._human_pause(0.8, 1.6)
                break
        except Exception:
            continue

    # Re-scan after click.
    for sel in [
        "textarea[placeholder*='comment' i]",
        "textarea[aria-label*='comment' i]",
        "div[contenteditable='true'][role='textbox']",
        "div[contenteditable='true']",
        "faceplate-textarea-input textarea",
        "shreddit-composer textarea",
    ]:
        try:
            loc = page.locator(sel).first
            if loc.count() and loc.is_visible():
                return loc
        except Exception:
            continue

    return None


def _find_submit_button(browser: RedditBrowser, on_old: bool) -> Optional[Locator]:
    page = browser.page
    if on_old:
        selectors = [
            ".commentarea form.usertext button.save",
            ".commentarea form.usertext button[type='submit']",
        ]
    else:
        selectors = [
            "button:has-text('Comment')",
            "button:has-text('Reply')",
            "button[type='submit']:has-text('Comment')",
            "shreddit-composer button[type='submit']",
            "faceplate-tracker[noun='comment'] button",
        ]
    for sel in selectors:
        try:
            btn = page.locator(sel).first
            if btn.count() and btn.is_visible() and btn.is_enabled():
                return btn
        except Exception:
            continue
    return None


def _type_submit_confirm(
    browser: RedditBrowser,
    field: Locator,
    text: str,
    cfg: PostingCfg,
    snippet_check_in_page: bool,
) -> bool:
    try:
        field.click()
        browser._human_pause(0.8, 2.0)
    except Exception:
        pass

    browser.human_type_in_textarea(
        field,
        text,
        cps_min=cfg.typing_cps_min,
        cps_max=cfg.typing_cps_max,
    )
    browser._human_pause(1.5, 3.5)

    on_old = "old.reddit.com" in browser.page.url
    submit_btn = _find_submit_button(browser, on_old=on_old)
    if submit_btn is None:
        logger.error("Submit button not found")
        return False

    submit_btn.click()
    logger.info("Submitted comment - waiting for confirmation...")

    deadline = time.time() + 45
    snippet = text[:60].strip()
    last_status = ""

    while time.time() < deadline:
        try:
            current = field.input_value(timeout=2000)
        except Exception:
            current = ""

        page_text = ""
        try:
            page_text = browser.page.content()
        except Exception:
            pass

        if snippet_check_in_page and snippet and snippet in page_text:
            # Old reddit: cleared box is a strong signal. New reddit: text in page is enough.
            if on_old:
                if current == "":
                    logger.success("Comment appears posted.")
                    return True
            else:
                logger.success("Comment appears posted (new reddit).")
                return True

        err = _read_form_error(browser)
        if err and err.lower() != last_status.lower():
            last_status = err
            logger.info("Form status: {!r}", err)
        if err and _is_real_error(err):
            logger.error("Reddit refused the comment. Exact message: {!r}", err)
            return False

        time.sleep(2.0)

    try:
        page_text = browser.page.content()
        if snippet and snippet in page_text:
            logger.success("Comment appears posted (detected late).")
            return True
    except Exception:
        pass

    logger.warning(
        "Could not confirm comment posted within 45s. Check the post manually."
    )
    return False


_BENIGN_STATUS = (
    "submitting",
    "saving",
    "loading",
    "please wait",
)

_REAL_ERROR_PHRASES = (
    "you are doing that too much",
    "try again in",
    "ratelimit",
    "rate limit",
    "verify your email",
    "must be logged in",
    "subreddit only allows",
    "approved submitter",
    "does not meet",
    "minimum karma",
    "spam",
    "blocked",
    "banned",
    "removed",
    "incorrect",
    "wrong password",
    "captcha",
)


def _is_real_error(text: str) -> bool:
    t = text.lower()
    if any(b in t for b in _BENIGN_STATUS):
        return False
    return any(p in t for p in _REAL_ERROR_PHRASES)


def _read_form_error(browser) -> str:
    page = browser.page
    selectors = [
        ".commentarea form.usertext .error",
        ".commentarea form.usertext .status",
        ".commentarea .ratelimit",
        ".commentarea .error",
        ".infobar.welcome",
        ".infobar .md",
        ".error",
        ".ratelimit",
    ]
    for sel in selectors:
        try:
            loc = page.locator(sel).first
            if loc.count() and loc.is_visible():
                txt = (loc.inner_text(timeout=1500) or "").strip()
                if txt:
                    return txt[:300]
        except Exception:
            continue
    return ""
