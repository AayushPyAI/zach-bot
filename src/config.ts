import fs from "node:fs";
import path from "node:path";

import dotenv from "dotenv";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

dotenv.config();

const projectRoot = process.cwd();

const discoverySchema = z.object({
  sortRotation: z.array(z.enum(["new", "hot", "rising"])).default(["new", "hot", "rising"]),
  shuffleSubreddits: z.boolean().default(true),
  postsPerSubreddit: z.number().int().min(1).max(100).default(15),
  maxAgeHours: z.number().int().min(1).default(12),
  minAgeMinutes: z.number().int().min(0).default(15),
  minBodyChars: z.number().int().min(0).default(120),
  keywords: z.array(z.string().min(1)).default([]),
});

const aiSchema = z.object({
  model: z.string().default(process.env.OPENAI_MODEL ?? "gpt-4.1-mini"),
  minRelevanceScore: z.number().int().min(0).max(10).default(8),
  minCommentChars: z.number().int().min(40).default(90),
  maxCommentChars: z.number().int().min(80).default(320),
  // Reject drafts the model self-rates below this (0-10) as low-value/filler.
  minQuality: z.number().int().min(0).max(10).default(6),
  // Weight applied to buying-intent when ranking which drafts to post first.
  intentWeight: z.number().min(0).default(1),
  persona: z.string().min(1),
  // How product-forward comments may be:
  //  off        — pure help, no product steering at all
  //  topical    — steer toward the product's subject area, never a brand/URL
  //  soft_brand — topical, and may occasionally name the brand (still no URL)
  promotionLevel: z.enum(["off", "topical", "soft_brand"]).default("topical"),
  // Use a research model with live web search to ground comments in current facts.
  liveSearch: z.boolean().default(false),
  searchModel: z.string().default("gpt-4o-search-preview"),
});

const postingSchema = z.object({
  enabled: z.boolean().default(false),
  dailyCap: z.number().int().min(0).default(1),
  minGapMinutes: z.number().int().min(0).default(180),
  maxGapMinutes: z.number().int().min(0).default(360),
  jitterMinutes: z.number().int().min(0).default(45),
  useOldReddit: z.boolean().default(true),
  fallbackToOldReddit: z.boolean().default(true),
  typingCharsPerSecondMin: z.number().positive().default(3),
  typingCharsPerSecondMax: z.number().positive().default(6),
});

const humanizeSchema = z.object({
  enabled: z.boolean().default(true),
  lurkProbability: z.number().min(0).max(1).default(0.6),
  lurkSubreddits: z.array(z.string().min(1)).default(["news", "todayilearned", "AskReddit"]),
  lurkMin: z.number().int().min(1).default(1),
  lurkMax: z.number().int().min(1).default(2),
  upvoteProbability: z.number().min(0).max(1).default(0.35),
  skipGoodPostProbability: z.number().min(0).max(1).default(0.15),
  skipRunProbability: z.number().min(0).max(1).default(0.1),
  activeHours: z.tuple([z.number().int().min(0).max(23), z.number().int().min(0).max(23)]).default([8, 23]),
  perSubredditCooldownMinutes: z.number().int().min(0).default(360),
});

const browserSchema = z.object({
  headless: z.boolean().default(false),
  userDataDir: z.string().default("data/browser-profile"),
  // Leave userAgent empty to inherit the real browser's authentic UA. Only set
  // this if you know it matches the channel/platform exactly — a mismatch
  // (e.g. a Windows UA on macOS) is itself a bot signal.
  userAgent: z.string().optional(),
  // Real installed browser to drive. "chrome" uses Google Chrome for an
  // authentic fingerprint; "" falls back to Playwright's bundled Chromium.
  channel: z.string().default("chrome"),
  locale: z.string().default("en-US"),
  timezoneId: z.string().default("America/New_York"),
});

const runtimeSchema = z.object({
  databasePath: z.string().default("data/state.db"),
  maxAnalyzePerRun: z.number().int().min(1).default(25),
});

// Self-protection: re-check recently posted comments and back off if Reddit is
// removing them (a sign the account is too new/low-karma or tripping a filter).
const recheckSchema = z.object({
  enabled: z.boolean().default(true),
  maxPerRun: z.number().int().min(0).default(5),
  withinDays: z.number().int().min(1).default(7),
  // If at least `minSample` recent comments have been checked and the removal
  // rate is at/above this fraction, force draft-only this run.
  removalRateThreshold: z.number().min(0).max(1).default(0.34),
  minSample: z.number().int().min(1).default(3),
});

const siteSchema = z.object({
  baseUrl: z.string().url(),
  maxPages: z.number().int().min(1).max(200).default(40),
  catalogPath: z.string().default("data/products.json"),
  // Brand name, used only when ai.promotionLevel is "soft_brand".
  brandName: z.string().optional(),
});

