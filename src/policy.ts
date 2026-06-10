import { AppConfig } from "./config.js";
import { RedditPost } from "./types.js";

/**
 * Pure, side-effect-free decision logic.
 *
 * Everything here takes plain values (config slices, timestamps, counts) and
 * returns a verdict. No database, no clock, no network. That makes the rules
 * the bot lives by trivially unit-testable and keeps workflow.ts focused on
 * orchestration.
 */

export interface CandidateReason {
  ok: boolean;
  reason: string;
}

/**
 * Structural pre-filter using only what the feed listing exposes (post type,
 * flags, age). Applied before opening a post so we never bother reading or
 * scoring something we'd obviously skip. Body-dependent checks live in
 * {@link evaluateContent}.
 */
export function evaluateStructural(
  post: RedditPost,
  discovery: AppConfig["discovery"],
  nowSeconds: number,
): CandidateReason {
  if (!post.isSelf) {
    return { ok: false, reason: "not a self/text post" };
  }
  if (post.locked) {
    return { ok: false, reason: "locked" };
  }
  if (post.archived) {
    return { ok: false, reason: "archived" };
  }
  if (post.over18) {
    return { ok: false, reason: "nsfw" };
  }

  const ageSeconds = nowSeconds - post.createdUtc;
  if (ageSeconds < discovery.minAgeMinutes * 60) {
    return { ok: false, reason: "too new" };
  }
  if (ageSeconds > discovery.maxAgeHours * 3600) {
    return { ok: false, reason: "too old" };
  }
  return { ok: true, reason: "structurally eligible" };
}

/**
 * Content filter applied once the post body has been read: minimum length and,
 * if configured, a keyword match across the title and body. Kept separate from
 * the structural check because the body isn't known until we open the post.
 */
export function evaluateContent(
  post: RedditPost,
  discovery: AppConfig["discovery"],
  keywordsOverride?: string[],
): CandidateReason {
  if (post.body.length < discovery.minBodyChars) {
    return { ok: false, reason: "body too short" };
  }
  // Per-audience keywords (when provided) take precedence over the global list,
  // so each audience matches its own topics, not just estate-planning terms.
  const keywords = keywordsOverride && keywordsOverride.length > 0 ? keywordsOverride : discovery.keywords;
  if (keywords.length === 0) {
    return { ok: true, reason: "no keyword filter" };
  }
  const haystack = `${post.title}\n${post.body}`.toLowerCase();
  const matched = keywords.some((keyword) => haystack.includes(keyword.toLowerCase()));
  return matched
    ? { ok: true, reason: "keyword match" }
    : { ok: false, reason: "no keyword match" };
}

/**
 * Combined structural + content verdict. Convenient when the full post
 * (including body) is already in hand.
 */
export function evaluateCandidate(
  post: RedditPost,
  discovery: AppConfig["discovery"],
  nowSeconds: number,
): CandidateReason {
  const structural = evaluateStructural(post, discovery, nowSeconds);
  if (!structural.ok) {
    return structural;
  }
  return evaluateContent(post, discovery);
}

export function isCandidatePost(
  post: RedditPost,
  discovery: AppConfig["discovery"],
  nowSeconds: number,
): boolean {
  return evaluateCandidate(post, discovery, nowSeconds).ok;
}

/** True when the current hour falls inside the configured active window. */
export function withinActiveHours(activeHours: readonly [number, number], hour: number): boolean {
  const [start, end] = activeHours;
  if (start <= end) {
    return hour >= start && hour < end;
  }
  // Wrap-around window, e.g. [22, 6].
  return hour >= start || hour < end;
}

export interface PostingGateInput {
  enabled: boolean;
  dailyCap: number;
  minGapMinutes: number;
  commentsInLast24h: number;
  lastCommentTs: number | null;
  nowSeconds: number;
}

export interface PostingGate {
  allowed: boolean;
  reason: string;
}

/**
 * Whether another live comment is permitted right now, given the daily cap and
 * the minimum gap since the last comment. Draft-only mode always allows.
 */
export function evaluatePostingGate(input: PostingGateInput): PostingGate {
  if (!input.enabled) {
    return { allowed: true, reason: "draft-only mode" };
  }
  if (input.dailyCap > 0 && input.commentsInLast24h >= input.dailyCap) {
    return { allowed: false, reason: `daily cap reached (${input.commentsInLast24h}/${input.dailyCap})` };
  }
  if (input.lastCommentTs === null) {
    return { allowed: true, reason: "no prior comment" };
  }
  const minutesSince = (input.nowSeconds - input.lastCommentTs) / 60;
  if (minutesSince < input.minGapMinutes) {
    return {
      allowed: false,
      reason: `min gap not met (${minutesSince.toFixed(1)}m < ${input.minGapMinutes}m)`,
    };
  }
  return { allowed: true, reason: "gap satisfied" };
}

/**
 * Whether a subreddit is still cooling down from a recent comment. Only applies
 * to live posting with humanization enabled.
 */
export function isSubredditCoolingDown(input: {
  enabled: boolean;
  humanizeEnabled: boolean;
  cooldownMinutes: number;
  lastCommentTs: number | null;
  nowSeconds: number;
}): boolean {
  if (!input.enabled || !input.humanizeEnabled || input.cooldownMinutes <= 0) {
    return false;
  }
  if (input.lastCommentTs === null) {
    return false;
  }
  const minutesSince = (input.nowSeconds - input.lastCommentTs) / 60;
  return minutesSince < input.cooldownMinutes;
}
