import path from "node:path";

import { fetchAccountStats } from "./account.js";
import { AppConfig, AudienceGroup } from "./config.js";
import { publishComment } from "./comment-publisher.js";
import { PostGenerator, PostType } from "./post-generator.js";
import { publishPost } from "./post-publisher.js";
import { StateDb } from "./db.js";
import { recheckComments } from "./engagement.js";
import { logger } from "./logger.js";
import { OpenAiAnalyzer, PromotionLevel } from "./openai-analyzer.js";
import { loadProductKnowledge, ProductKnowledge } from "./products.js";
import { selectStage } from "./ramp.js";
import {
  evaluateContent,
  evaluatePostingGate,
  evaluateRemovalThrottle,
  hourActivityWeight,
  hourInTimeZone,
  isSubredditCoolingDown,
  withinActiveHours,
} from "./policy.js";
import { RedditBrowser } from "./reddit-browser.js";
import { discoverPosts, readPostBody } from "./reddit-discovery.js";
import { AnalysisResult, RedditPost, StoredPost } from "./types.js";
import { CompetitorMonitor } from "./competitor-monitor.js";
import { processFollowUps, scheduleFollowUp } from "./follow-up.js";
import { PollCreator } from "./poll-creator.js";
import { CrossPoster } from "./cross-poster.js";
import { checkAmaReadiness } from "./ama-tracker.js";

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

  // Session "energy": not every visit is a full sweep. ~30% are quick check-ins
  // (skim a couple of subs, maybe one reply, no posting chores); ~20% are long,
  // thorough sessions; the rest are normal. This varies the macro-shape of a
  // session so they don't all look structurally identical.
  const energy = pickSessionEnergy();
  const energyScale = energy === "quick" ? 0.4 : energy === "deep" ? 1.35 : 1;
  eff.runtime.maxSubredditsPerSession = Math.max(3, Math.round(eff.runtime.maxSubredditsPerSession * energyScale));
  eff.runtime.maxAnalyzePerRun = Math.max(2, Math.round(eff.runtime.maxAnalyzePerRun * energyScale));
  logger.info(
    { energy, maxSubreddits: eff.runtime.maxSubredditsPerSession, maxAnalyze: eff.runtime.maxAnalyzePerRun },
    "Session energy selected",
  );

  try {
    await browser.withSession(async () => {
      await browser.login();

      // Begin like a person: open Reddit and browse the home feed for a moment
      // before doing anything purposeful, rather than deep-linking instantly.
      await browser.warmUp();

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
          // Post creation cap scales with ramp stage.
          if (eff.postCreation) {
            eff.postCreation.weeklyPostCap = stage.weeklyPostCap;
          }
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

      // Posting-time gates now that posting is resolved. Active hours and the
      // hourly-rhythm roll both use the persona's own timezone, not the server's.
      if (eff.humanize.enabled && eff.posting.enabled) {
        const localHour = hourInTimeZone(eff.browser.timezoneId);
        const activityWeight = hourActivityWeight(localHour);
        if (!withinActiveHours(eff.humanize.activeHours, localHour)) {
          logger.info({ localHour }, "Outside active hours; this session will read/draft but not post");
          eff.posting.enabled = false;
        } else if (Math.random() > activityWeight) {
          logger.info({ localHour, activityWeight }, "Low-activity hour for this persona; reading/drafting but not posting");
          eff.posting.enabled = false;
        } else if (Math.random() < eff.humanize.skipRunProbability) {
          logger.info("Random skip-run gate triggered; this session will read/draft but not post");
          eff.posting.enabled = false;
        }
      }

      await maybeLurk(browser, eff);

      // Scan for competitor mentions — high buying-intent threads added to queue.
      if (eff.competitorMonitor.enabled) {
        try {
          const cm = new CompetitorMonitor(eff);
          const found = await cm.scanCompetitors(db, browser);
          if (found > 0) logger.info({ found }, "Competitor mentions added to queue");
        } catch (error) {
          logger.warn({ error: String(error) }, "Competitor monitor failed, continuing");
        }
      }

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

      // With a large subreddit pool, cap how many are visited per session so
      // runs stay fast. The shuffle above ensures rotation across all subs.
      const maxPerSession = eff.runtime.maxSubredditsPerSession;
      const sessionTargets = maxPerSession > 0 ? targets.slice(0, maxPerSession) : targets;
      logger.info({ total: targets.length, thisSession: sessionTargets.length }, "Subreddit targets for this session");

      for (const target of sessionTargets) {
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
        // Scan the feed for a beat before moving on to the next community,
        // rather than hopping subreddits machine-fast.
        await browser.think(1800, 5000);
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

      // Read posts grouped by subreddit so consecutive opens can share a feed —
      // both faster and more human (you read several threads from one sub before
      // moving on, rather than hopping subreddits post by post).
      const orderedPending = [...pending].sort((a, b) => a.subreddit.localeCompare(b.subreddit));

      const scored: Array<{ post: RedditPost | StoredPost; analysis: AnalysisResult; draft: string }> = [];
      let consecutiveOpenFailures = 0;
      for (const post of orderedPending) {
        try {
          // Open the post like a reader would — click its card in the feed rather
          // than cold-loading the URL — then pull its body from the page and
          // persist it. The body isn't known from the feed, so this is also where
          // the content filter (length + keywords) runs.
          const opened = await browser.openPost(post);
          post.body = await readPostBody(browser);
          db.saveDiscovered(post);
          consecutiveOpenFailures = 0;

          const postGroup = groupForSubreddit(post.subreddit);
          const keywords = postGroup?.keywords?.length
            ? Array.from(new Set([...postGroup.keywords, ...eff.discovery.keywords]))
            : undefined;
          const content = evaluateContent(post, eff.discovery, keywords);
          if (!content.ok) {
            db.recordAnalysis(post.id, { relevance: 0, intent: 0, quality: 0, reason: `filtered: ${content.reason}`, draftComment: null });
            if (opened === "click") await browser.goBack();
            continue;
          }

          await browser.readDwell(post.body);
          await browser.tryUpvote(eff.humanize.upvoteProbability);
          // Read the discussion and upvote a helpful comment or two — what a
          // real reader is actually here to do, not just skim the OP and leave.
          await browser.browseComments(eff.humanize.upvoteProbability);
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

          // Stop analyzing once we have enough quality drafts for this session.
          // No point spending tokens on posts beyond what the daily cap allows.
          let enough = false;
          if (analysis.draftComment) {
            scored.push({ post, analysis, draft: analysis.draftComment });
            const draftTarget = eff.posting.enabled ? eff.posting.dailyCap * 2 : 4;
            if (scored.length >= draftTarget) {
              logger.info({ drafts: scored.length, cap: eff.posting.dailyCap }, "Enough quality drafts collected; stopping analysis");
              enough = true;
            }
          }
          // Return to the feed afterwards, like a reader clicking "back".
          if (opened === "click") await browser.goBack();
          if (enough) break;
          await browser.maybeMicroBreak();
        } catch (error) {
          // A timeout or navigation hiccup on one post shouldn't end the run.
          consecutiveOpenFailures += 1;
          logger.warn({ postId: post.id, error: String(error) }, "Analysis failed for post, skipping");
          // If posts keep failing to open back-to-back, Reddit is likely
          // throttling us — stop hammering and let the session wind down.
          if (consecutiveOpenFailures >= 3) {
            logger.warn({ consecutiveOpenFailures }, "Consecutive post-open failures; Reddit may be throttling — ending analysis early");
            break;
          }
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

        // Append DM invite CTA on posts with high buying intent.
        if (eff.dmCTA.enabled && (item.analysis.intent ?? 0) >= eff.dmCTA.intentThreshold) {
          item.draft = item.draft + "\n\n" + eff.dmCTA.message;
        }

        if (!eff.posting.enabled) {
          db.markCommented(item.post.id, true);
          logger.info({ draft: item.draft }, "Draft only mode");
          continue;
        }

        const success = await publishComment(browser, eff, item.post, item.draft);
        if (success) {
          db.markCommented(item.post.id, false);
          await scheduleFollowUp(db, item.post.id, item.post.url, item.post.subreddit);
          const waitMinutes = randomBetween(eff.posting.minGapMinutes, Math.max(eff.posting.minGapMinutes, eff.posting.maxGapMinutes))
            + randomBetween(0, eff.posting.jitterMinutes);
          logger.info({ waitMinutes }, "Sleeping before next comment");
          await sleep(waitMinutes * 60_000);
        } else {
          db.markSkipped(item.post.id, "post not confirmed");
        }
      }

      // Sometimes step away for a bit between finishing replies and any posting
      // chores, the way a person gets pulled to another tab mid-session.
      if (eff.humanize.enabled && Math.random() < 0.3) {
        await browser.simulateAwayBreak();
      }

      // Tail activities (original posts, cross-posts, polls, follow-ups, AMA
      // tracking) are occasional rather than every-session, and their order is
      // not fixed. Quick check-in sessions skip them entirely. Each activity
      // keeps its own internal caps/cooldowns; the probability here just stops
      // them firing on a predictable cadence right after every comment pass.
      if (energy !== "quick") {
        const tail: Array<{ label: string; prob: number; run: () => Promise<void> }> = [
          { label: "create-post", prob: 0.5, run: () => maybeCreatePost(browser, eff, db, knowledge) },
          { label: "follow-ups", prob: 0.85, run: () => processFollowUps(browser, db, eff, analyzer, knowledge) },
          { label: "ama-tracker", prob: 0.5, run: () => checkAmaReadiness(db, eff, eff.openAiApiKey) },
        ];
        if (eff.crossPosting.enabled) {
          tail.push({
            label: "cross-post",
            prob: 0.5,
            run: async () => {
              const cp = new CrossPoster(eff, eff.openAiApiKey);
              await cp.maybeCrossPost(browser, db);
            },
          });
        }
        if (eff.pollCreationV2.enabled && eff.posting.enabled) {
          tail.push({
            label: "poll",
            prob: 0.5,
            run: async () => {
              const pc = new PollCreator(eff, eff.openAiApiKey);
              await pc.maybeCreatePoll(browser, db);
            },
          });
        }

        tail.sort(() => Math.random() - 0.5);
        for (const activity of tail) {
          if (Math.random() > activity.prob) {
            continue;
          }
          try {
            await activity.run();
          } catch (error) {
            logger.warn({ activity: activity.label, error: String(error) }, "Tail activity failed, continuing");
          }
          await browser.maybeMicroBreak(0.3);
        }
      }
    });
  } finally {
    db.close();
  }
}

type SessionEnergy = "quick" | "normal" | "deep";

/** Pick how much work this session does, so sessions vary in length and scope. */
function pickSessionEnergy(): SessionEnergy {
  const roll = Math.random();
  if (roll < 0.3) return "quick";
  if (roll < 0.8) return "normal";
  return "deep";
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
    try {
      await browser.lurkSubreddit(subreddit);
      await browser.tryUpvote(config.humanize.upvoteProbability);
    } catch (error) {
      // Reddit SPA can destroy the navigation context mid-lurk; skip and continue.
      logger.warn({ subreddit, error: String(error) }, "Lurk navigation hiccup, skipping subreddit");
    }
  }
}

