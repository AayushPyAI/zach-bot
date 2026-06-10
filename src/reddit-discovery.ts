import { AppConfig } from "./config.js";
import { logger } from "./logger.js";
import { evaluateStructural } from "./policy.js";
import { RedditBrowser } from "./reddit-browser.js";
import { RedditPost } from "./types.js";

interface FeedStub {
  id: string;
  permalink: string;
  title: string;
  author: string;
  score: number;
  commentCount: number;
  createdTimestamp: string;
  postType: string;
  nsfw: boolean;
  locked: boolean;
}

/**
 * Discover candidate posts by browsing the rendered subreddit feed like a
 * person — navigate, scroll to load cards, and read post metadata straight off
 * the `shreddit-post` elements. No `.json` API call, which a logged-in human
 * session would never make. Bodies are not available in the feed, so only the
 * structural pre-filter runs here; content filtering happens after the post is
 * actually opened (see {@link readPostBody}).
 */
export async function discoverPosts(
  browser: RedditBrowser,
  config: AppConfig,
  subreddit: string,
  sort: "new" | "hot" | "rising",
): Promise<RedditPost[]> {
  await browser.idleBrowse(`https://www.reddit.com/r/${subreddit}/${sort}/`);

  // Scroll until enough cards are present (or we stop making progress).
  let stubs: FeedStub[] = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    stubs = await scrapeFeed(browser);
    if (stubs.length >= config.discovery.postsPerSubreddit) {
      break;
    }
    await browser.humanScroll(2);
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const posts = stubs
    .slice(0, config.discovery.postsPerSubreddit)
    .map((stub) => stubToPost(subreddit, stub, nowSeconds))
    .filter((post): post is RedditPost => post !== null)
    .filter((post) => evaluateStructural(post, config.discovery, nowSeconds).ok);

  logger.info({ subreddit, sort, scraped: stubs.length, eligible: posts.length }, "Discovery finished");
  return posts;
}

// Passed to page.evaluate as a STRING on purpose: tsx/esbuild rewrites inline
// functions with a `__name` helper that doesn't exist in the page, so a
// function literal would throw "__name is not defined". A source string is
// evaluated verbatim in the browser and sidesteps that.
const SCRAPE_FEED_JS = `(() => {
  const stubs = [];
  const seen = new Set();
  document.querySelectorAll('shreddit-post').forEach((el) => {
    const attr = (name) => el.getAttribute(name) || '';
    const id = attr('id').replace(/^t3_/, '');
    if (!id || seen.has(id)) return;
    seen.add(id);
    stubs.push({
      id: id,
      permalink: attr('permalink'),
      title: attr('post-title'),
      author: attr('author'),
      score: Number(attr('score') || 0),
      commentCount: Number(attr('comment-count') || 0),
      createdTimestamp: attr('created-timestamp'),
      postType: attr('post-type'),
      nsfw: el.hasAttribute('nsfw'),
      locked: el.hasAttribute('locked'),
    });
  });
  return stubs;
})()`;

const READ_BODY_JS = `(() => {
  const selectors = [
    'shreddit-post [slot="text-body"]',
    '[property="schema:articleBody"]',
    'shreddit-post .md',
    'div[data-post-click-location="text-body"]',
  ];
  let best = '';
  for (const selector of selectors) {
    document.querySelectorAll(selector).forEach((node) => {
      const text = (node.textContent || '').trim();
      if (text.length > best.length) best = text;
    });
  }
  return best;
})()`;

async function scrapeFeed(browser: RedditBrowser): Promise<FeedStub[]> {
  return (await browser.page.evaluate(SCRAPE_FEED_JS)) as FeedStub[];
}

/**
 * Read a post's body text from the currently-open post page. Returns "" if no
 * self-text is present. The caller is expected to have navigated to the post.
 */
export async function readPostBody(browser: RedditBrowser): Promise<string> {
  return (await browser.page.evaluate(READ_BODY_JS)) as string;
}

function stubToPost(subreddit: string, stub: FeedStub, nowSeconds: number): RedditPost | null {
  if (!stub.id || !stub.permalink) {
    return null;
  }
  const parsed = Date.parse(stub.createdTimestamp);
  // If the timestamp is missing/unparseable, assume ~1h old so the age window
  // doesn't silently drop the post; the structural filter still applies.
  const createdUtc = Number.isNaN(parsed) ? nowSeconds - 3600 : Math.floor(parsed / 1000);

  return {
    id: stub.id,
    subreddit,
    title: stub.title.trim(),
    body: "",
    author: stub.author,
    url: `https://www.reddit.com${stub.permalink}`,
    permalink: stub.permalink,
    createdUtc,
    commentCount: stub.commentCount,
    upvotes: stub.score,
    over18: stub.nsfw,
    locked: stub.locked,
    archived: false,
    isSelf: stub.postType === "text",
  };
}
