"""Post a comment on a Reddit post via the logged-in browser.

Strategy:
  - Everything visible to the user uses NEW reddit (www.reddit.com).
  - The actual comment submission switches to OLD reddit for ~5 seconds
    because old.reddit's plain <textarea> + form is the most reliable way
    to post via Playwright. New reddit uses shadow-DOM web components that
    break across UI redesigns.
  - Cookies are valid across *.reddit.com, so this switch is invisible to
    Reddit (same session, same account).
"""
from __future__ import annotations

import random
import time
from urllib.parse import urlparse

from loguru import logger

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
) -> bool:
    """Returns True on apparent success, False otherwise."""

    # Step 1: Open the post on NEW reddit so the user sees the modern UI.
    new_url = _to_new_reddit(post.url)
    logger.info("Opening post (new reddit, visible): {}", new_url)
    try:
        browser.page.goto(new_url, wait_until="domcontentloaded", timeout=20_000)
        browser._human_pause(2.0, 3.5)
        browser.human_scroll(times=random.randint(1, 3))
    except Exception as e:
        logger.debug("New reddit preview navigation issue: {}", e)

    # Step 2: Switch to OLD reddit for the actual posting (reliable form).
    target = _to_old_reddit(post.url)
    logger.info("Switching to old reddit for the comment submit: {}", target)
    browser.page.goto(target, wait_until="domcontentloaded")
    browser._human_pause(1.5, 3.0)
    browser.human_scroll(times=random.randint(1, 2))

    # The top-level comment textarea on old.reddit is name="text" inside
    # the .commentarea > .usertext form. We pick the FIRST one (top-level).
    textarea = browser.page.locator(".commentarea form.usertext textarea[name='text']").first
    try:
        textarea.wait_for(state="visible", timeout=15_000)
    except Exception:
        # Box may be hidden until we click "reply". Old reddit usually shows it
        # immediately, but fall back if not.
        logger.warning("Comment textarea not visible directly; checking page state.")
        if "You must be logged in" in browser.page.content():
            raise RuntimeError("Session expired - please re-login (delete data/browser_profile).")
        return False

    browser.human_type_in_textarea(
        textarea,
        text,
        cps_min=cfg.typing_cps_min,
        cps_max=cfg.typing_cps_max,
    )
    browser._human_pause(1.0, 2.5)

    submit_btn = browser.page.locator(
        ".commentarea form.usertext button.save, .commentarea form.usertext button[type='submit']"
    ).first
    if submit_btn.count() == 0 or not submit_btn.is_visible():
        logger.error("Submit button not found")
        return False

    submit_btn.click()
    logger.info("Submitted comment - waiting for confirmation...")

    # Wait up to 45s for one of three outcomes:
    #   - Our text appears in the comment tree (success)
    #   - A REAL error message appears (failure)
    #   - Timeout (unknown - tell user to check manually)
    deadline = time.time() + 45
    snippet = text[:60].strip()
    last_status = ""

    while time.time() < deadline:
        try:
            current = textarea.input_value(timeout=2000)
        except Exception:
            current = ""

        page_text = ""
        try:
            page_text = browser.page.content()
        except Exception:
            pass

        # Success: textarea cleared AND our text is in the visible page.
        if current == "" and snippet and snippet in page_text:
            logger.success("Comment appears posted on {}", post.id)
            return True

        # Check for a REAL error (ignore status text like 'submitting...').
        err = _read_form_error(browser)
        if err and err.lower() != last_status.lower():
            last_status = err
            logger.info("Form status: {!r}", err)
        if err and _is_real_error(err):
            logger.error("Reddit refused the comment. Exact message: {!r}", err)
            return False

        time.sleep(2.0)

    # Timed out. Could still have posted - check the URL and page text once more.
    try:
        page_text = browser.page.content()
        if snippet and snippet in page_text:
            logger.success("Comment appears posted on {} (detected late).", post.id)
            return True
    except Exception:
        pass

    logger.warning(
        "Could not confirm comment posted within 45s (post {}). "
        "Open the URL in your browser and check manually.",
        post.id,
    )
    return False


# Words that mean "in progress", not a real failure.
_BENIGN_STATUS = (
    "submitting",
    "saving",
    "loading",
    "please wait",
)

# Words/phrases that mean a real refusal.
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
    """Scrape any visible error message Reddit displayed under/near the form.

    Old.reddit shows errors inside `.error`, `.status`, `.ratelimit` elements
    in the comment form, and sometimes as a flashing message at the top.
    Returns the trimmed text of the FIRST one we can find, or "" if none.
    """
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
