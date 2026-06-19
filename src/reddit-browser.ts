import fs from "node:fs";

import { BrowserContext, Locator, Page, chromium } from "rebrowser-playwright";
import { path as ghostPath } from "ghost-cursor";

import { AppConfig } from "./config.js";
import { logger } from "./logger.js";

/** Max time to wait for login to be confirmed, leaving room to solve a captcha by hand. */
const LOGIN_TIMEOUT_MS = 600_000;

interface Point {
  x: number;
  y: number;
}

export class RedditBrowser {
  private context: BrowserContext | null = null;
  private activePage: Page | null = null;
  // Track our own cursor position so each move starts where the last one ended,
  // producing continuous human-looking paths instead of teleport-clicks.
  private cursor: Point = { x: 400, y: 400 };

  constructor(private readonly config: AppConfig) {}

  get page(): Page {
    if (!this.activePage) {
      throw new Error("Browser session has not started");
    }
    return this.activePage;
  }

  async start(): Promise<void> {
    fs.mkdirSync(this.config.browser.userDataDir, { recursive: true });

    const launchOptions = {
      headless: this.config.browser.headless,
      viewport: { width: 1440, height: 900 },
      locale: this.config.browser.locale,
      timezoneId: this.config.browser.timezoneId,
      ignoreDefaultArgs: ["--enable-automation"],
      args: [
        "--disable-blink-features=AutomationControlled",
        "--disable-dev-shm-usage",
        "--disable-infobars",
        "--remote-debugging-port=9222",
        "--remote-debugging-address=127.0.0.1",
        "--remote-allow-origins=*",
      ],
      ...(this.config.browser.userAgent ? { userAgent: this.config.browser.userAgent } : {}),
      ...(this.config.proxy ? { proxy: this.config.proxy } : {}),
    };

    // Prefer the real installed Chrome for an authentic fingerprint; fall back
    // to bundled Chromium if that channel isn't available on this machine.
    const channel = this.config.browser.channel.trim();
    try {
      this.context = await chromium.launchPersistentContext(this.config.browser.userDataDir, {
        ...launchOptions,
        ...(channel ? { channel } : {}),
      });
      if (channel) {
        logger.info({ channel }, "Launched real browser channel");
      }
    } catch (error) {
      if (!channel) {
        throw error;
      }
      logger.warn({ channel, error }, "Real browser channel unavailable, using bundled Chromium");
      this.context = await chromium.launchPersistentContext(this.config.browser.userDataDir, launchOptions);
    }

    this.activePage = this.context.pages()[0] ?? (await this.context.newPage());
    this.activePage.setDefaultTimeout(30_000);
    this.cursor = { x: randomInt(200, 800), y: randomInt(200, 600) };
  }

  async close(): Promise<void> {
    await this.context?.close();
    this.context = null;
    this.activePage = null;
  }

  async withSession<T>(fn: () => Promise<T>): Promise<T> {
    await this.start();
    try {
      return await fn();
    } finally {
      await this.close();
    }
  }

  async login(): Promise<void> {
    if (await this.isLoggedIn(true)) {
      logger.info("Already logged in");
      return;
    }

    logger.info("Opening Reddit login page");
    await this.page.goto("https://www.reddit.com/login/", { waitUntil: "domcontentloaded" });
    await this.pause(1500, 2500);

    const username = this.page.locator('input[name="username"], input[autocomplete="username"]').first();
    const password = this.page.locator('input[name="password"], input[autocomplete="current-password"]').first();

    if ((await username.count()) > 0 && (await password.count()) > 0) {
      await this.humanTypeInto(username, this.config.redditUsername);
      await this.pause(300, 800);
      await this.humanTypeInto(password, this.config.redditPassword);
      await this.pause(500, 1000);
      const submit = this.page.locator('button[type="submit"], input[type="submit"]').first();
      if ((await submit.count()) > 0) {
        await this.humanClick(submit);
      }
    }

    logger.info("Waiting for Reddit login to finish. Solve captcha manually if prompted.");
    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    while (!(await this.isLoggedIn(false))) {
      if (Date.now() > deadline) {
        throw new Error(
          `Login not confirmed within ${Math.round(LOGIN_TIMEOUT_MS / 1000)}s. ` +
            "Reddit may be showing a captcha or blocking the automated login.",
        );
      }
      await this.pause(1500, 2500);
    }
    logger.info("Login confirmed");
  }

