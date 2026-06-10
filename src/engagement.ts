import { AppConfig } from "./config.js";
import { StateDb } from "./db.js";
import { logger } from "./logger.js";
import { RedditBrowser } from "./reddit-browser.js";

/**
 * Re-visit a few recently posted comments and check whether they're still live.
 * If our comment's text is gone from the thread, Reddit (or a mod/automod) has
 * removed it — recorded so the removal-throttle can back the bot off. This is
 * the feedback loop that turns "comments getting removed" into an automatic
 * safety response instead of silent failure.
 */
export async function recheckComments(
  browser: RedditBrowser,
  db: StateDb,
  config: AppConfig,
): Promise<void> {
  if (!config.recheck.enabled || config.recheck.maxPerRun <= 0) {
    return;
  }
  const due = db.commentsToRecheck(config.recheck.withinDays, config.recheck.maxPerRun);
  if (due.length === 0) {
    return;
  }
  logger.info({ count: due.length }, "Re-checking recently posted comments for removals");

  for (const comment of due) {
    try {
      await browser.idleBrowse(comment.url);
      // Let the comment tree load before reading the page text.
      await browser.humanScroll(2);
      const html = await browser.safePageHtml();
      const snippet = comment.draft.slice(0, 60).trim();
      const present = snippet.length > 0 && html.includes(snippet);
      db.markCommentChecked(comment.id, !present, null);
      if (!present) {
        logger.warn({ postId: comment.id, url: comment.url }, "Posted comment appears REMOVED");
      } else {
        logger.debug({ postId: comment.id }, "Posted comment still live");
      }
    } catch (error) {
      logger.warn({ postId: comment.id, error: String(error) }, "Comment re-check failed; will retry next run");
    }
  }
}
