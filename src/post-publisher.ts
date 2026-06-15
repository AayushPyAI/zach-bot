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
 */
export async function publishPost(
  browser: RedditBrowser,
  config: AppConfig,
  subreddit: string,
  title: string,
  body: string,
): Promise<PostResult> {
  const submitUrl = `https://old.reddit.com/r/${subreddit}/submit?selftext=true`;
  await browser.page.goto(submitUrl, { waitUntil: "domcontentloaded" });
  await sleep(1500 + Math.random() * 1500);

  const titleSel = "#title, input[name='title']";
  const bodySel = "#text, textarea[name='text']";
  const btnSel = "form#submit-text button.save[type='submit'], form#submit-link button.save[type='submit']";

  if ((await browser.page.locator(titleSel).first().count()) === 0) {
    logger.warn({ subreddit }, "Post submit: title field not found — restricted subreddit or session expired");
    return { success: false };
  }

  await browser.humanType(titleSel, title, config.posting.typingCharsPerSecondMin, config.posting.typingCharsPerSecondMax);
  await sleep(600 + Math.random() * 600);

  if ((await browser.page.locator(bodySel).first().count()) === 0) {
    logger.warn({ subreddit }, "Post submit: body field not found");
    return { success: false };
  }

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

  logger.warn({ subreddit, url: currentUrl }, "Post submit: page did not navigate to new post");
  return { success: false };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
