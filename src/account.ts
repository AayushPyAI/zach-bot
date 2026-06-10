import { logger } from "./logger.js";
import { RedditBrowser } from "./reddit-browser.js";

export interface AccountStats {
  createdUtc: number;
  ageDays: number;
  commentKarma: number;
  linkKarma: number;
  totalKarma: number;
}

/**
 * Read the logged-in account's own age and karma. This is the account's own
 * `about.json` — exactly what the Reddit app loads about you — so it's not a bot
 * signal. Returns null on any failure, and callers stay in the safest mode.
 */
export async function fetchAccountStats(
  browser: RedditBrowser,
  username: string,
): Promise<AccountStats | null> {
  try {
    const response = await browser.page.request.get(
      `https://www.reddit.com/user/${username}/about.json`,
      { headers: { Accept: "application/json" } },
    );
    if (!response.ok()) {
      logger.warn({ status: response.status() }, "Account stats fetch failed");
      return null;
    }
    const data = ((await response.json()) as { data?: Record<string, unknown> }).data ?? {};
    const createdUtc = Number(data.created_utc ?? 0);
    const commentKarma = Number(data.comment_karma ?? 0);
    const linkKarma = Number(data.link_karma ?? 0);
    const totalKarma = Number(data.total_karma ?? commentKarma + linkKarma);
    const ageDays = createdUtc > 0 ? (Date.now() / 1000 - createdUtc) / 86_400 : 0;
    return { createdUtc, ageDays, commentKarma, linkKarma, totalKarma };
  } catch (error) {
    logger.warn({ error: String(error) }, "Account stats fetch errored");
    return null;
  }
}
