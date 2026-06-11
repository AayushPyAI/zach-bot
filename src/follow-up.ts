import { AppConfig } from "./config.js";
import { StateDb } from "./db.js";
import { logger } from "./logger.js";
import { OpenAiAnalyzer } from "./openai-analyzer.js";
import { ProductKnowledge } from "./products.js";
import { RedditBrowser } from "./reddit-browser.js";
import { publishComment } from "./comment-publisher.js";

export async function scheduleFollowUp(
  db: StateDb,
  postId: string,
  url: string,
  subreddit: string,
): Promise<void> {
  db.scheduleFollowUp(postId, url, subreddit, Math.floor(Date.now() / 1000));
}

export async function processFollowUps(
  browser: RedditBrowser,
  db: StateDb,
  config: AppConfig,
  analyzer: OpenAiAnalyzer,
  knowledge: ProductKnowledge,
): Promise<void> {
  const nowTs = Math.floor(Date.now() / 1000);
  const due = db.getDueFollowUps(nowTs, 3);

  if (due.length === 0) return;
  logger.info({ count: due.length }, "Processing thread follow-ups");

  for (const item of due) {
    try {
      await browser.idleBrowse(item.url);
      await browser.page.waitForLoadState("domcontentloaded").catch(() => {});
      await sleep(1500);

      // Read the page HTML to detect OP engagement
      const html = await browser.safePageHtml().catch(() => "");

      // Heuristic: check if the thread has meaningful comment activity beyond OP's post
      const hasActivity = html.includes("class=\"comment\"") || html.includes("data-type=\"comment\"");
      const whichCheck = item.check_48h ? "48h" : "7d";

      if (hasActivity && config.posting.enabled) {
        // Extract a snippet of the thread body to generate contextual follow-up
        const threadText = html
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .slice(0, 800);

        const followUpPrompt = `This is a Reddit thread you previously commented on. Here's the current thread state:\n\n${threadText}\n\nWrite a brief, helpful 1-2 sentence follow-up comment that adds additional value or answers a likely follow-up question about estate planning. Sound natural and human. No URLs.`;

        const draft = await generateFollowUpDraft(analyzer, followUpPrompt, config);
        if (draft) {
          // Build a minimal post object for publishComment
          const fakePost = {
            id: item.post_id,
            url: item.url,
            subreddit: item.subreddit,
            title: "",
            body: threadText,
            author: "",
            permalink: item.url.replace("https://www.reddit.com", ""),
            createdUtc: 0,
            commentCount: 0,
            upvotes: 0,
            over18: false,
            locked: false,
            archived: false,
            isSelf: true,
          };
          const success = await publishComment(browser, config, fakePost, draft);
          if (success) {
            logger.info({ postId: item.post_id, check: whichCheck }, "Follow-up comment posted");
          }
        }
      }

      db.markFollowUpChecked(item.id, item.check_48h ? "48h" : "7d");
      await sleep(3000);
    } catch (error) {
      logger.warn({ postId: item.post_id, error: String(error) }, "Follow-up processing error, marking checked");
      db.markFollowUpChecked(item.id, item.check_48h ? "48h" : "7d");
    }
  }
}

async function generateFollowUpDraft(
  analyzer: OpenAiAnalyzer,
  prompt: string,
  config: AppConfig,
): Promise<string | null> {
  try {
    // Use OpenAI directly via the analyzer's internal client
    const raw = await (analyzer as unknown as { _rawComplete(prompt: string): Promise<string> })._rawComplete(prompt).catch(() => null);
    if (!raw) return null;
    const trimmed = raw.trim().slice(0, config.ai.maxCommentChars);
    return trimmed.length >= config.ai.minCommentChars ? trimmed : null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