// Account-maturity ramp: the bot reads the account's age + karma each run and
// picks the most-advanced stage it qualifies for, automatically scaling activity
// up as the account grows. A brand-new account stays in draft-only "warmup".
const rampStageSchema = z.object({
  name: z.string().min(1),
  minAccountDays: z.number().min(0).default(0),
  minKarma: z.number().min(0).default(0),
  posting: z.boolean().default(false),
  dailyCap: z.number().int().min(0).default(0),
  minGapMinutes: z.number().int().min(0).default(240),
  maxGapMinutes: z.number().int().min(0).default(420),
  lurkProbability: z.number().min(0).max(1).default(0.7),
  upvoteProbability: z.number().min(0).max(1).default(0.3),
  // Promotion stance for this maturity stage. Young stages stay "topical"
  // (pure value, no brand); mature, trusted stages may use "soft_brand".
  promotionLevel: z.enum(["off", "topical", "soft_brand"]).default("topical"),
});

export type RampStage = z.infer<typeof rampStageSchema>;

// Conservative defaults. Thresholds are AND-ed (need both age and karma).
const DEFAULT_RAMP_STAGES: RampStage[] = [
  { name: "warmup", minAccountDays: 0, minKarma: 0, posting: false, dailyCap: 0, minGapMinutes: 360, maxGapMinutes: 600, lurkProbability: 0.85, upvoteProbability: 0.45, promotionLevel: "topical" },
  { name: "cautious", minAccountDays: 21, minKarma: 100, posting: true, dailyCap: 1, minGapMinutes: 300, maxGapMinutes: 540, lurkProbability: 0.75, upvoteProbability: 0.4, promotionLevel: "topical" },
  { name: "steady", minAccountDays: 45, minKarma: 500, posting: true, dailyCap: 2, minGapMinutes: 240, maxGapMinutes: 420, lurkProbability: 0.6, upvoteProbability: 0.35, promotionLevel: "topical" },
  { name: "active", minAccountDays: 90, minKarma: 2000, posting: true, dailyCap: 3, minGapMinutes: 180, maxGapMinutes: 360, lurkProbability: 0.5, upvoteProbability: 0.3, promotionLevel: "soft_brand" },
  { name: "established", minAccountDays: 180, minKarma: 5000, posting: true, dailyCap: 4, minGapMinutes: 150, maxGapMinutes: 300, lurkProbability: 0.4, upvoteProbability: 0.25, promotionLevel: "soft_brand" },
];

const rampSchema = z.object({
  enabled: z.boolean().default(true),
  stages: z.array(rampStageSchema).min(1).default(DEFAULT_RAMP_STAGES),
});

// 24/7 randomized operation: keep one long-running process alive and start
// human-like sessions at randomized intervals, with occasional longer breaks.
const daemonSchema = z.object({
  sessionGapMinMinutes: z.number().int().min(1).default(40),
  sessionGapMaxMinutes: z.number().int().min(1).default(210),
  longBreakProbability: z.number().min(0).max(1).default(0.15),
  longBreakMinHours: z.number().min(0).default(3),
  longBreakMaxHours: z.number().min(0).default(9),
});

const audienceSchema = z.object({
  label: z.string().min(1),
  subreddits: z.array(z.string().min(1)).min(1),
  keywords: z.array(z.string().min(1)).default([]),
  // Optional explicit catalog product name; if omitted, products are matched to
  // this group by their `audience` field.
  product: z.string().optional(),
  // Whether brand mentions are allowed here (e.g. subs that ban self-promo →
  // false). Only matters at promotionLevel "soft_brand"; otherwise topical.
  allowBrand: z.boolean().default(true),
});

export type AudienceGroup = z.infer<typeof audienceSchema>;

const configSchema = z.object({
  subreddits: z.array(z.string().min(1)).min(1),
  audiences: z.array(audienceSchema).default([]),
  site: siteSchema.optional(),
  discovery: discoverySchema,
  ai: aiSchema,
  posting: postingSchema,
  humanize: humanizeSchema,
  browser: browserSchema,
  runtime: runtimeSchema,
  recheck: recheckSchema.default({}),
  daemon: daemonSchema.default({}),
  ramp: rampSchema.default({}),
});

export interface ProxyConfig {
  server: string;
  username?: string;
  password?: string;
}

export type AppConfig = z.infer<typeof configSchema> & {
  openAiApiKey: string;
  redditUsername: string;
  redditPassword: string;
  proxy: ProxyConfig | null;
  projectRoot: string;
  configPath: string;
};

export function loadConfig(configPath = path.join(projectRoot, "config.yaml")): AppConfig {
  const rawText = fs.readFileSync(configPath, "utf8");
  const rawConfig = parseYaml(rawText) ?? {};
  const parsed = configSchema.parse(rawConfig);

  const openAiApiKey = mustEnv("OPENAI_API_KEY");
  const redditUsername = mustEnv("REDDIT_USERNAME");
  const redditPassword = mustEnv("REDDIT_PASSWORD");

  return {
    ...parsed,
    openAiApiKey,
    redditUsername,
    redditPassword,
    proxy: loadProxy(),
    projectRoot,
    configPath,
  };
}

/**
 * Optional residential proxy from the environment. Off unless PROXY_SERVER is
 * set, so the bot runs on the local connection by default. Credentials live in
 * .env, never in config.yaml.
 */
function loadProxy(): ProxyConfig | null {
  const server = process.env.PROXY_SERVER?.trim();
  if (!server) {
    return null;
  }
  const username = process.env.PROXY_USERNAME?.trim();
  const password = process.env.PROXY_PASSWORD?.trim();
  return {
    server,
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
  };
}

function mustEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