function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Attempt to create an original Reddit post for this session.
 *
 * Gates (all must pass):
 *  1. postCreation.enabled is true in config
 *  2. eff.posting.enabled — only post during active hours / non-throttled runs
 *  3. weeklyPostCap > 0 (ramp may set this to 0 for young/low-karma accounts)
 *  4. Fewer live posts than weeklyPostCap in the last 7 days
 *  5. Target subreddit not posted to within subredditCooldownDays
 */
async function maybeCreatePost(
  browser: RedditBrowser,
  eff: AppConfig,
  db: StateDb,
  knowledge: ProductKnowledge,
): Promise<void> {
  const pc = eff.postCreation;
  if (!pc?.enabled || !eff.posting.enabled) return;

  const weekCap = pc.weeklyPostCap;
  if (weekCap <= 0) {
    logger.debug("Post creation: weekly cap is 0 for this ramp stage; skipping");
    return;
  }

  const postsThisWeek = db.postsThisWeek();
  if (postsThisWeek >= weekCap) {
    logger.info({ postsThisWeek, weekCap }, "Weekly post cap reached; skipping post creation this session");
    return;
  }

  // Find subreddits not recently posted to
  const cooldownSecs = pc.subredditCooldownDays * 86_400;
  const nowSecs = Math.floor(Date.now() / 1000);
  const eligible = pc.subreddits.filter((sub) => {
    const last = db.lastPostTimestampForSubreddit(sub);
    return !last || nowSecs - last >= cooldownSecs;
  });

  if (eligible.length === 0) {
    logger.info("All post-creation subreddits in cooldown; skipping this session");
    return;
  }

  const subreddit = eligible[Math.floor(Math.random() * eligible.length)]!;
  const postType = (pc.postTypes[Math.floor(Math.random() * pc.postTypes.length)] ?? "educational") as PostType;
  const group = eff.audiences.find((g) =>
    g.subreddits.some((s) => s.toLowerCase() === subreddit.toLowerCase()),
  );
  const audience = group?.label ?? "people thinking about estate planning";
  const guidance = knowledge.guidanceFor(group);

  logger.info({ subreddit, postType, audience }, "Generating original post for publishing");

  const generator = new PostGenerator(eff);
  const generated = await generator.generate(subreddit, audience, postType, guidance ?? undefined);

  if (!generated) {
    logger.warn({ subreddit, postType }, "Post generation returned nothing; skipping");
    return;
  }

  if (generated.body.length < pc.minBodyChars) {
    logger.warn({ bodyLen: generated.body.length, min: pc.minBodyChars, subreddit }, "Generated body too short; skipping");
    return;
  }

  // Enforce max length — typing a 2000-char body at 3–6 cps wastes 5+ minutes.
  if (generated.body.length > pc.maxBodyChars) {
    generated.body = generated.body.slice(0, pc.maxBodyChars).replace(/\s+\S*$/, "");
  }

  logger.info({ subreddit, postType, title: generated.title, bodyLen: generated.body.length }, "Publishing original post");

  const result = await publishPost(browser, eff, subreddit as string, generated.title, generated.body);

  db.saveCreatedPost({
    subreddit: subreddit as string,
    title: generated.title,
    body: generated.body,
    postType: generated.postType,
    audience,
    dryRun: !result.success,
    url: result.url,
    redditPostId: result.postId,
  });

  if (result.success) {
    logger.info({ subreddit, url: result.url, title: generated.title }, "Original post published live");
  } else {
    logger.warn({ subreddit, title: generated.title }, "Post publish did not confirm; saved as draft for review");
  }
}
