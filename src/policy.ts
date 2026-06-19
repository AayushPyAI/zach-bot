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

export interface RemovalThrottle {
  throttle: boolean;
  reason: string;
  rate: number;
}

/**
 * Decide whether to back off to draft-only because Reddit is removing our
 * comments. Only triggers once enough comments have actually been checked, so a
 * single early removal doesn't over-react. Pure and unit-tested.
 */
export function evaluateRemovalThrottle(input: {
  checked: number;
  removed: number;
  minSample: number;
  threshold: number;
}): RemovalThrottle {
  const rate = input.checked > 0 ? input.removed / input.checked : 0;
  if (input.checked < input.minSample) {
    return { throttle: false, reason: `not enough checked yet (${input.checked}/${input.minSample})`, rate };
  }
  if (rate >= input.threshold) {
    return {
      throttle: true,
      reason: `removal rate ${(rate * 100).toFixed(0)}% ≥ ${(input.threshold * 100).toFixed(0)}% threshold`,
      rate,
    };
  }
  return { throttle: false, reason: `removal rate ${(rate * 100).toFixed(0)}% within limits`, rate };
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

/**
 * The current hour (0–23) in a given IANA timezone, independent of the server's
 * own clock. The account's persona lives in one timezone (browser.timezoneId);
 * driving its activity by the server's local hour instead — e.g. a US-persona
 * account most active during Berlin afternoons — is itself an automation tell.
 */
export function hourInTimeZone(timeZone: string, date: Date = new Date()): number {
  try {
    const value = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hour12: false,
      timeZone,
    }).formatToParts(date).find((part) => part.type === "hour")?.value;
    const hour = Number(value);
    if (Number.isNaN(hour)) {
      return date.getHours();
    }
    return hour === 24 ? 0 : hour;
  } catch {
    return date.getHours();
  }
}

/**
 * Relative likelihood (0–1) that a real person is actively browsing/posting at
 * a given local hour. A flat active-hours window posts with equal probability at
 * 9am and 9pm; real activity has a shape — quiet overnight, a midday bump, an
 * evening peak. The workflow rolls against this so posting frequency follows a
 * human daily rhythm rather than a uniform distribution across the window.
 */
export function hourActivityWeight(hour: number): number {
  const curve = [
    0.02, 0.02, 0.02, 0.02, 0.02, 0.03, // 0–5  overnight
    0.08, 0.20, 0.40, 0.60, 0.60, 0.65, // 6–11 morning ramp
    0.85, 0.80, 0.50, 0.45, 0.50, 0.65, // 12–17 lunch peak, afternoon dip
    0.70, 0.90, 0.90, 0.85, 0.50, 0.25, // 18–23 evening peak, wind down
  ];
  return curve[hour] ?? 0.3;
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
