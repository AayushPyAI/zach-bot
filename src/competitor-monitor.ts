import { AppConfig } from "./config.js";
import { logger } from "./logger.js";
import { StateDb } from "./db.js";
import { RedditBrowser } from "./reddit-browser.js";
import { RedditPost } from "./types.js";

interface RedditSearchChild {
  data: {
    id: string;
    subreddit: string;
    title: string;
    selftext: string;
    author: string;
    url: string;
    permalink: string;
    created_utc: number;
    num_comments: number;
    score: number;
    over_18: boolean;
    locked: boolean;
    archived: boolean;
    is_self: boolean;
  };
}

interface RedditSearchResponse {
  data?: { children?: RedditSearchChild[] };
}

const SEARCH_QUERIES: Record<string, string[]> = {
  "LegalZoom":    ["LegalZoom will", "LegalZoom estate", "LegalZoom trust", "LegalZoom review"],
  "Trust & Will": ["Trust and Will review", "Trust Will estate planning", "trustwill.com"],
  "tomorrow.me":  ["tomorrow.me estate", "tomorrow life insurance estate"],
  "Willing":      ["Willing will estate", "willing.com review"],
  "FreeWill":     ["FreeWill estate planning", "freewill.com review"],
  "Fabric":       ["Fabric will estate", "fabriclife estate planning"],
};

export class CompetitorMonitor {
  private readonly config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
  }

  async scanCompetitors(db: StateDb, browser: RedditBrowser): Promise<number> {
    const cm = this.config.competitorMonitor;
    if (!cm?.enabled) return 0;

    const enabledCompetitors = cm.competitors.filter((c) => SEARCH_QUERIES[c]);
    let totalNew = 0;

    for (const competitor of enabledCompetitors) {
      const queries = SEARCH_QUERIES[competitor] ?? [];
      for (const query of queries) {
        try {
          const found = await this.searchQuery(query, cm.maxResultsPerSearch, db, browser);
          totalNew += found;
          await sleep(2000);
        } catch (error) {
          logger.warn({ competitor, query, error: String(error) }, "Competitor search failed, skipping");
        }
      }
    }

    return totalNew;
  }

  private async searchQuery(
    query: string,
    limit: number,
    db: StateDb,
    browser: RedditBrowser,
  ): Promise<number> {
    const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=new&t=day&limit=${limit}`;

    // Use the authenticated Chrome session so Reddit's cookies are included —
    // raw node fetch gets 403 because it has no session.
    const json = await browser.page.evaluate(async (fetchUrl) => {
      const res = await fetch(fetchUrl, { credentials: "include" });
      if (!res.ok) return null;
      return res.json();
    }, url) as RedditSearchResponse | null;

    if (!json) {
      logger.warn({ url }, "Competitor search: no data returned");
      return 0;
    }

    const children = json?.data?.children ?? [];
    let newCount = 0;

    for (const child of children) {
      const d = child.data;
      if (!d.is_self) continue;
      if (db.hasSeen(d.id)) continue;

      const post: RedditPost = {
        id: d.id,
        subreddit: d.subreddit,
        title: d.title,
        body: d.selftext.slice(0, 500),
        author: d.author,
        url: `https://www.reddit.com${d.permalink}`,
        permalink: d.permalink,
        createdUtc: d.created_utc,
        commentCount: d.num_comments,
        upvotes: d.score,
        over18: d.over_18,
        locked: d.locked,
        archived: d.archived,
        isSelf: d.is_self,
        audience: undefined,
      };

      db.saveDiscovered(post);
      db.recordAnalysis(d.id, {
        relevance: 9,
        intent: 9,
        quality: 7,
        reason: `Competitor mention: ${query}`,
        draftComment: null,
      });
      newCount++;
    }

    return newCount;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
