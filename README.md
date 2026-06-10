# Reddit Automation Bot

A TypeScript + Playwright automation bot that:

1. Opens a persistent Chromium profile and logs into Reddit.
2. Browses target subreddits in a visible browser session.
3. Pulls recent text posts from Reddit JSON feeds.
4. Uses OpenAI to score relevance and draft human-sounding replies.
5. Either saves drafts only or posts comments with cooldowns, caps, and humanized timing.

The repo was rebuilt around Node + TypeScript because that stack is a better long-term fit for heavy browser automation than the earlier Python version.

## Goal

The project is designed for a narrow workflow:

- discover recent discussion posts in selected subreddits
- filter them structurally before any model call
- ask OpenAI whether the bot should engage
- generate a short, context-aware reply when the post is a good fit
- keep state in SQLite so the bot does not reprocess or double-comment
- operate conservatively with draft-only mode as the default

## Architecture

Runtime modules:

- [src/index.ts](/Users/etech/Desktop/zach-bot/src/index.ts): entrypoint
- [src/config.ts](/Users/etech/Desktop/zach-bot/src/config.ts): `.env` + YAML config loading and validation
- [src/reddit-browser.ts](/Users/etech/Desktop/zach-bot/src/reddit-browser.ts): persistent browser session, login, and human-like interaction (cursor, typing, dwell)
- [src/reddit-discovery.ts](/Users/etech/Desktop/zach-bot/src/reddit-discovery.ts): subreddit feed DOM scraping and post-body reading
- [src/openai-analyzer.ts](/Users/etech/Desktop/zach-bot/src/openai-analyzer.ts): relevance scoring and draft generation
- [src/comment-publisher.ts](/Users/etech/Desktop/zach-bot/src/comment-publisher.ts): browser comment submission
- [src/db.ts](/Users/etech/Desktop/zach-bot/src/db.ts): SQLite state for seen posts, drafts, and outcomes
- [src/policy.ts](/Users/etech/Desktop/zach-bot/src/policy.ts): pure decision logic (candidate filtering, posting gates, cooldowns)
- [src/site-scraper.ts](/Users/etech/Desktop/zach-bot/src/site-scraper.ts): crawls the product website and distills a product catalog
- [src/products.ts](/Users/etech/Desktop/zach-bot/src/products.ts): loads the catalog and resolves per-audience product context
- [src/workflow.ts](/Users/etech/Desktop/zach-bot/src/workflow.ts): end-to-end orchestration

The decision rules the bot lives by — which posts qualify, whether a comment is
allowed right now, when a subreddit is cooling down — are isolated in
`policy.ts` as pure functions with no I/O, so they are unit-tested directly.

## Why TypeScript

This version uses TypeScript instead of Python because:

- Playwright’s strongest ecosystem is in Node.
- Browser automation examples and fixes usually land in Node first.
- ESM/TypeScript works well for long-running automation services and richer orchestration.
- Shared types make config, state, and workflow changes safer as the bot grows.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Install the Playwright browser:

```bash
npm run install:browsers
```

3. Create your environment file:

```bash
cp .env.example .env
```

4. Fill in:

- `REDDIT_USERNAME`
- `REDDIT_PASSWORD`
- `OPENAI_API_KEY`

5. Build the product knowledge base from the client website:

```bash
npm run scrape
```

This crawls `site.baseUrl` (config.yaml), distills the products with OpenAI, and
writes `data/products.json`. Re-run it whenever the website changes.

## Product knowledge base & audience targeting

Comments are tailored per audience. `config.yaml` defines `audiences` — each maps
a set of subreddits to an audience label (estate planning, retirement planning,
caring for aging parents, parents of college students). `npm run scrape` builds a
catalog of the client's products, each tagged with its best-fit audience and a
set of **topical talking points**.

At runtime, when the bot reads a post, it looks up the audience for that
subreddit and feeds the matching product's talking points to the model as
*topical guidance only* — the comment may discuss the subject area (e.g. why an
18-year-old needs their own healthcare proxy) but **never names a brand/company
and never includes a URL**. That keeps it helpful and ban-resistant while still
steering toward the right product topic for the right audience.

## Marketing logic (conversion + self-protection)

Grounded in current Reddit-marketing best practice (value-first, the 9:1 rule,
build karma before promoting):

- **Buying-intent scoring** — every post gets an `intent` score (0–10) for how
  actively the author is seeking advice/recommendations. Drafts are ranked by
  `relevance + intentWeight × intent`, so high-intent threads (someone literally
  asking "what do you recommend?") get commented on first.
