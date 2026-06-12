import { AppConfig } from "./config.js";
import { StateDb } from "./db.js";
import { logger } from "./logger.js";
import { RedditBrowser } from "./reddit-browser.js";

interface PollTemplate {
  question: string;
  options: string[];
}

const POLL_TEMPLATES: PollTemplate[] = [
  {
    question: "How many Americans do you think have an up-to-date will?",
    options: ["Less than 30%", "30–50%", "50–70%", "More than 70%"],
  },
  {
    question: "What's your biggest hesitation about estate planning?",
    options: ["Too expensive", "Too complicated", "I'm too young to worry", "Just haven't gotten around to it"],
  },
  {
    question: "If you had to get your estate planning done today, what would you do?",
    options: ["Hire an attorney ($2k–5k)", "Use a DIY online service", "Ask a family member", "Keep putting it off"],
  },
  {
    question: "What would finally motivate you to get your will done?",
    options: ["A health scare", "Having kids or grandkids", "Watching a family go through probate", "Finding an affordable option"],
  },
  {
    question: "How prepared is your family if something unexpected happened to you?",
    options: ["Fully prepared — documents in order", "Somewhat prepared", "Not prepared at all", "I don't want to think about it"],
  },
];

interface MeJson {
  data?: { modhash?: string };
}

interface PollSubmitResponse {
  url?: string;
  id?: string;
  // Some Reddit clients wrap in json.data
  json?: { data?: { url?: string; id?: string } };
}

export class PollCreator {
  private readonly config: AppConfig;

  constructor(config: AppConfig, _openaiApiKey: string) {
    this.config = config;
  }

  async maybeCreatePoll(browser: RedditBrowser, db: StateDb): Promise<void> {
    const pc = this.config.pollCreationV2;
    if (!pc?.enabled || !this.config.posting.enabled) return;

    const nowTs = Math.floor(Date.now() / 1000);
    const cooldownSecs = pc.cooldownDays * 86_400;

    const eligible = pc.subreddits.filter((sub) => {
      const weekCount = db.pollsThisWeek(sub);
      if (weekCount >= pc.weeklyCapPerSubreddit) return false;
      const lastTs = db.lastPollTimestamp(sub);
      if (lastTs && nowTs - lastTs < cooldownSecs) return false;
      return true;
    });

    if (eligible.length === 0) {
      logger.debug("Poll creation: no eligible subreddits (all in cooldown or capped)");
      return;
    }

    const subreddit = eligible[Math.floor(Math.random() * eligible.length)]!;
    const template = POLL_TEMPLATES[Math.floor(Math.random() * POLL_TEMPLATES.length)]!;

    logger.info({ subreddit, question: template.question }, "Creating Reddit poll");

    const result = await this.postPoll(browser, subreddit, template);

    db.savePoll({
      subreddit,
      question: template.question,
      options: template.options,
      dryRun: !result.success,
      url: result.url,
      redditPostId: result.postId,
    });

    if (result.success) {
      logger.info({ subreddit, url: result.url, question: template.question }, "Poll posted live");
    } else {
      logger.warn({ subreddit, question: template.question }, "Poll post did not confirm; saved as draft");
    }
  }

  private async postPoll(
    browser: RedditBrowser,
    subreddit: string,
    template: PollTemplate,
  ): Promise<{ success: boolean; url?: string; postId?: string }> {
    // Get modhash from the authenticated session.
    const meJson = await browser.page.evaluate(async () => {
      const res = await fetch("https://www.reddit.com/api/me.json", { credentials: "include" });
      if (!res.ok) return null;
      return res.json();
    }) as MeJson | null;

    const modhash = meJson?.data?.modhash;
    if (!modhash) {
      logger.warn({ subreddit }, "Poll submit: could not get modhash — likely not logged in");
      return { success: false };
    }

    await sleep(1000 + Math.random() * 1500);

    const result = await browser.page.evaluate(async ({ sr, title, options, uh }) => {
      const res = await fetch("https://www.reddit.com/api/submit_poll_post", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "X-Modhash": uh,
        },
        body: JSON.stringify({
          sr,
          title,
          options,
          duration: 3,
          nsfw: false,
          spoiler: false,
        }),
      });
      if (!res.ok) return null;
      return res.json();
    }, { sr: subreddit, title: template.question, options: template.options, uh: modhash }) as PollSubmitResponse | null;

    // The response may nest the URL in different ways depending on Reddit's version.
    const url = result?.url ?? result?.json?.data?.url;
    const rawId = result?.id ?? result?.json?.data?.id;
    // Strip the t3_ prefix if present so we store just the post ID.
    const postId = rawId?.replace(/^t3_/, "");

    if (!url) {
      logger.warn({ subreddit, result }, "Poll submit: API returned no URL");
      return { success: false };
    }

    return { success: true, url, postId };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
