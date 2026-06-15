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
  const btnSel   = "button.save[type='submit']";

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

  const submitBtn = browser.page.locator(btnSel).first();
  if ((await submitBtn.count()) === 0) {
    logger.warn({ subreddit }, "Post submit: submit button not found");
    return { success: false };
  }

  await browser.humanClick(submitBtn);
  await sleep(4000 + Math.random() * 2000);

  const currentUrl = browser.page.url();
  if (currentUrl.match(/\/r\/[^/]+\/comments\//i)) {
    const canonical = currentUrl.replace("old.reddit.com", "www.reddit.com").replace(/\?.*$/, "");
    const match = canonical.match(/comments\/([a-z0-9]+)/i);
    return { success: true, url: canonical, postId: match?.[1] };
  }

  logger.warn({ subreddit, url: currentUrl }, "Post submit: page did not navigate to new post URL");
  return { success: false };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
