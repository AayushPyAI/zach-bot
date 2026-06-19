import { AppConfig } from "./config.js";
import { logger } from "./logger.js";
import { RedditBrowser } from "./reddit-browser.js";
import { RedditPost } from "./types.js";

export async function publishComment(
  browser: RedditBrowser,
  config: AppConfig,
  post: RedditPost,
  text: string,
): Promise<boolean> {
  if (config.posting.useOldReddit) {
    return publishOldReddit(browser, config, post, text);
  }

  const newResult = await publishNewReddit(browser, config, post, text);
  if (newResult || !config.posting.fallbackToOldReddit) {
    return newResult;
  }

  logger.warn("New Reddit submit path failed, retrying on old Reddit");
  return publishOldReddit(browser, config, post, text);
}

async function publishOldReddit(
  browser: RedditBrowser,
  config: AppConfig,
  post: RedditPost,
  text: string,
): Promise<boolean> {
  const url = post.url.replace("https://www.reddit.com", "https://old.reddit.com");
  await browser.idleBrowse(url);
  // Read the thread a little before reacting to it — upvote comes after reading,
  // the way a person decides a post is worth their vote and their reply.
  await browser.humanScroll(2);
  await browser.tryUpvote(config.humanize.upvoteProbability);
  // Read the existing discussion (and maybe upvote a comment) before replying.
  await browser.browseComments(config.humanize.upvoteProbability);

  const selector = ".commentarea form.usertext textarea[name='text']";
  const box = browser.page.locator(selector).first();
  if ((await box.count()) === 0) {
    return false;
  }

  await browser.humanCompose(selector, text, config.posting.typingCharsPerSecondMin, config.posting.typingCharsPerSecondMax);
  const submit = browser.page.locator(".commentarea form.usertext button.save, .commentarea form.usertext button[type='submit']").first();
  if ((await submit.count()) === 0) {
    return false;
  }
  await browser.humanClick(submit);
  return confirmPosted(browser, text);
}

async function publishNewReddit(
  browser: RedditBrowser,
  config: AppConfig,
  post: RedditPost,
  text: string,
): Promise<boolean> {
  await browser.idleBrowse(post.url);
  // Read the thread a little before reacting — upvote after reading, then reply.
  await browser.humanScroll(2);
  await browser.tryUpvote(config.humanize.upvoteProbability);
  // Read the existing discussion (and maybe upvote a comment) before replying.
  await browser.browseComments(config.humanize.upvoteProbability);

  const selector = [
    'textarea[placeholder*="comment" i]',
    'textarea[aria-label*="comment" i]',
    'div[contenteditable="true"][role="textbox"]',
  ];

  let inputSelector: string | null = null;
  for (const candidate of selector) {
    const locator = browser.page.locator(candidate).first();
    if ((await locator.count()) > 0 && await locator.isVisible()) {
      inputSelector = candidate;
      break;
    }
  }

  if (!inputSelector) {
    return false;
  }

  await browser.humanCompose(inputSelector, text, config.posting.typingCharsPerSecondMin, config.posting.typingCharsPerSecondMax);
  const submit = browser.page.locator("button:has-text('Comment'), button:has-text('Reply')").first();
  if ((await submit.count()) === 0) {
    return false;
  }
  await browser.humanClick(submit);
  return confirmPosted(browser, text);
}

async function confirmPosted(browser: RedditBrowser, text: string): Promise<boolean> {
  const snippet = text.slice(0, 60).trim();
  const deadline = Date.now() + 45_000;

  while (Date.now() < deadline) {
    const pageText = await browser.safePageHtml();
    if (snippet && pageText.includes(snippet)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  return false;
}
