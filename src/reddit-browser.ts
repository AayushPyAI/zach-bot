import fs from "node:fs";

import { BrowserContext, Locator, Page, chromium } from "rebrowser-playwright";

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

  async lurkSubreddit(subreddit: string): Promise<void> {
    await this.page.goto(`https://www.reddit.com/r/${subreddit}/`, { waitUntil: "domcontentloaded" });
    await this.pause(1200, 2600);
    await this.humanScroll(randomInt(2, 5));
    await this.maybeMicroBreak();
  }

  async idleBrowse(url?: string): Promise<void> {
    if (url) {
      await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
      await this.pause(1000, 2000);
    }
    await this.humanScroll(randomInt(1, 3));
  }

  async humanScroll(times: number): Promise<void> {
    for (let index = 0; index < times; index += 1) {
      // Vary direction occasionally and step size, like a real reader.
      const direction = Math.random() < 0.15 ? -1 : 1;
      await this.page.mouse.wheel(0, direction * randomInt(220, 760));
      await this.pause(450, 1300);
    }
  }

  /** Dwell on a page for a time proportional to how much text there is to read. */
  async readDwell(text: string): Promise<void> {
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    const wpm = randomInt(200, 340);
    const baseMs = (words / wpm) * 60_000;
    const dwell = Math.max(1500, Math.min(28_000, Math.round(baseMs)));
    const chunks = Math.max(1, Math.round(dwell / 2500));
    for (let i = 0; i < chunks; i += 1) {
      await this.page.mouse.wheel(0, randomInt(180, 520));
      await this.pause(1200, 2600);
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
    for (const char of text) {
      if (/[a-z]/i.test(char) && Math.random() < 0.04) {
        const typo = neighborKey(char);
        await field.press(typo === " " ? "Space" : typo, { delay: 1000 / randomFloat(cpsMin, cpsMax) });
        await this.pause(120, 360);
        await field.press("Backspace", { delay: randomInt(60, 160) });
        await this.pause(80, 220);
      }
      await field.type(char, { delay: 1000 / randomFloat(cpsMin, cpsMax) });
      if ([".", "?", "!"].includes(char) && Math.random() < 0.5) {
        await this.pause(250, 900);
      }
    }
  }

  /**
   * Click a locator the way a person does: scroll it into view, move the cursor
   * to a random point inside it along a curved, eased path, then press.
   */
  async humanClick(locator: Locator): Promise<void> {
    await locator.scrollIntoViewIfNeeded().catch(() => undefined);
    const box = await locator.boundingBox();
    if (!box) {
      await locator.click();
      return;
    }
    const target: Point = {
      x: box.x + box.width * randomFloat(0.3, 0.7),
      y: box.y + box.height * randomFloat(0.35, 0.65),
    };
    await this.humanMove(target);
    await this.pause(80, 220);
    await this.page.mouse.down();
    await delay(randomInt(40, 110));
    await this.page.mouse.up();
  }

  /** Move the cursor along a cubic-bezier path with eased, jittered timing. */
  async humanMove(target: Point): Promise<void> {
    const start = this.cursor;
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
    for (let i = 1; i <= steps; i += 1) {
      const t = easeInOut(i / steps);
      const point = cubicBezier(start, control1, control2, target, t);
      await this.page.mouse.move(point.x, point.y);
      await delay(randomInt(6, 18));
    }
    this.cursor = target;
  }

  /** Occasionally take a longer break, like a person glancing away. */
  async maybeMicroBreak(probability = 0.2): Promise<void> {
    if (Math.random() < probability) {
      await this.pause(3000, 12_000);
    }
  }

  private async pause(minMs: number, maxMs: number): Promise<void> {
    await delay(randomInt(minMs, maxMs));
  }
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