  async isLoggedIn(navigate: boolean): Promise<boolean> {
    if (navigate) {
      await this.page.goto("https://www.reddit.com/", { waitUntil: "domcontentloaded" });
      await this.pause(1000, 1800);
    }

    const html = (await this.safePageHtml()).toLowerCase();
    if (html.includes(`/user/${this.config.redditUsername.toLowerCase()}`)) {
      return true;
    }
    if (html.includes("/login") && !html.includes("log out")) {
      return false;
    }

    const profileLink = this.page
      .locator(`a[href*="/user/${this.config.redditUsername}"], a[href*="/u/${this.config.redditUsername}"]`)
      .first();
    return (await profileLink.count()) > 0;
  }

  /**
   * Read the page's HTML, tolerant of Reddit's SPA navigating underneath us.
   * `page.content()` throws "the page is navigating" if it fires mid-transition,
   * so we wait for the DOM to settle and retry that specific case.
   */
  async safePageHtml(): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await this.page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => undefined);
        return await this.page.content();
      } catch (error) {
        const message = String((error as Error)?.message ?? error);
        if (message.includes("navigating") && attempt < 4) {
          await delay(800);
          continue;
        }
        throw error;
      }
    }
    return "";
  }

  /**
   * Pause the way a person does right after a page loads: a beat for the page to
   * paint, then a moment to actually look at it before doing anything. Naive
   * automation acts the instant navigation resolves — this is the single biggest
   * "too fast" tell, so every navigation below settles through here.
   */
  async settleAfterLoad(): Promise<void> {
    await this.pause(2200, 5200);
    await this.idleDrift();
    if (Math.random() < 0.45) {
      await this.pause(900, 2400);
    }
  }

  async lurkSubreddit(subreddit: string): Promise<void> {
    await this.page.goto(`https://www.reddit.com/r/${subreddit}/`, { waitUntil: "domcontentloaded" });
    await this.settleAfterLoad();
    await this.humanScroll(randomInt(3, 6));
    await this.maybeMicroBreak();
  }

  async idleBrowse(url?: string): Promise<void> {
    if (url) {
      await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
      await this.settleAfterLoad();
    }
    await this.humanScroll(randomInt(2, 4));
  }

  /**
   * Open a post the way a person does — by clicking its card in a feed rather
   * than deep-linking to the URL. Cold full-page loads of `/comments/` pages are
   * both an automation tell (no referrer, no click) and, in practice, what
   * Reddit throttles: feeds load reliably while cold post-page gotos time out.
   *
   * Strategy, in order:
   *   1. Click the card if it's already on the page we're looking at.
   *   2. Otherwise visit the subreddit feed and scroll to find the card.
   *   3. Last resort, open the URL directly (still "warm" — we're already on
   *      Reddit with a session and history).
   *
   * Returns how the post was opened so the caller can navigate "back" to the
   * feed afterwards when it came from a click, like a real reader would.
   */
  async openPost(post: { id: string; url: string; subreddit: string }): Promise<"click" | "goto"> {
    if (await this.clickPostCard(post.id)) {
      return "click";
    }

    try {
      // Discovered posts are recent (< 12h), so the "new" feed is where they're
      // most likely to be found and clicked through to.
      await this.page.goto(`https://www.reddit.com/r/${post.subreddit}/new/`, {
        waitUntil: "domcontentloaded",
        timeout: 20_000,
      });
      await this.settleAfterLoad();
      for (let attempt = 0; attempt < 4; attempt += 1) {
        if (await this.clickPostCard(post.id)) {
          return "click";
        }
        await this.humanScroll(2);
      }
    } catch {
      // Feed navigation hiccup — fall through to a direct open.
    }

    await this.page.goto(post.url, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await this.settleAfterLoad();
    return "goto";
  }

  /**
   * Click the title link of a post card present on the current page. Returns
   * false (without throwing) if the card isn't here or the click doesn't land on
   * a post page, so {@link openPost} can fall back to another strategy.
   */
  private async clickPostCard(postId: string): Promise<boolean> {
    const card = this.page.locator(`shreddit-post[id="t3_${postId}"]`).first();
    if ((await card.count()) === 0) {
      return false;
    }
    // Any anchor inside the card pointing at the comments page is the human
    // click target (the title link / full-post overlay link).
    const link = card.locator('a[href*="/comments/"]').first();
    const clickable = (await link.count()) > 0 ? link : card;
    try {
      await clickable.scrollIntoViewIfNeeded();
      // Pause on the title as a person does before deciding to open it.
      await this.pause(600, 1500);
      await this.humanClick(clickable);
      await this.page.waitForURL((url) => url.toString().includes("/comments/"), { timeout: 15_000 });
    } catch {
      return false;
    }
    await this.settleAfterLoad();
    return true;
  }

  /** Navigate back to the previous page, the way the browser's back button does. */
  async goBack(): Promise<void> {
    try {
      await this.page.goBack({ waitUntil: "domcontentloaded", timeout: 15_000 });
      await this.settleAfterLoad();
    } catch {
      // Nothing to go back to, or the back nav stalled — caller will re-navigate.
    }
  }

  /** A brief, aimless browse of the home feed — how a session actually begins. */
  async warmUp(): Promise<void> {
    try {
      await this.page.goto("https://www.reddit.com/", { waitUntil: "domcontentloaded", timeout: 20_000 });
      await this.settleAfterLoad();
      await this.humanScroll(randomInt(3, 5));
      await this.maybeMicroBreak(0.4);
    } catch {
      // A warm-up hiccup must never abort the session.
    }
  }

  async humanScroll(times: number): Promise<void> {
    for (let index = 0; index < times; index += 1) {
      // Vary direction occasionally and step size, like a real reader.
      const direction = Math.random() < 0.15 ? -1 : 1;
      await this.page.mouse.wheel(0, direction * randomInt(220, 760));
      // Linger on what just scrolled into view before scrolling again.
      await this.pause(900, 2400);
      // A real reader's hand never sits perfectly still on the mouse.
      await this.idleDrift();
    }
  }

  /** Dwell on a page for a time proportional to how much text there is to read. */
  async readDwell(text: string): Promise<void> {
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    // Unhurried reading speed; a person skims, re-reads, and pauses to think.
    const wpm = randomInt(160, 280);
    const baseMs = (words / wpm) * 60_000;
    const dwell = Math.max(3500, Math.min(34_000, Math.round(baseMs)));
    const chunks = Math.max(2, Math.round(dwell / 2500));
    for (let i = 0; i < chunks; i += 1) {
      await this.page.mouse.wheel(0, randomInt(160, 480));
      await this.pause(1600, 3400);
      // Drift the cursor while reading — the eye and hand wander together.
      await this.idleDrift();
    }
  }

  async tryUpvote(probability: number): Promise<void> {
    if (Math.random() > probability) {
      return;
    }
    for (const selector of [
      'button[aria-label*="upvote" i]',
      'button[aria-label*="Upvote" i]',
      ".arrow.up",
    ]) {
      const button = this.page.locator(selector).first();
      if ((await button.count()) > 0 && (await button.isVisible())) {
        try {
          await this.humanClick(button);
          await this.pause(300, 800);
          return;
        } catch {
          continue;
        }
      }
    }
  }

  /**
   * Engage with the comment section the way a reader actually does: scroll down
   * through the discussion, dwell on it, and upvote a helpful comment or two.
   * The bot used to read only the original post and leave — never touching the
   * thread that everyone else is here for, which is the most un-human thing a
   * Reddit account can do. The reading scroll is DOM-agnostic and always runs;
   * comment up-votes are best-effort across old/new Reddit markup and silently
   * do nothing if the buttons aren't found. Never throws.
   *
   * @param commentUpvoteProbability chance of up-voting 1–2 comments this visit
   */
  async browseComments(commentUpvoteProbability = 0.4): Promise<void> {
    try {
      // Read down through the thread, pausing on what scrolls into view.
      const passes = randomInt(2, 5);
      for (let i = 0; i < passes; i += 1) {
        await this.page.mouse.wheel(0, randomInt(300, 720));
        await this.pause(1400, 3600);
        await this.idleDrift();
      }
      // Sometimes a comment is good enough to upvote — a far more common action
      // than voting on the post itself.
      if (Math.random() < commentUpvoteProbability) {
        await this.upvoteComments(randomInt(1, 2));
      }
      // Occasionally scroll back up to re-read part of the discussion.
      if (Math.random() < 0.3) {
        await this.page.mouse.wheel(0, -randomInt(300, 800));
        await this.pause(1000, 2600);
        await this.idleDrift();
      }
    } catch {
      // Comment browsing must never abort the session.
    }
  }

  /** Up-vote up to `count` comments in the current thread (best-effort). */
  private async upvoteComments(count: number): Promise<void> {
    // Candidate up-vote-button selectors across new Reddit (shreddit, open
    // shadow DOM which Playwright's CSS engine pierces) and old Reddit.
    const selectors = [
      'shreddit-comment button[aria-label*="upvote" i]',
      'shreddit-comment [aria-label*="upvote" i]',
      ".commentarea .comment .arrow.up:not(.upmod)",
    ];
    let upvoted = 0;
    for (const selector of selectors) {
      if (upvoted >= count) break;
      const buttons = this.page.locator(selector);
      const total = await buttons.count().catch(() => 0);
      if (total === 0) continue;
      // Stay near the top of the thread, where a reader's attention is, and
      // pick a couple of distinct comments rather than the same one.
      const pool = Math.min(total, 8);
      const chosen = new Set<number>();
      while (chosen.size < Math.min(count - upvoted, pool)) {
        chosen.add(randomInt(0, pool - 1));
      }
      for (const index of chosen) {
        if (upvoted >= count) break;
        const button = buttons.nth(index);
        try {
          if (!(await button.isVisible())) continue;
          await this.humanClick(button);
          upvoted += 1;
          await this.pause(600, 1800);
        } catch {
          // Button vanished or wasn't clickable — skip it.
        }
      }
    }
  }

  /** Type into a field located by CSS selector (used by the comment publisher). */
  async humanType(selector: string, text: string, cpsMin: number, cpsMax: number): Promise<void> {
    const field = this.page.locator(selector).first();
    await this.humanTypeInto(field, text, cpsMin, cpsMax);
  }

  /**
   * Type into a located field character by character with variable speed,
   * sentence-end pauses, and the occasional typo that gets backspaced and
   * corrected — the texture of real keyboard input.
   */
  async humanTypeInto(field: Locator, text: string, cpsMin = 3, cpsMax = 6): Promise<void> {
    await this.humanClick(field);
    await this.pause(150, 450);
    await this.typeChars(field, text, cpsMin, cpsMax);
  }

  /** The character-by-character engine shared by humanTypeInto and humanCompose. */
  private async typeChars(field: Locator, text: string, cpsMin: number, cpsMax: number): Promise<void> {
    for (const char of text) {
      if (/[a-z]/i.test(char) && Math.random() < 0.04) {
        const typo = neighborKey(char);
        await field.press(typo === " " ? "Space" : typo, { delay: 1000 / randomFloat(cpsMin, cpsMax) });
        await this.pause(120, 360);
        await field.press("Backspace", { delay: randomInt(60, 160) });
        await this.pause(80, 220);
      }
      await field.type(char, { delay: 1000 / randomFloat(cpsMin, cpsMax) });
      if ([".", "?", "!"].includes(char) && Math.random() < 0.55) {
        await this.pause(400, 1300);
      }
    }
  }

  /**
   * Compose a comment the way a person writes one: not in a single uninterrupted
   * stream, but sentence by sentence, pausing to think between thoughts,
   * occasionally scrolling back up to re-read the post, and now and then making a
   * false start — typing a few characters, reconsidering, deleting them, and
   * carrying on. The finished text is identical to `text`; only the *process* of
   * arriving at it is humanized. Used for the comment body specifically.
   */
  async humanCompose(selector: string, text: string, cpsMin = 3, cpsMax = 6): Promise<void> {
    const field = this.page.locator(selector).first();
    await this.humanClick(field);
    // A moment to gather the thought before the first word.
    await this.pause(700, 1800);

    const segments = splitIntoSentences(text);
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index]!;

      // Occasional false start: begin the thought, reconsider, backspace, rewrite.
      if (segment.trim().length > 8 && Math.random() < 0.12) {
        const k = randomInt(3, Math.min(7, segment.length));
        await this.typeChars(field, segment.slice(0, k), cpsMin, cpsMax);
        await this.pause(500, 1300);
        for (let b = 0; b < k; b += 1) {
          await field.press("Backspace", { delay: randomInt(70, 190) });
        }
        await this.pause(300, 900);
      }

      await this.typeChars(field, segment, cpsMin, cpsMax);

      if (index < segments.length - 1) {
        // A beat to think before the next sentence.
        await this.pause(700, 2200);
        // Sometimes glance back up at the post being replied to, then return.
        if (Math.random() < 0.3) {
          await this.page.mouse.wheel(0, -randomInt(220, 520));
          await this.pause(1200, 3000);
          await this.idleDrift();
          await this.page.mouse.wheel(0, randomInt(220, 520));
          await this.pause(700, 1600);
        }
      }
    }
  }

  /**
   * Click a locator the way a person does: scroll it into view, move the cursor
   * to a point inside it (biased to centre, occasionally off-centre) along a
   * human path, hover briefly, then press. The hover-dwell and the centre bias
   * are both things real pointer users do and naive bots skip.
   */
  async humanClick(locator: Locator): Promise<void> {
    await locator.scrollIntoViewIfNeeded().catch(() => undefined);
    const box = await locator.boundingBox();
    if (!box) {
      await locator.click();
      return;
    }
    const target: Point = {
      x: box.x + box.width * gaussianFraction(0.5, 0.16, 0.15, 0.85),
      y: box.y + box.height * gaussianFraction(0.5, 0.16, 0.2, 0.8),
    };
    await this.humanMove(target);
    // Settle on the target before pressing — a person's hand pauses, sometimes
    // nudging a pixel or two, in the moment between arriving and clicking.
    await this.pause(220, 600);
    if (Math.random() < 0.35) {
      await this.page.mouse.move(target.x + randomFloat(-2, 2), target.y + randomFloat(-2, 2));
      await this.pause(120, 320);
    }
    await this.page.mouse.down();
    await delay(randomInt(60, 150));
    await this.page.mouse.up();
  }

  /**
   * Move the cursor to a target like a person does. Uses ghost-cursor's path
   * generator (Fitts's-law timing, variable curvature) so no two moves share the
   * same velocity signature, and adds an explicit overshoot-then-correct on
   * longer moves — the hallmark of a real hand that throws the cursor at a target
   * and reels it back. Falls back to a cubic bezier if path generation fails.
   */
  async humanMove(target: Point): Promise<void> {
    const start = this.cursor;
    const distance = Math.hypot(target.x - start.x, target.y - start.y);

    // On longer throws, a real hand usually overshoots slightly then corrects.
    if (distance > 130 && Math.random() < 0.55) {
      const reach = Math.min(45, distance * 0.12);
      const overshoot: Point = {
        x: target.x + randomFloat(-reach, reach),
        y: target.y + randomFloat(-reach, reach),
      };
      await this.tracePath(start, overshoot);
      await delay(randomInt(40, 130));
      await this.tracePath(overshoot, target);
    } else {
      await this.tracePath(start, target);
    }
    this.cursor = target;
  }

  /** Drive the mouse from one point to another along a human-shaped path. */
  private async tracePath(from: Point, to: Point): Promise<void> {
    let points: Point[];
    try {
      points = ghostPath(from, to) as Point[];
    } catch {
      points = bezierFallback(from, to);
    }
    if (!points || points.length < 2) {
      points = bezierFallback(from, to);
    }
    const total = points.length;
    for (let i = 0; i < total; i += 1) {
      const p = points[i]!;
      // Micro-tremor: a real hand jitters a fraction of a pixel as it moves.
      const jitterX = Math.random() < 0.25 ? randomFloat(-1.1, 1.1) : 0;
      const jitterY = Math.random() < 0.25 ? randomFloat(-1.1, 1.1) : 0;
      await this.page.mouse.move(p.x + jitterX, p.y + jitterY);
      // Slower, more deliberate travel than a snap-to-target bot move.
      await delay(randomInt(9, 24));
      // Occasional mid-flight hesitation, as if the eye re-checked the target.
      if (i > total * 0.2 && i < total * 0.8 && Math.random() < 0.06) {
        await delay(randomInt(90, 260));
      }
    }
  }

  /**
   * A small, idle wander of the cursor — the kind of motion a hand resting on a
   * mouse makes while the eyes read. Called during scrolling and dwelling so the
   * pointer is never frozen for seconds at a time (a strong automation tell).
   */
  async idleDrift(): Promise<void> {
    if (Math.random() > 0.5) {
      return;
    }
    const target: Point = {
      x: clampNum(this.cursor.x + randomFloat(-55, 55), 5, 1435),
      y: clampNum(this.cursor.y + randomFloat(-40, 40), 5, 895),
    };
    await this.tracePath(this.cursor, target);
    this.cursor = target;
  }

  /** Occasionally take a longer break, like a person glancing away. */
  async maybeMicroBreak(probability = 0.2): Promise<void> {
    if (Math.random() < probability) {
      await this.pause(3000, 12_000);
    }
  }

  /** A deliberate "thinking"/reading pause callers can insert between steps. */
  async think(minMs = 1500, maxMs = 4000): Promise<void> {
    await this.pause(minMs, maxMs);
  }

  /**
   * Simulate the user switching to another tab/app for a bit: fire the same
   * blur + visibilitychange events the browser does, stay "hidden" for a real
   * pause, then come back. A session that holds a single tab in continuous
   * focus for hours — never once looking away — is not how people browse, and
   * visibility/focus is exactly what page-side bot heuristics watch. All of it
   * is best-effort; any failure is swallowed so it can never abort a session.
   */
  async simulateAwayBreak(minMs = 8000, maxMs = 45_000): Promise<void> {
    const setHidden = (hidden: boolean): Promise<void> =>
      this.page
        .evaluate((isHidden) => {
          try {
            Object.defineProperty(document, "visibilityState", {
              value: isHidden ? "hidden" : "visible",
              configurable: true,
            });
            Object.defineProperty(document, "hidden", { value: isHidden, configurable: true });
            document.dispatchEvent(new Event("visibilitychange"));
            window.dispatchEvent(new Event(isHidden ? "blur" : "focus"));
          } catch {
            /* ignore — page may have navigated */
          }
        }, hidden)
        .catch(() => undefined);

    await setHidden(true);
    await this.pause(minMs, maxMs);
    await setHidden(false);
    await this.pause(400, 1200);
  }

  private async pause(minMs: number, maxMs: number): Promise<void> {
    await delay(randomInt(minMs, maxMs));
  }
}

