import path from "node:path";

import { fetchAccountStats } from "./account.js";
import { AppConfig, AudienceGroup } from "./config.js";
import { publishComment } from "./comment-publisher.js";
import { StateDb } from "./db.js";
import { recheckComments } from "./engagement.js";
import { logger } from "./logger.js";
import { OpenAiAnalyzer, PromotionLevel } from "./openai-analyzer.js";
import { loadProductKnowledge } from "./products.js";
import { selectStage } from "./ramp.js";
import {
  evaluateContent,
  evaluatePostingGate,
  evaluateRemovalThrottle,
  isSubredditCoolingDown,
  withinActiveHours,
} from "./policy.js";
import { RedditBrowser } from "./reddit-browser.js";
import { discoverPosts, readPostBody } from "./reddit-discovery.js";
import { AnalysisResult, RedditPost, StoredPost } from "./types.js";

export interface RunOptions {
  /** CLI override: true = force live, false = force draft-only, null = follow config/ramp. */
  forcePosting?: boolean | null;
}

export async function runWorkflow(config: AppConfig, opts: RunOptions = {}): Promise<void> {
  const db = new StateDb(path.resolve(config.runtime.databasePath));
  const analyzer = new OpenAiAnalyzer(config);
  const knowledge = loadProductKnowledge(config);
  const groupForSubreddit = (subreddit: string): AudienceGroup | undefined =>
    config.audiences.find((group) =>
      group.subreddits.some((s) => s.toLowerCase() === subreddit.toLowerCase()),
    );
  const browser = new RedditBrowser({
    ...config,
    browser: {
      ...config.browser,
      userDataDir: path.resolve(config.browser.userDataDir),
    },
  });

  // Effective config for this run. The account-maturity ramp may adjust posting
  // and humanize knobs below; we never mutate the shared base config (important
  // for the long-running daemon, which reuses it across sessions).
  const eff: AppConfig = structuredClone(config);
  const forcedDryRun = opts.forcePosting === false;
  eff.posting.enabled = forcedDryRun ? false : opts.forcePosting ?? config.posting.enabled;

  try {
    await browser.withSession(async () => {
      await browser.login();

      // Account-maturity ramp: read age + karma and auto-select the safe stage.
      if (config.ramp.enabled && !forcedDryRun) {
        const stats = await fetchAccountStats(browser, config.redditUsername);
        if (stats) {
          const stage = selectStage(config.ramp.stages, stats.ageDays, stats.totalKarma);
          eff.posting.enabled = stage.posting;
          eff.posting.dailyCap = stage.dailyCap;
          eff.posting.minGapMinutes = stage.minGapMinutes;
          eff.posting.maxGapMinutes = stage.maxGapMinutes;
          eff.humanize.lurkProbability = stage.lurkProbability;
          eff.humanize.upvoteProbability = stage.upvoteProbability;
          // Promotion stance follows account maturity (young = topical, no brand).
          eff.ai.promotionLevel = stage.promotionLevel;
          db.recordAccountSnapshot({ ...stats, stage: stage.name, posting: stage.posting, dailyCap: stage.dailyCap });
          logger.info(
            {
              ageDays: Math.round(stats.ageDays),
              totalKarma: stats.totalKarma,
              commentKarma: stats.commentKarma,
              stage: stage.name,
              posting: stage.posting,
              dailyCap: stage.dailyCap,
            },
            "Account ramp stage selected",
          );
          if (opts.forcePosting === true && !stage.posting) {
            logger.warn("--live requested but the account's ramp stage is draft-only; staying safe (set ramp.enabled:false to override)");
          }
        } else {
          eff.posting.enabled = false;
          logger.warn("Account stats unavailable; forcing safest draft-only mode this run");
        }
      }

      // Self-protection: re-check recent comments for removals, then back off to
      // draft-only if Reddit is removing too many (account too new/low-karma).
      await recheckComments(browser, db, eff);
      const removal = db.removalStats(eff.recheck.withinDays);
      const throttle = evaluateRemovalThrottle({
        checked: removal.checked,
        removed: removal.removed,
        minSample: eff.recheck.minSample,
        threshold: eff.recheck.removalRateThreshold,
      });
      if (eff.posting.enabled && throttle.throttle) {
        logger.warn({ ...removal, reason: throttle.reason }, "Removal throttle engaged — forcing draft-only this run");
        eff.posting.enabled = false;
      }

      // Posting-time gates (active hours, random skip) now that posting is resolved.
      if (eff.humanize.enabled && eff.posting.enabled) {
        if (!withinActiveHours(eff.humanize.activeHours, new Date().getHours())) {
          logger.info("Outside active hours; this session will read/draft but not post");
          eff.posting.enabled = false;
        } else if (Math.random() < eff.humanize.skipRunProbability) {
          logger.info("Random skip-run gate triggered; this session will read/draft but not post");
          eff.posting.enabled = false;
        }
      }

      await maybeLurk(browser, eff);

      const newPosts: RedditPost[] = [];
      // Build (subreddit, audience) targets. Prefer the audience groups; fall
      // back to the flat list with no audience context if none are configured.
      const targets: Array<{ subreddit: string; group?: AudienceGroup }> =
        eff.audiences.length > 0
          ? eff.audiences.flatMap((group) =>
              group.subreddits.map((subreddit) => ({ subreddit, group })),
            )
          : eff.subreddits.map((subreddit) => ({ subreddit }));
      if (eff.discovery.shuffleSubreddits) {
        targets.sort(() => Math.random() - 0.5);
      }

      for (const target of targets) {
        const sort = pickSort(eff);
        let discovered: RedditPost[] = [];
        try {
          discovered = await discoverPosts(browser, eff, target.subreddit, sort);
        } catch (error) {
          // One slow/unreachable subreddit must not abort the whole run.
          logger.warn({ subreddit: target.subreddit, error: String(error) }, "Discovery failed, skipping subreddit");
          continue;
        }
        for (const post of discovered) {
          post.audience = target.group?.label;
          const alreadySeen = db.hasSeen(post.id);
          db.saveDiscovered(post);
          if (!alreadySeen) {
            newPosts.push(post);
          }
        }
      }

      const pending = dedupePosts([
        ...db.listPendingAnalysis(eff.runtime.maxAnalyzePerRun),
        ...newPosts,
      ]).slice(0, eff.runtime.maxAnalyzePerRun);

      logger.info({ count: pending.length }, "Posts queued for analysis");
      if (pending.length === 0) {
        logger.info("Nothing new to analyze");
        return;
      }

      const scored: Array<{ post: RedditPost | StoredPost; analysis: AnalysisResult; draft: string }> = [];
      for (const post of pending) {
        try {
          // Open the post like a reader would, pull its body from the page, and
          // persist it. The body isn't known from the feed, so this is also where
          // the content filter (length + keywords) runs.
          await browser.idleBrowse(post.url);
          post.body = await readPostBody(browser);
          db.saveDiscovered(post);

          const postGroup = groupForSubreddit(post.subreddit);
          const keywords = postGroup?.keywords?.length
            ? Array.from(new Set([...postGroup.keywords, ...eff.discovery.keywords]))
            : undefined;
          const content = evaluateContent(post, eff.discovery, keywords);
          if (!content.ok) {
            db.recordAnalysis(post.id, { relevance: 0, intent: 0, quality: 0, reason: `filtered: ${content.reason}`, draftComment: null });
            continue;
          }

          await browser.readDwell(post.body);
          await browser.tryUpvote(eff.humanize.upvoteProbability);
          // Optionally research the topic live before drafting (config.ai.liveSearch).
          const research = await analyzer.research(post);
          // Brand mentions only where the subreddit allows them; otherwise topical.
          const promo: PromotionLevel =
            eff.ai.promotionLevel === "soft_brand" && postGroup && !postGroup.allowBrand
              ? "topical"
              : eff.ai.promotionLevel;
          const analysis = await analyzer.analyze(post, knowledge.guidanceFor(postGroup), research, promo);
          logger.info(
            {
              subreddit: post.subreddit,
              audience: postGroup?.label,
              relevance: analysis.relevance,
              intent: analysis.intent,
              quality: analysis.quality,
              drafted: Boolean(analysis.draftComment),
              researched: Boolean(research),
            },
            "Scored post",
          );
          db.recordAnalysis(post.id, analysis);
          if (analysis.draftComment) {
            scored.push({ post, analysis, draft: analysis.draftComment });
          }
          await browser.maybeMicroBreak();
        } catch (error) {
          // A timeout or navigation hiccup on one post shouldn't end the run.
          logger.warn({ postId: post.id, error: String(error) }, "Analysis failed for post, skipping");
        }
      }

      // Rank by relevance plus weighted buying-intent, so posts where someone is
      // actively asking for help/recommendations are commented on first.
      const rank = (a: AnalysisResult): number => a.relevance + eff.ai.intentWeight * a.intent;
      scored.sort((left, right) => rank(right.analysis) - rank(left.analysis));

      for (const item of scored) {
        if (db.wasAttempted(item.post.id)) {
          continue;
        }
        if (subredditCoolingDown(eff, db, item.post.subreddit)) {
          db.markSkipped(item.post.id, "subreddit cooldown");
          continue;
        }
        const gate = evaluatePostingGate({
          enabled: eff.posting.enabled,
          dailyCap: eff.posting.dailyCap,
          minGapMinutes: eff.posting.minGapMinutes,
          commentsInLast24h: db.commentsInLast24h(),
          lastCommentTs: db.lastCommentTimestamp(),
          nowSeconds: Math.floor(Date.now() / 1000),
        });
        if (!gate.allowed) {
          logger.info({ reason: gate.reason }, "Posting gate blocked further comments");
          break;
        }
        if (eff.humanize.enabled && eff.posting.enabled && Math.random() < eff.humanize.skipGoodPostProbability) {
          db.markSkipped(item.post.id, "humanized skip");
          continue;
        }

        logger.info(
          { subreddit: item.post.subreddit, title: item.post.title, relevance: item.analysis.relevance },
          "Selected draft",
        );

        if (!eff.posting.enabled) {
          db.markCommented(item.post.id, true);
          logger.info({ draft: item.draft }, "Draft only mode");
          continue;
        }

        const success = await publishComment(browser, eff, item.post, item.draft);
        if (success) {
          db.markCommented(item.post.id, false);
          const waitMinutes = randomBetween(eff.posting.minGapMinutes, Math.max(eff.posting.minGapMinutes, eff.posting.maxGapMinutes))
            + randomBetween(0, eff.posting.jitterMinutes);
          logger.info({ waitMinutes }, "Sleeping before next comment");
          await sleep(waitMinutes * 60_000);
        } else {
          db.markSkipped(item.post.id, "post not confirmed");
        }
      }
    });
  } finally {
    db.close();
  }
}

