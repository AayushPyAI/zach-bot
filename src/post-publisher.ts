import { AppConfig } from "./config.js";
import { solveRecaptchaV2 } from "./captcha-solver.js";
import { logger } from "./logger.js";
import { RedditBrowser } from "./reddit-browser.js";

export interface PostResult {
  success: boolean;
  url?: string;
  postId?: string;
}

/**
 * Submit an original text post via old Reddit's browser form.
 * Uses the same UI approach as comment-publisher so it works even when
 * Reddit's JSON API blocks requests from datacenter IPs.
 *
 * Old Reddit form fields (confirmed via live inspection):
 *   title → textarea[name='title']  (NOT an input, no #id)
 *   body  → textarea[name='text']
 *   submit→ button.save[type='submit']
 */
export async function publishPost(
  browser: RedditBrowser,
  config: AppConfig,
  subreddit: string,
  title: string,
  body: string,
): Promise<PostResult> {
  const submitUrl = `https://old.reddit.com/r/${subreddit}/submit?selftext=true`;
  await browser.page.goto(submitUrl, { waitUntil: "networkidle" });
  await sleep(2000 + Math.random() * 1500);

  const titleSel = "textarea[name='title']";
  const bodySel  = "textarea[name='text']";

  // Wait up to 10s for the form — some subreddits load rules overlays first
  try {
    await browser.page.waitForSelector(titleSel, { timeout: 10_000 });
  } catch {
    logger.warn({ subreddit }, "Post submit: title textarea not found — subreddit may be link-only or restricted");
    return { success: false };
  }

  if ((await browser.page.locator(bodySel).count()) === 0) {
    logger.warn({ subreddit }, "Post submit: body textarea not found — subreddit may not allow text posts");
    return { success: false };
  }

  await browser.humanType(titleSel, title, config.posting.typingCharsPerSecondMin, config.posting.typingCharsPerSecondMax);
  await sleep(600 + Math.random() * 600);

  await browser.humanType(bodySel, body, config.posting.typingCharsPerSecondMin, config.posting.typingCharsPerSecondMax);
  await sleep(1000 + Math.random() * 1000);

  // Handle reCAPTCHA if present (Reddit requires it for new/low-karma accounts).
  // Strategy 1 — residential proxy path: click the checkbox; on residential IPs
  // it auto-passes without an image challenge. Wait up to 6s for the token.
  // Strategy 2 — fallback: CapSolver API (CAPSOLVER_API_KEY env var).
  const captchaSiteKey = await browser.page.evaluate(() => {
    const el = document.querySelector<HTMLElement>("[data-sitekey]");
    return el?.dataset?.sitekey ?? null;
  });

  if (captchaSiteKey) {
    // Wait up to 15s for reCAPTCHA widget to fully render through proxy (proxy adds latency)
    logger.info({ subreddit }, "Post submit: reCAPTCHA detected, waiting for widget to render...");
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      const hasFrame = await browser.page.evaluate(
        () => !!document.querySelector("iframe[title='reCAPTCHA'], iframe[src*='recaptcha/api2/anchor']")
      );
      if (hasFrame) break;
    }

    // Click the checkbox inside the reCAPTCHA iframe
    try {
      const captchaFrame = browser.page.frameLocator(
        'iframe[title="reCAPTCHA"], iframe[title*="recaptcha"]'
      );
      const checkbox = captchaFrame.locator("#recaptcha-anchor");
      if ((await checkbox.count()) > 0) {
        await checkbox.click({ timeout: 8000 });
        logger.info({ subreddit }, "Post submit: reCAPTCHA checkbox clicked");
      }
    } catch {
      // Frame might not be accessible; fall through to token check
    }

    // Wait up to 8s for the residential IP to auto-pass the checkbox
    let captchaToken = "";
    for (let i = 0; i < 16; i++) {
      await sleep(500);
      captchaToken = await browser.page.evaluate(
        () => (document.querySelector<HTMLTextAreaElement>("#g-recaptcha-response")?.value ?? "")
      );
      if (captchaToken) break;
    }

    if (captchaToken) {
      logger.info({ subreddit }, "Post submit: reCAPTCHA passed (checkbox auto-passed via residential IP)");
    } else {
      // Checkbox triggered image challenge — fall back to CapSolver
      const captchaApiKey = process.env.CAPSOLVER_API_KEY?.trim();
      if (!captchaApiKey) {
        logger.warn({ subreddit }, "Post submit: reCAPTCHA image challenge appeared and CAPSOLVER_API_KEY not set — skipping post");
        return { success: false };
      }
      logger.info({ subreddit }, "Post submit: image challenge detected, solving via CapSolver...");
      const token = await solveRecaptchaV2(captchaApiKey, browser.page.url(), captchaSiteKey);
      if (!token) {
        logger.warn({ subreddit }, "Post submit: CapSolver failed to solve reCAPTCHA");
        return { success: false };
      }
      await browser.page.evaluate((t: string) => {
        const ta = document.querySelector<HTMLTextAreaElement>("#g-recaptcha-response");
        if (ta) {
          ta.value = t;
          ta.dispatchEvent(new Event("input", { bubbles: true }));
          ta.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }, token);
      await sleep(500);
      logger.info({ subreddit }, "Post submit: reCAPTCHA token injected via CapSolver");
    }
  }

  // Find the text-form's submit button via DOM traversal, then click via
  // page.mouse (real mouse events, no programmatic DOM click) while bypassing
  // Playwright's strict visibility gate (old Reddit's button passes bot checks
  // even when Playwright considers it "not visible").
  const btnCoords = await browser.page.evaluate(() => {
    const textArea = document.querySelector<HTMLElement>('textarea[name="text"]');
    const form = textArea?.closest<HTMLElement>("form");
    const btn = form?.querySelector<HTMLElement>('button.save[type="submit"], button[type="submit"]');
    if (!btn) return null;
    btn.scrollIntoView({ behavior: "instant", block: "center" });
    const r = btn.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null;
    return { x: r.left + r.width * 0.5, y: r.top + r.height * 0.5 };
  });

  if (!btnCoords) {
    logger.warn({ subreddit }, "Post submit: could not locate submit button coords in text form");
    return { success: false };
  }

  await sleep(400);
  // Move to button with slight randomisation then click — real mouse events
  await browser.page.mouse.move(
    btnCoords.x + (Math.random() - 0.5) * 4,
    btnCoords.y + (Math.random() - 0.5) * 4,
  );
  await sleep(80 + Math.random() * 120);
  await browser.page.mouse.down();
  await sleep(40 + Math.random() * 60);
  await browser.page.mouse.up();

  // Wait up to 10s for Reddit to navigate away from the submit page
  try {
    await browser.page.waitForURL(
      (url) => !url.toString().includes("/submit"),
      { timeout: 10_000 },
    );
  } catch {
    // Stayed on submit page — Reddit showed an inline error
  }
  await sleep(1000);

  const currentUrl = browser.page.url();
  logger.info({ subreddit, url: currentUrl }, "Post submit: checking redirect URL");

  if (currentUrl.match(/\/r\/[^/]+\/comments\//i)) {
    const canonical = currentUrl.replace("old.reddit.com", "www.reddit.com").replace(/\?.*$/, "");
    const match = canonical.match(/comments\/([a-z0-9]+)/i);
    return { success: true, url: canonical, postId: match?.[1] };
  }

  // Capture Reddit's error message so we can diagnose the failure
  const pageData = await browser.page.evaluate(() => {
    const errors = Array.from(
      document.querySelectorAll<HTMLElement>(".error, .status-msg, .field-error, .cError")
    )
      .map((el) => el.textContent?.trim())
      .filter(Boolean);
    const bodySnippet = document.body?.textContent?.replace(/\s+/g, " ").trim().slice(0, 600) ?? "";
    return { errors, bodySnippet };
  });

  logger.warn({ subreddit, url: currentUrl, redditErrors: pageData.errors, pageSnippet: pageData.bodySnippet.slice(0, 300) }, "Post submit: page after submission");

  const combined = (pageData.errors.join(" ") + " " + pageData.bodySnippet).toLowerCase();
  if (combined.includes("submitted") || combined.includes("your post") || combined.includes("being checked") || combined.includes("mod queue")) {
    logger.info({ subreddit }, "Post submit: post likely queued for mod approval");
    return { success: false };
  }

  logger.warn({ subreddit }, "Post submit: unexpected result — post not confirmed live");
  return { success: false };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
