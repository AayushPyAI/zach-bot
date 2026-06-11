import { AppConfig } from "./config.js";
import { logger } from "./logger.js";
import { RedditBrowser } from "./reddit-browser.js";

export interface PostResult {
  success: boolean;
  url?: string;
  postId?: string;
}

/**
 * Submit an original text post to a subreddit via the old Reddit form.
 * The old UI is more stable to automate than new shreddit — same selectors
 * have worked for years and the form doesn't rely on client-side routing.
 */
export async function publishPost(
  browser: RedditBrowser,
  config: AppConfig,
  subreddit: string,
  title: string,
  body: string,
): Promise<PostResult> {
  // ?selftext=1 pre-selects the "text" tab so we don't have to click it.
  const submitUrl = `https://old.reddit.com/r/${subreddit}/submit?selftext=1`;
  await browser.idleBrowse(submitUrl);

  // If the page shows a login prompt or subreddit-not-found, bail early.
  const html = await browser.safePageHtml();
  if (html.includes("you must be 18") || html.includes("page not found") || html.includes("subreddit doesn't exist")) {
    logger.warn({ subreddit }, "Submit page blocked or subreddit invalid");
    return { success: false };
  }

  const titleInput = browser.page.locator("#title").first();
  if ((await titleInput.count()) === 0) {
    logger.warn({ subreddit }, "Post submit: title input not found on old Reddit form");
    return { success: false };
  }

  // Human-like: click title field and type
  await browser.humanType(
    "#title",
    title,
    config.posting.typingCharsPerSecondMin,
    config.posting.typingCharsPerSecondMax,
  );

  // Pause as if re-reading the title
  await sleep(700 + Math.random() * 1100);

  // Locate body textarea — old Reddit uses a CodeMirror-backed textarea
  const bodySelectors = [
    ".usertext-edit textarea",
    "textarea#text",
    "textarea[name='text']",
  ];

  let bodySelector: string | null = null;
  for (const sel of bodySelectors) {
    if ((await browser.page.locator(sel).first().count()) > 0) {
      bodySelector = sel;
      break;
    }
  }

  if (!bodySelector) {
    logger.warn({ subreddit }, "Post submit: body textarea not found");
    return { success: false };
  }

  // Longer pause before body — simulate composing thoughts
  await sleep(1800 + Math.random() * 2200);

  // Type slightly slower than comments (it's a longer, more deliberate text)
  await browser.humanType(
    bodySelector,
    body,
    Math.max(1.5, config.posting.typingCharsPerSecondMin * 0.75),
    Math.max(3, config.posting.typingCharsPerSecondMax * 0.75),
  );

  // Pause to "re-read" the post before submitting
  await sleep(2500 + Math.random() * 3500);

  // Find the submit button (old Reddit has a few possible selectors)
  const submitSelectors = [
    "#submit-text",
    "button.save[type='submit']",
    ".submit-page button[type='submit']",
    "input[type='submit'][value='submit']",
  ];

  let submitted = false;
  for (const sel of submitSelectors) {
    const btn = browser.page.locator(sel).first();
    if ((await btn.count()) > 0 && await btn.isVisible()) {
      await browser.humanClick(btn);
      submitted = true;
      break;
    }
  }

  if (!submitted) {
    logger.warn({ subreddit }, "Post submit: submit button not found");
    return { success: false };
  }

  return confirmPostCreated(browser);
}

async function confirmPostCreated(browser: RedditBrowser): Promise<PostResult> {
  const deadline = Date.now() + 35_000;

  while (Date.now() < deadline) {
    const url = browser.page.url();
    // After a successful text post, Reddit redirects to:
    // old.reddit.com/r/{sub}/comments/{id}/... OR www.reddit.com/r/{sub}/comments/{id}/...
    const match = url.match(/\/r\/[^/]+\/comments\/([a-z0-9]+)\//i);
    if (match) {
      const canonical = url
        .replace("old.reddit.com", "www.reddit.com")
        .replace(/\?.*$/, "");
      return { success: true, url: canonical, postId: match[1] };
    }

    // Check for error message on the page (rate-limit, banned sub, etc.)
    const html = await browser.safePageHtml().catch(() => "");
    if (html.includes("you are doing that too much") || html.includes("banned") || html.includes("error uploading")) {
      logger.warn("Post submit: Reddit returned an error response");
      return { success: false };
    }

    await sleep(1500);
  }

  return { success: false };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