function pickSort(config: AppConfig): "new" | "hot" | "rising" {
  const options = config.discovery.sortRotation;
  return options[Math.floor(Math.random() * options.length)] ?? "new";
}

function dedupePosts(posts: Array<RedditPost | StoredPost>): Array<RedditPost | StoredPost> {
  const seen = new Set<string>();
  return posts.filter((post) => {
    if (seen.has(post.id)) {
      return false;
    }
    seen.add(post.id);
    return true;
  });
}

function subredditCoolingDown(config: AppConfig, db: StateDb, subreddit: string): boolean {
  return isSubredditCoolingDown({
    enabled: config.posting.enabled,
    humanizeEnabled: config.humanize.enabled,
    cooldownMinutes: config.humanize.perSubredditCooldownMinutes,
    lastCommentTs: db.lastCommentTimestampForSubreddit(subreddit),
    nowSeconds: Math.floor(Date.now() / 1000),
  });
}

async function maybeLurk(browser: RedditBrowser, config: AppConfig): Promise<void> {
  if (!config.humanize.enabled || Math.random() > config.humanize.lurkProbability) {
    return;
  }

  const total = randomBetween(config.humanize.lurkMin, Math.max(config.humanize.lurkMin, config.humanize.lurkMax));
  const shuffled = [...config.humanize.lurkSubreddits].sort(() => Math.random() - 0.5).slice(0, total);

  for (const subreddit of shuffled) {
    await browser.lurkSubreddit(subreddit);
    await browser.tryUpvote(config.humanize.upvoteProbability);
  }
}

function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
