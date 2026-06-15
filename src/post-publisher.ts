import { AppConfig } from "./config.js";
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

  // Click the submit button that belongs to the text-post form specifically.
  // Old Reddit renders two .save buttons (link + text).
  // Using :has() to target only the form containing textarea[name='text'].
  // humanClick generates real mouse events (move + down + up) which pass
  // Reddit's bot-detection unlike btn.click() via evaluate().
  const textFormBtn = browser.page
    .locator('form:has(textarea[name="text"]) button.save[type="submit"], form:has(textarea[name="text"]) button[type="submit"]')
    .first();

  if ((await textFormBtn.count()) === 0) {
    logger.warn({ subreddit }, "Post submit: could not find submit button in text form");
    return { success: false };
  }

  await browser.humanClick(textFormBtn);

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