- **Quality gate** — the model self-rates each draft's value (`quality`, 0–10);
  drafts below `ai.minQuality` are dropped as filler. Protects karma and keeps
  the "value" contributions genuinely valuable.
- **Promotion follows maturity** — the active ramp stage sets the promotion
  level: young accounts stay `topical` (pure value, no brand); only mature,
  trusted stages use `soft_brand`. Per-audience `allowBrand` further blocks brand
  mentions in subreddits that forbid self-promotion.
- **Removal-detection feedback loop** — recently posted comments are re-checked
  each session (`recheck`); if Reddit is removing too many (rate ≥
  `removalRateThreshold` over `minSample`), the bot **auto-backs-off to
  draft-only** that run. Turns "comments getting removed" into an automatic brake.
- **Reporting** — `npm run report` prints the funnel (seen → analyzed → drafted →
  posted), removal rate, intent/relevance averages, per-subreddit breakdown, and
  account growth from the snapshots.

### Marketing work that lives outside this bot
To actually grow sales end-to-end, pair the bot with: SEO/content (repurpose the
bot's best answers into site articles), a UTM-tagged link in the account's
**profile bio** (never in comments) + a Reddit pixel/Conversions API on the site
for attribution (use a 60–90 day window), email capture + nurture, and optionally
Reddit Ads/PPC. These are off-repo and not automated here.

## Account-maturity ramp (safety + growth, automatic)

The bot scales its own activity to the account's maturity so a young account
stays safe and activity grows as the account does. Each run it reads the
logged-in account's **age and karma** and auto-selects the most advanced
`ramp` stage it qualifies for (both thresholds required):

| Stage | Needs (age / karma) | Posts/day | Behavior |
|---|---|---|---|
| warmup | 0d / 0 | 0 (draft-only) | mostly lurk + read, build presence |
| cautious | 21d / 100 | 1 | long gaps |
| steady | 45d / 500 | 2 | |
| active | 90d / 2000 | 3 | |
| established | 180d / 5000 | 4 | |

You set the stages once in `config.yaml`; from then on the decision is automatic
every run, and each decision is logged and snapshotted to the DB
(`account_snapshots`) so growth is auditable. A brand-new account therefore
**only drafts and lurks** until it has earned enough age + karma — no posting,
no risk. The ramp is authoritative for safety: `--live` cannot exceed the stage,
and if account stats can't be read the bot falls back to draft-only. Set
`ramp.enabled: false` to bypass it (e.g. a one-off supervised live test).

## 24/7 operation (recommended)

For continuous, human-like operation, run the bot as a long-lived daemon:

```bash
npm run dev -- --loop --live
```

`--loop` keeps one process alive and starts sessions at **randomized** intervals
(see the `daemon` config) — nothing happens on a fixed schedule, which is what
keeps the activity pattern looking human. Each session is a full lurk → discover
→ read → maybe-comment cycle, and the internal gates (active hours, daily cap,
min/max gap, per-subreddit cooldown, random skips) keep volume safe. Occasional
longer "offline" breaks are mixed in. It shuts down cleanly on Ctrl-C / SIGTERM.

To keep it running across reboots/crashes on macOS, use the KeepAlive launchd job
(edit the paths first, `npm run build` once, then load it):

```bash
cp deploy/com.planningforms.redditbot.daemon.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.planningforms.redditbot.daemon.plist
```

### Alternative: scheduled single runs

If you prefer discrete runs instead of a daemon, the templates in `deploy/`
(`com.planningforms.redditbot.plist` for launchd, `crontab.example` for cron)
call `deploy/run-daily.sh` (`npm run dev -- --live`) at set times. Use the daemon
**or** the scheduled job, not both.

## Logging

Everything is logged for later debugging. Each run writes a full debug-level
log to `logs/bot-YYYY-MM-DD.log` (the console stays at `LOG_LEVEL`). Discovery
counts, every scored post (relevance, audience, whether it drafted/researched),
skips with reasons, posting decisions, and daemon session timing are all
recorded. Secrets (API keys, passwords) are redacted.

## Live web search & promotion level

- `ai.promotionLevel` (`off` | `topical` | `soft_brand`) controls how
  product-forward comments are. `topical` (default) steers toward the subject
  area with no brand/URL; `soft_brand` may occasionally name `site.brandName`,
  still never a URL. URLs are always stripped — they are the fastest path to a ban.
- `ai.liveSearch: true` makes the bot run a live web search on each post's topic
  before drafting (via `ai.searchModel`), grounding replies in current facts.
  Off by default (it adds an API call per post).

## Safe First Run

The default config is safe:

- `posting.enabled: false`
- `browser.headless: false`

That means the bot will log in, discover posts, analyze them, and save drafts, but it will not post comments.

Run it with:

```bash
npm run dev
```

You can override `posting.enabled` per run without editing the config:

```bash
npm run dev -- --dry-run   # force draft-only, never posts
npm run dev -- --live      # force live posting on
npm run dev -- --help      # show options
```

On the first run:

- a Chromium window opens
- Reddit login loads
- if a captcha appears, solve it manually
- the browser profile is saved under `data/browser-profile`

## Going Live

Only enable live posting after you have reviewed drafts and the account has real history.

Change [config.yaml](/Users/etech/Desktop/zach-bot/config.yaml):

```yaml
posting:
  enabled: true
  dailyCap: 1
  minGapMinutes: 180
  maxGapMinutes: 360
```

The live workflow then becomes:

1. log in using the saved browser profile
2. lurk in a few unrelated subreddits
3. discover recent candidate posts
4. score and draft with OpenAI
5. pick top drafts
6. post comments through Reddit UI automation
7. wait randomized cooldown periods between comments

## Configuration

Main knobs in [config.yaml](/Users/etech/Desktop/zach-bot/config.yaml):

- `audiences`: subreddit → audience groups used for product-tailored comments
- `site`: product website to scrape (`baseUrl`, `maxPages`, `catalogPath`)
- `subreddits`: fallback flat list, used only if `audiences` is empty
- `discovery.keywords`: optional topic filter
- `ai.minRelevanceScore`: stricter or looser model threshold
- `posting.enabled`: draft-only vs live posting
- `posting.dailyCap`: daily posting ceiling
- `humanize.*`: lurk, skip, upvote, and timing behavior
- `browser.headless`: whether the browser is visible

## Development

```bash
npm run check   # typecheck (tsc --noEmit)
npm test        # run the Vitest unit suite
npm run build   # compile to dist/
npm run scrape  # rebuild the product catalog from the website
```

Unit tests cover the pure decision logic in `policy.ts` (candidate filtering,
posting gates, active-hours and cooldown windows) and the draft validation in
`openai-analyzer.ts` (relevance threshold, length clamping, URL/AI-tell safety
filter). No network or browser is required to run them.

## Acting like a human (anti-detection)

The bot is built to look like a real person browsing, not a script:

- **Patched engine** — runs on `rebrowser-playwright`, which closes the CDP
  `Runtime.enable` leak that vanilla automation exposes regardless of the
  `navigator.webdriver` patch.
- **Real Chrome** — launches your installed Google Chrome (`browser.channel: chrome`)
  for an authentic fingerprint, falling back to bundled Chromium if absent. The
  user agent is the browser's own, so there is no UA/platform mismatch.
- **Human input** — the cursor moves to targets along eased cubic-bezier paths
  before clicking, typing has variable speed with occasional typos that get
  backspaced and corrected, and reading dwell scales with the length of the post.
- **Feed-native discovery** — posts are read from the rendered feed DOM
  (`shreddit-post` elements) the way a person scrolling would see them, instead
  of hitting Reddit's `.json` endpoints (which a logged-in session never does).
- **Conservative cadence** — randomized timing, lurking in unrelated subreddits,
  active-hours windows, per-subreddit cooldowns, daily caps, and random skips.

### Session persistence

Login state is saved automatically. The browser runs against a persistent
Chrome profile at `data/browser-profile`, so cookies and the logged-in session
survive between runs — the bot only falls back to the `REDDIT_USERNAME` /
`REDDIT_PASSWORD` credentials when no valid session exists. You typically log in
(and solve any captcha) once.

### Proxy (optional)

Set `PROXY_SERVER` (and optionally `PROXY_USERNAME` / `PROXY_PASSWORD`) in `.env`
to route the browser through a residential proxy — the single biggest factor for
account longevity. Left unset, the bot uses the local connection.

## Notes

- SQLite state lives at `data/state.db`.
- Browser cookies and login state live at `data/browser-profile`.
- This bot intentionally does not inject product links or promotional URLs.
- New Reddit UI changes can break selectors, so the posting layer is written to prefer old Reddit when configured.
