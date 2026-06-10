"""Playwright browser session: persistent profile, login, human-like input."""
from __future__ import annotations

import random
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator, Optional

from loguru import logger
from playwright.sync_api import (
    BrowserContext,
    Page,
    Playwright,
    sync_playwright,
)


class RedditBrowser:
    """Wraps a persistent Playwright Chromium context aimed at new reddit."""

    LOGIN_URL = "https://www.reddit.com/login/"
    HOME_URL = "https://www.reddit.com/"

    def __init__(
        self,
        user_data_dir: Path,
        headless: bool,
        user_agent: str,
        username: str,
        password: str,
    ):
        self.user_data_dir = user_data_dir
        self.headless = headless
        self.user_agent = user_agent
        self.username = username
        self.password = password

        self._pw: Optional[Playwright] = None
        self._ctx: Optional[BrowserContext] = None
        self._page: Optional[Page] = None

    # ---------------------------------------------------------------- lifecycle

    def start(self) -> None:
        self.user_data_dir.mkdir(parents=True, exist_ok=True)
        self._pw = sync_playwright().start()
        logger.info("Launching Chromium (headless={})", self.headless)
        self._ctx = self._pw.chromium.launch_persistent_context(
            user_data_dir=str(self.user_data_dir),
            headless=self.headless,
            user_agent=self.user_agent,
            viewport={"width": 1366, "height": 850},
            locale="en-US",
            timezone_id="America/New_York",
            # Reduce the obvious "controlled by automation" surface.
            ignore_default_args=["--enable-automation"],
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--disable-infobars",
                "--start-maximized",
                "--disable-features=IsolateOrigins,site-per-process",
            ],
        )

        # Try the playwright-stealth package if it's installed (best effort).
        self._apply_stealth_package()

        # Comprehensive fingerprint patches, applied to every page/frame.
        self._ctx.add_init_script(self._STEALTH_JS)

        self._page = (
            self._ctx.pages[0] if self._ctx.pages else self._ctx.new_page()
        )
        self._page.set_default_timeout(30_000)

    def _apply_stealth_package(self) -> None:
        """Use playwright-stealth if available. API differs across versions,
        so we try the known entry points and silently skip if none work."""
        try:
            import playwright_stealth as _ps  # type: ignore
        except Exception:
            logger.debug("playwright-stealth not installed; using built-in patches only.")
            return
        # Newer versions: Stealth().apply_stealth_sync(context/page)
        try:
            stealth = getattr(_ps, "Stealth", None)
            if stealth is not None:
                inst = stealth()
                for meth in ("apply_stealth_sync",):
                    fn = getattr(inst, meth, None)
                    if fn:
                        try:
                            fn(self._ctx)
                            logger.info("Applied playwright-stealth (context).")
                            return
                        except Exception:
                            pass
        except Exception:
            pass
        logger.debug("playwright-stealth present but no compatible API; built-in patches only.")

    # Injected into every document before any site script runs.
    _STEALTH_JS = """
    // webdriver flag
    Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
    // languages
    Object.defineProperty(navigator, 'languages', {get: () => ['en-US', 'en']});
    // plugins (non-empty looks more real)
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5].map(i => ({name: 'Plugin ' + i})),
    });
    // hardware hints
    try { Object.defineProperty(navigator, 'hardwareConcurrency', {get: () => 8}); } catch (e) {}
    try { Object.defineProperty(navigator, 'deviceMemory', {get: () => 8}); } catch (e) {}
    // chrome runtime stub
    window.chrome = window.chrome || { runtime: {} };
    // permissions query (notifications shouldn't report 'denied' headlessly)
    try {
      const orig = window.navigator.permissions.query;
      window.navigator.permissions.query = (p) => (
        p && p.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : orig(p)
      );
    } catch (e) {}
    // WebGL vendor/renderer spoof (avoid SwiftShader/headless tells)
    try {
      const getParam = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function (p) {
        if (p === 37445) return 'Intel Inc.';            // UNMASKED_VENDOR_WEBGL
        if (p === 37446) return 'Intel Iris OpenGL Engine'; // UNMASKED_RENDERER_WEBGL
        return getParam.call(this, p);
      };
    } catch (e) {}
    """

    def close(self) -> None:
        """Shut down Playwright without raising if the user closed the window."""
        try:
            if self._ctx:
                self._ctx.close()
        except Exception as e:
            logger.debug("Browser context close: {}", e)
        finally:
            self._ctx = None
        try:
            if self._pw:
                self._pw.stop()
        except Exception as e:
            logger.debug("Playwright stop: {}", e)
        finally:
            self._pw = None
            self._page = None

    @contextmanager
    def session(self) -> Iterator["RedditBrowser"]:
        self.start()
        try:
            yield self
        finally:
            self.close()

    # ------------------------------------------------------------------- pages

    @property
    def page(self) -> Page:
        assert self._page is not None, "Browser not started"
        return self._page

    # ------------------------------------------------------------------ auth

    def is_logged_in(self, navigate: bool = True) -> bool:
        """Check whether we're logged in. Tries several signals because Reddit
        sometimes redirects new accounts to onboarding pages where the normal
        header doesn't render."""
        if navigate:
            try:
                self.page.goto(self.HOME_URL, wait_until="domcontentloaded", timeout=20_000)
            except Exception as e:
                logger.debug("goto home failed during login check: {}", e)
            self._human_pause(1.0, 2.0)

        uname_lower = self.username.lower()

        # Signal 1: any link to your profile (new reddit avatar, etc.)
        try:
            el = self.page.locator(f"a[href*='/user/{self.username}']").first
            if el.count():
                return True
        except Exception:
            pass

        # Signal 2: page HTML contains /user/<username>
        try:
            html = self.page.content()
            if f"/user/{self.username}" in html or f"/u/{self.username}" in html:
                return True
        except Exception:
            pass

        # Signal 3: explicit logged-out signals on new reddit
        try:
            html = self.page.content().lower()
            if "log in or sign up in seconds" in html or "auth-flow-modal" in html:
                return False
            if 'href="/login"' in html and "log out" not in html:
                return False
        except Exception:
            pass

        return False

    def login(self) -> None:
        """Log in via www.reddit.com/login. Session is saved in the browser profile.

        IMPORTANT: While waiting for you to finish login manually, we do NOT
        navigate away from the page. (Previously we reloaded home every 3s,
        which kicked users off the login screen.)
        """
        if self.is_logged_in(navigate=True):
            logger.info("Already logged in as {}", self.username)
            return

        logger.info("Opening login page: {}", self.LOGIN_URL)
        self.page.goto(self.LOGIN_URL, wait_until="domcontentloaded")
        self._human_pause(2.0, 3.5)

        # ----- Auto-fill the new reddit login form -----
        # New reddit's form sometimes lives inside a shadow root and sometimes
        # not, so we try several selectors and fall back to JS injection.
        filled = self._autofill_login()
        if filled:
            logger.info("Auto-filled credentials and clicked Log In.")
        else:
            logger.warning(
                "Could not auto-fill the login form. Please type your "
                "credentials manually in the browser window."
            )

        logger.info(
            ">>> If a captcha appears, solve it in the browser. The bot will "
            "detect login automatically. No timeout. Ctrl+C to abort. <<<"
        )

        last_log = 0.0
        while True:
            # Check current page ONLY — do not navigate (that breaks manual login).
            if self.is_logged_in(navigate=False):
                logger.success("Logged in as {}", self.username)
                return
            now = time.time()
            if now - last_log > 30:
                logger.info(
                    "Still waiting for login... finish it in the browser tab. "
                    "(Press Ctrl+C here to cancel.)"
                )
                last_log = now
            time.sleep(2)

    # ------------------------------------------------------------- login helpers

    def _autofill_login(self) -> bool:
        """Try several strategies to put credentials into the login form
        and click submit. Returns True if a submit click was issued."""
        page = self.page

        # Strategy 1: plain CSS selectors (new reddit, light DOM)
        candidates_user = [
            'input[name="username"]',
            'input#login-username',
            'input[autocomplete="username"]',
        ]
        candidates_pass = [
            'input[name="password"]',
            'input#login-password',
            'input[autocomplete="current-password"]',
        ]

        user_loc = None
        pass_loc = None
        for sel in candidates_user:
            loc = page.locator(sel).first
            try:
                if loc.count() and loc.is_visible():
                    user_loc = loc
                    break
            except Exception:
                continue
        for sel in candidates_pass:
            loc = page.locator(sel).first
            try:
                if loc.count() and loc.is_visible():
                    pass_loc = loc
                    break
            except Exception:
                continue

        if user_loc and pass_loc:
            try:
                # Sanity-check: log only the lengths, never the values.
                logger.info(
                    "Auto-fill: username={} chars, password={} chars",
                    len(self.username), len(self.password),
                )
                self._clear_and_type(user_loc, self.username)
                self._human_pause(0.4, 1.0)
                self._clear_and_type(pass_loc, self.password)
                self._human_pause(0.6, 1.2)
                return self._click_login_button()
            except Exception as e:
                logger.debug("Direct fill failed: {}", e)

        # Strategy 2: shadow-DOM piercing via JS (new reddit web components)
        try:
            page.evaluate(
                """
                ({u, p}) => {
                  const setVal = (el, v) => {
                    const proto = Object.getPrototypeOf(el);
                    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
                    setter ? setter.call(el, v) : (el.value = v);
                    el.dispatchEvent(new Event('input', {bubbles:true}));
                    el.dispatchEvent(new Event('change', {bubbles:true}));
                  };
                  const walk = (root) => {
                    const inputs = root.querySelectorAll('input');
                    for (const i of inputs) {
                      const n = (i.getAttribute('name')||'').toLowerCase();
                      const a = (i.getAttribute('autocomplete')||'').toLowerCase();
                      const t = (i.getAttribute('type')||'').toLowerCase();
                      if (n==='username' || a==='username') setVal(i, u);
                      if (n==='password' || a==='current-password' || t==='password') setVal(i, p);
                    }
                    const all = root.querySelectorAll('*');
                    for (const el of all) if (el.shadowRoot) walk(el.shadowRoot);
                  };
                  walk(document);
                }
                """,
                {"u": self.username, "p": self.password},
            )
            self._human_pause(0.5, 1.2)
            return self._click_login_button()
        except Exception as e:
            logger.debug("JS shadow-fill failed: {}", e)

        return False

    def _click_login_button(self) -> bool:
        """Find and click the Log In button. Returns True if clicked."""
        page = self.page
        for sel in [
            'button[type="submit"]',
            'button:has-text("Log In")',
            'button:has-text("Log in")',
            'button:has-text("LOG IN")',
            'input[type="submit"]',
        ]:
            btn = page.locator(sel).first
            try:
                if btn.count() and btn.is_visible() and btn.is_enabled():
                    btn.click()
                    return True
            except Exception:
                continue

        # JS fallback: click the first visible submit-looking button
        try:
            clicked = page.evaluate(
                """
                () => {
                  const walk = (root) => {
                    const btns = root.querySelectorAll('button, input[type="submit"]');
                    for (const b of btns) {
                      const txt = (b.innerText || b.value || '').toLowerCase();
                      if (txt.includes('log in') || b.type === 'submit') {
                        b.click();
                        return true;
                      }
                    }
                    const all = root.querySelectorAll('*');
                    for (const el of all) if (el.shadowRoot && walk(el.shadowRoot)) return true;
                    return false;
                  };
                  return walk(document);
                }
                """
            )
            return bool(clicked)
        except Exception:
            return False

    # ----------------------------------------------------------- human helpers

    def _human_pause(self, lo: float, hi: float) -> None:
        time.sleep(random.uniform(lo, hi))

    def _human_type(self, locator, text: str) -> None:
        """Type one char at a time with small random delays."""
        locator.click()
        for ch in text:
            locator.type(ch, delay=random.uniform(40, 130))

    def _clear_and_type(self, locator, text: str) -> None:
        """Focus, hard-clear anything already in the field (autofill, residue),
        then type the value. Avoids the 'typed on top of autofill' bug."""
        locator.click()
        try:
            locator.fill("")  # set value to "" and dispatch input events
        except Exception:
            try:
                locator.press("Control+A")
                locator.press("Delete")
            except Exception:
                pass
        for ch in text:
            locator.type(ch, delay=random.uniform(40, 130))

    # Keys physically adjacent on a QWERTY keyboard (for realistic typos).
    _ADJACENT = {
        "a": "sqz", "b": "vghn", "c": "xdfv", "d": "serfcx", "e": "wrsdf",
        "f": "drtgvc", "g": "ftyhbv", "h": "gyujnb", "i": "ujko", "j": "huikmn",
        "k": "jiolm", "l": "kop", "m": "njk", "n": "bhjm", "o": "iklp",
        "p": "ol", "q": "wa", "r": "edft", "s": "awedxz", "t": "rfgy",
        "u": "yhji", "v": "cfgb", "w": "qase", "x": "zsdc", "y": "tghu",
        "z": "asx",
    }

    def human_type_in_textarea(self, locator, text: str, cps_min: float, cps_max: float) -> None:
        """Type into a comment box like a real person: variable speed, the
        occasional typo that gets backspaced and corrected, and short pauses
        at natural break points (after sentences / commas)."""
        locator.click()
        self._human_pause(0.3, 0.9)

        for idx, ch in enumerate(text):
            # Occasional typo on letters (~4%): type a wrong adjacent key,
            # pause as if noticing, backspace, then continue with the right one.
            lower = ch.lower()
            if lower in self._ADJACENT and random.random() < 0.04:
                wrong = random.choice(self._ADJACENT[lower])
                if ch.isupper():
                    wrong = wrong.upper()
                locator.type(wrong, delay=self._key_delay(cps_min, cps_max))
                self._human_pause(0.15, 0.5)
                locator.press("Backspace")
                self._human_pause(0.1, 0.3)

            locator.type(ch, delay=self._key_delay(cps_min, cps_max))

            # Natural thinking pauses after sentence/clause boundaries.
            if ch in ".!?" and random.random() < 0.7:
                self._human_pause(0.4, 1.3)
            elif ch == "," and random.random() < 0.4:
                self._human_pause(0.2, 0.7)
            # Rare random mid-word hesitation.
            elif random.random() < 0.015:
                self._human_pause(0.3, 1.0)

    def _key_delay(self, cps_min: float, cps_max: float) -> float:
        cps = random.uniform(cps_min, cps_max)
        return max(20.0, 1000.0 / cps + random.uniform(-30, 60))

    def human_scroll(self, times: int = 2) -> None:
        for _ in range(times):
            self.page.mouse.wheel(0, random.randint(300, 900))
            self._human_pause(0.4, 1.2)

    def idle_browse(self, url: str | None = None) -> None:
        """Do a small, human-like idle action: optional navigate, scroll a
        bit, occasionally scroll back, small mouse move. Used between AI
        calls so the user can see the bot 'browsing'."""
        try:
            if url:
                self.page.goto(url, wait_until="domcontentloaded", timeout=15_000)
                self._human_pause(0.8, 1.6)
            # 1-3 scrolls
            for _ in range(random.randint(1, 3)):
                direction = 1 if random.random() < 0.85 else -1
                self.page.mouse.wheel(0, direction * random.randint(250, 700))
                self._human_pause(0.4, 1.0)
            # Occasional mouse jiggle
            if random.random() < 0.5:
                self.page.mouse.move(
                    random.randint(200, 1100),
                    random.randint(200, 700),
                    steps=random.randint(5, 20),
                )
        except Exception as e:
            logger.debug("idle_browse hiccup (ignored): {}", e)

    # --------------------------------------------------------- behavior mix

    def lurk_subreddit(self, subreddit: str, dwell_min: float = 4.0, dwell_max: float = 12.0) -> None:
        """Casually browse an unrelated subreddit feed: scroll, pause, maybe
        upvote. Makes the account look like a real person, not a comment bot."""
        url = f"https://www.reddit.com/r/{subreddit}/"
        logger.info("[human] Lurking r/{}", subreddit)
        try:
            self.page.goto(url, wait_until="domcontentloaded", timeout=20_000)
        except Exception as e:
            logger.debug("[human] lurk navigation issue: {}", e)
            return
        self._human_pause(1.5, 3.0)
        dwell = random.uniform(dwell_min, dwell_max)
        end = time.time() + dwell
        while time.time() < end:
            self.page.mouse.wheel(0, random.randint(400, 1100))
            self._human_pause(0.8, 2.2)
            if random.random() < 0.15:
                # scroll back up a touch
                self.page.mouse.wheel(0, -random.randint(200, 600))
                self._human_pause(0.5, 1.2)

    def try_upvote_current_page(self, probability: float = 0.45) -> bool:
        """With some probability, click an upvote button on the current page.
        Works on new reddit (aria-label) and old reddit (.arrow.up). Best-effort;
        never raises. Returns True if it clicked something."""
        if random.random() >= probability:
            return False
        candidates = [
            "button[aria-label='upvote']",
            "button[aria-label='Upvote']",
            "[data-testid='upvote-button']",
            "div.arrow.up",  # old reddit
        ]
        for sel in candidates:
            try:
                loc = self.page.locator(sel).first
                if loc.count() and loc.is_visible():
                    loc.click(timeout=3000)
                    logger.info("[human] Upvoted something ({}).", sel)
                    self._human_pause(0.5, 1.5)
                    return True
            except Exception:
                continue
        return False
