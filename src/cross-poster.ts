import OpenAI from "openai";
import { AppConfig } from "./config.js";
import { StateDb } from "./db.js";
import { logger } from "./logger.js";
import { RedditBrowser } from "./reddit-browser.js";
import { publishPost } from "./post-publisher.js";

// For each source subreddit, where it can be cross-posted
const CROSS_POST_MAP: Record<string, string[]> = {
  EstatePlanning:        ["personalfinance", "legaladvice", "financialplanning"],
  personalfinance:       ["financialplanning", "Bogleheads", "Money"],
  AgingParents:          ["CaregiverSupport", "eldercare", "GriefSupport"],
  retirement:            ["financialindependence", "Bogleheads", "retirees"],
  financialindependence: ["FIRE", "personalfinance", "Bogleheads"],
  legaladvice:           ["EstatePlanning", "personalfinance"],
  GriefSupport:          ["AgingParents", "widows", "widowers"],
  Parenting:             ["NewParents", "daddit", "mommit"],
  smallbusiness:         ["Entrepreneur", "selfemployed", "freelance"],
  ChronicIllness:        ["CancerSupport", "disability", "ChronicPain"],
  Veterans:              ["VeteransBenefits", "Military"],
  homeowners:            ["FirstTimeHomeBuyer", "Mortgages"],
  divorce:               ["legaladvice", "SingleParents"],
};

export class CrossPoster {
  private readonly config: AppConfig;
  private readonly openai: OpenAI;

  constructor(config: AppConfig, openaiApiKey: string) {
    this.config = config;
    this.openai = new OpenAI({ apiKey: openaiApiKey });
  }

  async maybeCrossPost(browser: RedditBrowser, db: StateDb): Promise<void> {
    const cp = this.config.crossPosting;
    if (!cp?.enabled) return;

    const minDelaySecs = cp.minDelayHours * 3600;
    const nowTs = Math.floor(Date.now() / 1000);

    const recentPosts = db.getRecentCreatedPosts(7);
    if (recentPosts.length === 0) return;

    for (const sourcePost of recentPosts) {
      // Enforce minimum delay since original post
      if (nowTs - sourcePost.created_ts < minDelaySecs) continue;

      const alreadyCrossPosted = db.getCrossPostedSubreddits(sourcePost.id);
      if (alreadyCrossPosted.length >= cp.maxCrossPostsPerOriginal) continue;

      const targets = CROSS_POST_MAP[sourcePost.subreddit] ?? [];
      const remaining = targets.filter(
        (t) => !alreadyCrossPosted.includes(t) && t !== sourcePost.subreddit,
      );
      if (remaining.length === 0) continue;

      const targetSub = remaining[Math.floor(Math.random() * remaining.length)]!;

      logger.info({ source: sourcePost.subreddit, target: targetSub, title: sourcePost.title }, "Cross-posting original post");

      const newTitle = await this.rewriteTitle(sourcePost.title, targetSub);
      if (!newTitle) {
        logger.warn({ target: targetSub }, "Title rewrite failed; skipping cross-post");
        continue;
      }

      const result = await publishPost(browser, this.config, targetSub, newTitle, sourcePost.body);

      db.saveCrossPost({
        sourcePostId: sourcePost.id,
        sourceSubreddit: sourcePost.subreddit,
        targetSubreddit: targetSub,
        title: newTitle,
        body: sourcePost.body,
        dryRun: !result.success,
        url: result.url,
        redditPostId: result.postId,
      });

      if (result.success) {
        logger.info({ target: targetSub, url: result.url, title: newTitle }, "Cross-post published live");
      } else {
        logger.warn({ target: targetSub, title: newTitle }, "Cross-post did not confirm; saved as draft");
      }

      // Only one cross-post per session
      return;
    }
  }

  private async rewriteTitle(originalTitle: string, targetSub: string): Promise<string | null> {
    try {
      const resp = await this.openai.chat.completions.create({
        model: this.config.ai.model,
        max_tokens: 80,
        messages: [
          {
            role: "user",
            content: `Rewrite this Reddit post title for r/${targetSub}: "${originalTitle}". Keep the core message but adapt the framing for the ${targetSub} community. Max 150 chars. Return only the new title, no quotes.`,
          },
        ],
      });
      const text = resp.choices[0]?.message?.content?.trim();
      return text && text.length > 10 ? text.slice(0, 200) : null;
    } catch (error) {
      logger.warn({ error: String(error) }, "OpenAI title rewrite failed");
      return null;
    }
  }
}
