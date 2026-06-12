import { AppConfig } from "./config.js";
import { logger } from "./logger.js";
import { RedditBrowser } from "./reddit-browser.js";

export interface PostResult {
  success: boolean;
  url?: string;
  postId?: string;
}

interface MeJson {
  data?: { modhash?: string };
}

interface SubmitResponse {
  json?: {
    errors?: unknown[];
    data?: { url?: string; id?: string };
  };
}

/**
 * Submit an original text post via the Reddit JSON API.
 * Uses the authenticated browser session (cookies included) so the post is
 * attributed to the logged-in account without any UI selector fragility.
 */
export async function publishPost(
  browser: RedditBrowser,
  _config: AppConfig,
  subreddit: string,
  title: string,
  body: string,
): Promise<PostResult> {
  // Fetch modhash (CSRF token) from the authenticated session.
  const meJson = await browser.page.evaluate(async () => {
    const res = await fetch("https://www.reddit.com/api/me.json", { credentials: "include" });
    if (!res.ok) return null;
    return res.json();
  }) as MeJson | null;

  const modhash = meJson?.data?.modhash;
  if (!modhash) {
    logger.warn({ subreddit }, "Post submit: could not get modhash — likely not logged in");
    return { success: false };
  }

  // Brief human-like pause before submitting.
  await sleep(1500 + Math.random() * 2000);

  const result = await browser.page.evaluate(async ({ sr, t, text, uh }) => {
    const body = new URLSearchParams({
      api_type: "json",
      kind: "self",
      sr,
      title: t,
      text,
      uh,
      resubmit: "true",
    });
    const res = await fetch("https://www.reddit.com/api/submit", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) return null;
    return res.json();
  }, { sr: subreddit, t: title, text: body, uh: modhash }) as SubmitResponse | null;

  const errors = result?.json?.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    logger.warn({ subreddit, errors }, "Post submit: API returned errors");
    return { success: false };
  }

  const url = result?.json?.data?.url;
  const postId = result?.json?.data?.id;

  if (!url) {
    logger.warn({ subreddit, result }, "Post submit: API returned no URL");
    return { success: false };
  }

  const canonical = url.replace("old.reddit.com", "www.reddit.com").replace(/\?.*$/, "");
  return { success: true, url: canonical, postId };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
