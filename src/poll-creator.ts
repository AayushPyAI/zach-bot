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

  /**
   * Submit a poll via new Reddit's browser UI.
   * Old Reddit has no poll option, so we use www.reddit.com/r/{sub}/submit
   * and interact with the Poll tab through the browser.
   */
  private async postPoll(
    browser: RedditBrowser,
    subreddit: string,
    template: PollTemplate,
  ): Promise<{ success: boolean; url?: string; postId?: string }> {
    const submitUrl = `https://www.reddit.com/r/${subreddit}/submit`;
    await browser.page.goto(submitUrl, { waitUntil: "domcontentloaded" });
    await sleep(2000 + Math.random() * 1500);

    // Click the Poll tab
    const pollTab = browser.page.locator("button:has-text('Poll'), [role='tab']:has-text('Poll')").first();
    if ((await pollTab.count()) === 0) {
      logger.warn({ subreddit }, "Poll submit: Poll tab not found");
      return { success: false };
    }
    await browser.humanClick(pollTab);
    await sleep(800 + Math.random() * 500);

    // Fill question (title field)
    const titleSel = "textarea[placeholder*='Title'], input[placeholder*='Title'], #post-title";
    const titleField = browser.page.locator(titleSel).first();
    if ((await titleField.count()) === 0) {
      logger.warn({ subreddit }, "Poll submit: title field not found");
      return { success: false };
    }
    await browser.humanType(titleSel, template.question, 3, 6);
    await sleep(500 + Math.random() * 500);

    // Fill poll options
    for (let i = 0; i < template.options.length; i++) {
      const optionSel = `input[placeholder*='Option ${i + 1}'], input[placeholder*='option ${i + 1}']`;
      const optField = browser.page.locator(optionSel).first();
      if ((await optField.count()) === 0) {
        // Try clicking "Add Option" if field not visible
        const addBtn = browser.page.locator("button:has-text('Add Option'), button:has-text('Add option')").first();
        if ((await addBtn.count()) > 0) await browser.humanClick(addBtn);
        await sleep(400);
      }
      if ((await browser.page.locator(optionSel).first().count()) > 0) {
        await browser.humanType(optionSel, template.options[i]!, 3, 6);
        await sleep(300 + Math.random() * 300);
      }
    }

    await sleep(800 + Math.random() * 500);

    // Submit
    const submitBtn = browser.page.locator("button:has-text('Post'), button[type='submit']:has-text('Post')").first();
    if ((await submitBtn.count()) === 0) {
      logger.warn({ subreddit }, "Poll submit: submit button not found");
      return { success: false };
    }
    await browser.humanClick(submitBtn);
    await sleep(4000 + Math.random() * 2000);

    const currentUrl = browser.page.url();
    if (currentUrl.match(/\/r\/[^/]+\/comments\//i)) {
      const canonical = currentUrl.replace(/\?.*$/, "");
      const match = canonical.match(/comments\/([a-z0-9]+)/i);
      return { success: true, url: canonical, postId: match?.[1] };
    }

    logger.warn({ subreddit, url: currentUrl }, "Poll submit: page did not navigate to new post");
    return { success: false };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