/**
 * Cubic-bezier path as an array of points — the fallback used when ghost-cursor's
 * generator is unavailable, so {@link RedditBrowser.tracePath} always has a path
 * to drive even if the dependency misbehaves.
 */
function bezierFallback(start: Point, target: Point): Point[] {
  const dx = target.x - start.x;
  const dy = target.y - start.y;
  const control1: Point = {
    x: start.x + dx * 0.3 + randomFloat(-60, 60),
    y: start.y + dy * 0.3 + randomFloat(-60, 60),
  };
  const control2: Point = {
    x: start.x + dx * 0.7 + randomFloat(-60, 60),
    y: start.y + dy * 0.7 + randomFloat(-60, 60),
  };
  const steps = randomInt(18, 34);
  const points: Point[] = [];
  for (let i = 1; i <= steps; i += 1) {
    const t = easeInOut(i / steps);
    points.push(cubicBezier(start, control1, control2, target, t));
  }
  return points;
}

function cubicBezier(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/**
 * Split text into sentence-sized segments, keeping the punctuation and any
 * trailing whitespace/newlines with each segment so that re-joining the
 * segments reproduces the original text exactly (byte for byte). Used by
 * humanCompose to type a comment thought by thought.
 */
function splitIntoSentences(text: string): string[] {
  const matches = text.match(/[^.!?\n]*(?:[.!?]+|\n+|$)/g);
  const segments = (matches ?? [text]).filter((segment) => segment.length > 0);
  return segments.length > 0 ? segments : [text];
}

/**
 * A fraction in [min,max] biased toward `mean` with roughly normal spread
 * (average of two uniforms ≈ triangular/normal). Used to pick a click point
 * inside an element that clusters near the centre but isn't pixel-identical.
 */
function gaussianFraction(mean: number, sd: number, min: number, max: number): number {
  const gauss = (Math.random() + Math.random()) / 2; // ~centred on 0.5
  const value = mean + (gauss - 0.5) * 2 * sd * 1.7;
  return clampNum(value, min, max);
}

function clampNum(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

const KEY_NEIGHBORS: Record<string, string> = {
  a: "s", s: "d", d: "f", f: "g", g: "h", h: "j", j: "k", k: "l", l: "k",
  q: "w", w: "e", e: "r", r: "t", t: "y", y: "u", u: "i", i: "o", o: "p", p: "o",
  z: "x", x: "c", c: "v", v: "b", b: "n", n: "m", m: "n",
};

function neighborKey(char: string): string {
  const lower = char.toLowerCase();
  const neighbor = KEY_NEIGHBORS[lower] ?? "e";
  return char === lower ? neighbor : neighbor.toUpperCase();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomFloat(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}
