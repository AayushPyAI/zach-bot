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

    // Find an eligible subreddit
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
    const submitUrl = `https://www.reddit.com/r/${subreddit}/submit`;
    await browser.idleBrowse(submitUrl);
    await browser.page.waitForLoadState("domcontentloaded").catch(() => {});
    await sleep(2000);

    // Click the Poll tab
    const pollTabSelectors = [
      'button:has-text("Poll")',
      '[data-testid="post-submit-poll-tab"]',
      'a:has-text("Poll")',
    ];
    let pollTabClicked = false;
    for (const sel of pollTabSelectors) {
      const el = browser.page.locator(sel).first();
      if ((await el.count()) > 0 && await el.isVisible()) {
        await el.click();
        pollTabClicked = true;
        await sleep(800);
        break;
      }
    }

    if (!pollTabClicked) {
      logger.warn({ subreddit }, "Poll tab not found on submit page");
      return { success: false };
    }

    // Fill in the poll question as the post title
    const titleSelectors = [
      'textarea[placeholder*="Title"]',
      'textarea[placeholder*="title"]',
      '#post-title',
      'input[placeholder*="title"]',
    ];
    let titleFilled = false;
    for (const sel of titleSelectors) {
      const el = browser.page.locator(sel).first();
      if ((await el.count()) > 0) {
        await el.fill(template.question);
        titleFilled = true;
        await sleep(500);
        break;
      }
    }
    if (!titleFilled) {
      logger.warn({ subreddit }, "Poll title input not found");
      return { success: false };
    }

    // Fill poll options
    for (let i = 0; i < template.options.length; i++) {
      const optionSelectors = [
        `input[placeholder*="Option ${i + 1}"]`,
        `input[placeholder*="option ${i + 1}"]`,
        `[data-testid="poll-option-${i}"] input`,
      ];
      let filled = false;
      for (const sel of optionSelectors) {
        const el = browser.page.locator(sel).first();
        if ((await el.count()) > 0) {
          await el.fill(template.options[i] ?? "");
          filled = true;
          await sleep(300);
          break;
        }
      }
      if (!filled) {
        // Try generic nth option input
        const inputs = browser.page.locator('input[placeholder*="option"], input[placeholder*="Option"]');
        const count = await inputs.count();
        if (i < count) {
          await inputs.nth(i).fill(template.options[i] ?? "");
          await sleep(300);
        }
      }
    }

    await sleep(1500);

    // Submit
    const submitSelectors = [
      'button[type="submit"]:has-text("Post")',
      'button:has-text("Post")',
      'button[type="submit"]',
    ];
    for (const sel of submitSelectors) {
      const btn = browser.page.locator(sel).first();
      if ((await btn.count()) > 0 && await btn.isVisible()) {
        await btn.click();
        await sleep(4000);
        break;
      }
    }

    // Confirm by URL
    const url = browser.page.url();
    const match = url.match(/\/r\/[^/]+\/comments\/([a-z0-9]+)\//i);
    if (match) {
      const canonical = url.replace("old.reddit.com", "www.reddit.com").replace(/\?.*$/, "");
      return { success: true, url: canonical, postId: match[1] };
    }

    return { success: false };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
