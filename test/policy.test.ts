import { describe, expect, it } from "vitest";

import type { AppConfig } from "../src/config.js";
import {
  evaluateContent,
  evaluatePostingGate,
  evaluateRemovalThrottle,
  evaluateStructural,
  isSubredditCoolingDown,
  withinActiveHours,
} from "../src/policy.js";
import type { RedditPost } from "../src/types.js";

const NOW = 1_700_000_000;

function makePost(overrides: Partial<RedditPost> = {}): RedditPost {
  return {
    id: "abc",
    subreddit: "EstatePlanning",
    title: "Need help with my late father's will",
    body: "x".repeat(200),
    author: "someone",
    url: "https://www.reddit.com/r/EstatePlanning/comments/abc",
    permalink: "/r/EstatePlanning/comments/abc",
    createdUtc: NOW - 3600, // 1 hour old
    commentCount: 2,
    upvotes: 5,
    over18: false,
    locked: false,
    archived: false,
    isSelf: true,
    ...overrides,
  };
}

const discovery: AppConfig["discovery"] = {
  sortRotation: ["new", "hot", "rising"],
  shuffleSubreddits: true,
  postsPerSubreddit: 15,
  maxAgeHours: 12,
  minAgeMinutes: 15,
  minBodyChars: 140,
  keywords: ["will", "estate", "probate"],
  visualMode: true,
  openPostWhileReading: true,
};

describe("evaluateStructural (feed-only, no body)", () => {
  it("passes a fresh self post even before its body is read", () => {
    const stub = makePost({ body: "" });
    expect(evaluateStructural(stub, discovery, NOW).ok).toBe(true);
  });

  it("rejects link posts, nsfw, locked, and bad ages without needing a body", () => {
    expect(evaluateStructural(makePost({ isSelf: false, body: "" }), discovery, NOW).ok).toBe(false);
    expect(evaluateStructural(makePost({ over18: true, body: "" }), discovery, NOW).reason).toBe("nsfw");
    expect(evaluateStructural(makePost({ createdUtc: NOW - 60, body: "" }), discovery, NOW).reason).toBe("too new");
  });
});

describe("evaluateContent (post-read)", () => {
  it("rejects bodies under the minimum length", () => {
    expect(evaluateContent(makePost({ body: "short" }), discovery).reason).toBe("body too short");
  });

  it("rejects off-topic bodies when keywords are set", () => {
    const offTopic = makePost({ title: "pizza", body: "z".repeat(200) });
    expect(evaluateContent(offTopic, discovery).reason).toBe("no keyword match");
  });

  it("accepts an on-topic body of sufficient length", () => {
    expect(evaluateContent(makePost(), discovery).ok).toBe(true);
  });

  it("accepts any sufficiently long body when no keywords are configured", () => {
    const noKeywords = { ...discovery, keywords: [] };
    const offTopic = makePost({ title: "best pizza in town", body: "y".repeat(200) });
    expect(evaluateContent(offTopic, noKeywords).ok).toBe(true);
  });

  it("uses the per-audience keyword override when provided", () => {
    // A college-audience post that mentions none of the global estate keywords
    // but matches the audience override should pass.
    const collegePost = makePost({
      title: "My kid is turning 18 and heading to college",
      body: "Wondering what healthcare proxy paperwork we need now that they are an adult. ".repeat(4),
    });
    expect(evaluateContent(collegePost, discovery).reason).toBe("no keyword match");
    expect(evaluateContent(collegePost, discovery, ["healthcare proxy", "college"]).ok).toBe(true);
  });
});

describe("withinActiveHours", () => {
  it("handles normal windows", () => {
    expect(withinActiveHours([8, 23], 10)).toBe(true);
    expect(withinActiveHours([8, 23], 23)).toBe(false); // end is exclusive
    expect(withinActiveHours([8, 23], 7)).toBe(false);
  });

  it("handles wrap-around windows", () => {
    expect(withinActiveHours([22, 6], 23)).toBe(true);
    expect(withinActiveHours([22, 6], 3)).toBe(true);
    expect(withinActiveHours([22, 6], 12)).toBe(false);
  });
});

describe("evaluatePostingGate", () => {
  const base = {
    enabled: true,
    dailyCap: 1,
    minGapMinutes: 180,
    commentsInLast24h: 0,
    lastCommentTs: null,
    nowSeconds: NOW,
  };

  it("always allows in draft-only mode", () => {
    expect(evaluatePostingGate({ ...base, enabled: false, commentsInLast24h: 99 }).allowed).toBe(true);
  });

  it("blocks when the daily cap is reached", () => {
    expect(evaluatePostingGate({ ...base, commentsInLast24h: 1 }).allowed).toBe(false);
  });

  it("allows the first comment when none exist yet", () => {
    expect(evaluatePostingGate(base).allowed).toBe(true);
  });

  it("blocks when the minimum gap has not elapsed", () => {
    const recent = NOW - 60 * 60; // 1 hour ago, gap is 180m
    expect(evaluatePostingGate({ ...base, lastCommentTs: recent }).allowed).toBe(false);
  });

  it("allows once the gap has elapsed", () => {
    const old = NOW - 4 * 60 * 60; // 4 hours ago
    expect(evaluatePostingGate({ ...base, lastCommentTs: old }).allowed).toBe(true);
  });
});

describe("evaluateRemovalThrottle", () => {
  const cfg = { minSample: 3, threshold: 0.34 };

  it("does not throttle before enough comments are checked", () => {
    expect(evaluateRemovalThrottle({ checked: 2, removed: 2, ...cfg }).throttle).toBe(false);
  });

  it("throttles when the removal rate meets the threshold", () => {
    const r = evaluateRemovalThrottle({ checked: 6, removed: 3, ...cfg }); // 50%
    expect(r.throttle).toBe(true);
    expect(r.rate).toBeCloseTo(0.5);
  });

  it("does not throttle when removals are within limits", () => {
    expect(evaluateRemovalThrottle({ checked: 10, removed: 2, ...cfg }).throttle).toBe(false); // 20%
  });

  it("handles zero checked safely", () => {
    expect(evaluateRemovalThrottle({ checked: 0, removed: 0, ...cfg }).throttle).toBe(false);
  });
});

describe("isSubredditCoolingDown", () => {
  const base = {
    enabled: true,
    humanizeEnabled: true,
    cooldownMinutes: 360,
    lastCommentTs: NOW - 60 * 60,
    nowSeconds: NOW,
  };

  it("is cooling down within the window", () => {
    expect(isSubredditCoolingDown(base)).toBe(true);
  });

  it("is not cooling down after the window", () => {
    expect(isSubredditCoolingDown({ ...base, lastCommentTs: NOW - 7 * 60 * 60 })).toBe(false);
  });

  it("never cools down in draft-only mode or with no history", () => {
    expect(isSubredditCoolingDown({ ...base, enabled: false })).toBe(false);
    expect(isSubredditCoolingDown({ ...base, lastCommentTs: null })).toBe(false);
  });
});
